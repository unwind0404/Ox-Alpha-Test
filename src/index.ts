// Worker entrypoint.
// export default {
//   fetch,    // admin API + static UI (требует Cloudflare Access)
//   scheduled // cron trigger (no auth, internal only)
// }

import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types'
import { requireAccess, securityHeaders, AccessError, type AccessEnv } from './adapters/cloudflare/access-auth.js'
import { D1ShopRepository } from './adapters/cloudflare/d1-shop-repository.js'
import { D1ReviewRepository } from './adapters/cloudflare/d1-review-repository.js'
import { D1JobRepository } from './adapters/cloudflare/d1-job-repository.js'
import { D1AuditRepository } from "./adapters/cloudflare/d1-audit-repository.js"
import { encryptToken, fingerprintToken } from "./adapters/cloudflare/token-crypto.js"
import { deriveReviewStatus, type DeriveInput } from './core/review-status.js'
import { tick } from './coordinator/shop-coordinator.js'

export { D1ShopRepository, D1ReviewRepository, D1JobRepository, D1AuditRepository }

export interface Env extends AccessEnv {
  DB: D1Database
  DEPLOYMENT_MODE: 'cloud' | 'self_managed'
  DEFAULT_STRATEGY: 'templates' | 'drafts' | 'llm'
  WB_API_BASE: string
  OPENROUTER_API_KEY: string
  MASTER_KEY: string
  FINGERPRINT_KEY: string
  /** Static assets binding (configured in wrangler.toml). */
  ASSETS?: Fetcher
}

/** Healthcheck endpoint, без auth. */
function handleHealth(): Response {
  return new Response(
    JSON.stringify({ ok: true, ts: Date.now() }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...securityHeaders() } },
  )
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...securityHeaders() },
  })
}

function errorResponse(status: number, message: string): Response {
  return jsonResponse({ error: message }, status)
}

/** Получить список магазинов для UI. */
async function handleListShops(env: Env): Promise<Response> {
  const repo = new D1ShopRepository(env.DB)
  const shops = await repo.listEnabled()
  const result = shops.map((s) => ({
    id: s.id,
    name: s.name,
    mode: s.mode,
    enabled: s.enabled,
    tokenProfile: s.tokenProfile,
    lastSyncDayUtc: s.lastSyncDayUtc,
  }))
  return jsonResponse({ shops: result })
}

/** Добавить магазин с зашифрованным WB-токеном. */
async function handleAddShop(env: Env, request: Request): Promise<Response> {
  if (request.method !== 'POST') return errorResponse(405, 'POST only')
  const body = await request.json().catch(() => ({})) as {
    wbAccountKey?: string
    name?: string
    mode?: 'templates' | 'drafts' | 'llm'
    token?: string
    enabled?: boolean
  }
  const wbAccountKey = (body.wbAccountKey ?? '').trim()
  const name = (body.name ?? '').trim() || 'My Shop'
  const mode = body.mode ?? 'drafts'
  const token = (body.token ?? '').trim()
  const enabled = body.enabled ?? false

  if (!wbAccountKey) return errorResponse(400, 'wbAccountKey required')
  if (!token) return errorResponse(400, 'token required')
  if (!['templates', 'drafts', 'llm'].includes(mode)) return errorResponse(400, 'mode: templates | drafts | llm')
  if (token.length < 10) return errorResponse(400, 'token too short')

  let enc
  try {
    const fp = await fingerprintToken(token, { MASTER_KEY: env.MASTER_KEY, FINGERPRINT_KEY: env.FINGERPRINT_KEY })
    enc = { ...(await encryptToken(token, { MASTER_KEY: env.MASTER_KEY, FINGERPRINT_KEY: env.FINGERPRINT_KEY })), fingerprint: fp }
  } catch (e) {
    return errorResponse(500, 'encrypt: ' + (e as Error).message)
  }

  const shopId = crypto.randomUUID()
  const now = Date.now()

  const existing = await env.DB
    .prepare('SELECT id FROM shops WHERE wb_account_key = ?1')
    .bind(wbAccountKey)
    .first<{ id: string }>()
  if (existing) return errorResponse(409, 'shop with wb_account_key=' + wbAccountKey + ' already exists: ' + existing.id)

  await env.DB
    .prepare("INSERT INTO shops (id, name, wb_account_key, token_ciphertext, token_iv, token_key_version, token_fingerprint, token_profile, deployment_mode, mode, enabled, last_sync_day_utc, next_sync_at, token_expires_at, disabled_reason, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, 'basic', 'cloud', ?, ?, NULL, ?, NULL, ?, ?, ?)")
    .bind(
      shopId, name, wbAccountKey,
      enc.ciphertext, enc.iv, enc.keyVersion, enc.fingerprint,
      mode, enabled ? 1 : 0,
      now,
      now, now,
    )
    .run()

  return jsonResponse({
    ok: true,
    shop: {
      id: shopId,
      name,
      wbAccountKey,
      mode,
      enabled,
      tokenFingerprintPrefix: enc.fingerprint.slice(0, 16) + '...',
    },
  }, 201)
}

/** Получить список отзывов для UI (с derived status). */
async function handleListReviews(env: Env, url: URL): Promise<Response> {
  const shopId = url.searchParams.get('shop_id')
  const statusFilter = url.searchParams.get('status')

  const jobRepo = new D1JobRepository(env.DB)
  const reviewRepo = new D1ReviewRepository(env.DB)
  const shopRepo = new D1ShopRepository(env.DB)

  const shopIdNum = shopId ? Number(shopId) : null
  if (!shopIdNum) {
    return jsonResponse({ reviews: [], metrics: emptyMetrics() })
  }

  const all = await jobRepo.listByShopForQueue(String(shopIdNum), 500)
  const reviews = all.slice(0, 100)
  const reviewsWithStatus = []
  for (const job of reviews) {
    if (statusFilter && job.state !== statusFilter) continue
    const review = await reviewRepo.getById(job.reviewId)
    if (!review) continue
    const shop = await shopRepo.getById(String(shopIdNum))
    const statusInput: DeriveInput = {
      state: job.state,
      hasShopPaused: !shop?.enabled,
      oldestReadyAgeMs: null,
      scheduledSendAtMs: job.scheduledSendAtMs,
      queuePosition: job.queuePosition,
      queueSize: reviews.length,
      effectiveAtMs: job.statusUpdatedAtMs,
    }
    const view = deriveReviewStatus(statusInput)
    reviewsWithStatus.push({
      id: job.id,
      shopId: job.shopId,
      shopName: shop?.name ?? '?',
      wbFeedbackId: review.wbFeedbackId,
      rating: review.rating,
      userName: review.userName,
      productName: review.productName,
      text: review.text,
      pros: review.pros,
      cons: review.cons,
      status: view.code,
      statusLabel: view.label,
      statusTone: view.tone,
      queuePosition: job.queuePosition,
      scheduledSendAtMs: job.scheduledSendAtMs,
      postedReplyText: job.postedReplyText,
      receivedAtMs: review.receivedAtMs,
    })
  }

  return jsonResponse({ reviews: reviewsWithStatus, metrics: emptyMetrics() })
}

function emptyMetrics() {
  return {
    fetched: 0, queued: 0, drafted: 0, ready: 0, posted: 0,
    manual: 0, rate_limited: 0, failed: 0, oldestAgeMs: null, nextSlotMs: null,
  }
}

/** Audit log для UI. */
async function handleListAudit(env: Env, url: URL): Promise<Response> {
  const repo = new D1AuditRepository(env.DB)
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 200), 1000)
  const shopId = url.searchParams.get('shop_id')
  const events = await repo.listRecent(shopId, limit)
  return jsonResponse({
    events: events.map((e) => ({
      id: e.id,
      shopId: e.shopId,
      jobId: e.jobId,
      action: e.action,
      reasonCode: e.reasonCode,
      detail: e.detail,
      createdAtMs: e.createdAtMs,
    })),
  })
}

/** Approve draft (draft_ready → ready_to_send) через CAS. */
async function handleApproveReview(env: Env, jobId: string, request: Request): Promise<Response> {
  if (request.method !== 'POST') return errorResponse(405, 'POST only')
  const body = await request.json().catch(() => ({})) as { text?: string }
  const text = body.text ?? ''
  const jobRepo = new D1JobRepository(env.DB)
  const auditRepo = new D1AuditRepository(env.DB)
  const updated = await jobRepo.transition(jobId, 'draft_ready', 'ready_to_send', {
    postedReplyText: text,
    nextAttemptAtMs: Date.now(),
    statusUpdatedAtMs: Date.now(),
  })
  if (!updated) {
    return errorResponse(409, 'CAS failed (not in draft_ready state)')
  }
  await auditRepo.insert({
    shopId: updated.shopId, jobId, action: 'admin.approve',
    reasonCode: null,
    detail: 'manual approve',
    correlationId: `appr-${Date.now()}-${jobId}`,
  })
  return jsonResponse({ ok: true, job: updated })
}

/** Regenerate draft (draft_ready → generating). */
async function handleRegenerateReview(env: Env, jobId: string): Promise<Response> {
  const jobRepo = new D1JobRepository(env.DB)
  const auditRepo = new D1AuditRepository(env.DB)
  const updated = await jobRepo.transition(jobId, 'draft_ready', 'generating', {
    statusUpdatedAtMs: Date.now(),
  })
  if (!updated) return errorResponse(409, 'CAS failed (not in draft_ready state)')
  await auditRepo.insert({
    shopId: updated.shopId, jobId, action: 'admin.regenerate',
    reasonCode: null,
    detail: 'manual regenerate',
    correlationId: `regen-${Date.now()}-${jobId}`,
  })
  return jsonResponse({ ok: true, job: updated })
}

/** Serve static assets via ASSETS binding. */
async function handleStatic(request: Request, env: Env): Promise<Response> {
  if (!env.ASSETS) {
    // В dev/test ASSETS может не быть — возвращаем 404, чтобы тесты не падали.
    return new Response('Not Found (ASSETS not configured)', { status: 404, headers: securityHeaders() })
  }
  const res = await env.ASSETS.fetch(request)
  // Wrap response with security headers
  const newHeaders = new Headers(res.headers)
  for (const [k, v] of Object.entries(securityHeaders())) {
    newHeaders.set(k, v)
  }
  return new Response(res.body, { status: res.status, headers: newHeaders })
}

/** Главный fetch handler. */
export async function fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url)

  // Healthcheck — без auth
  if (url.pathname === '/health' && request.method === 'GET') {
    return handleHealth()
  }

  // Static assets (UI) — без auth (за Cloudflare Access на уровне домена)
  if (request.method === 'GET' && !url.pathname.startsWith('/api/')) {
    return handleStatic(request, env)
  }

  // API — требует Cloudflare Access
  try {
    const identity = requireAccess(request, env, ctx)
    console.log(`[admin] ${request.method} ${url.pathname} by ${identity.kind}:${identity.clientId}`)

    // Маршруты
    if (url.pathname === '/api/admin/status' && request.method === 'GET') {
      return jsonResponse({ ok: true, identity, deployment: env.DEPLOYMENT_MODE })
    }
    if (url.pathname === '/api/admin/shops' && request.method === 'GET') {
      return handleListShops(env)
    }
    if (url.pathname === '/api/admin/shops' && request.method === 'POST') {
      return handleAddShop(env, request)
    }
    if (url.pathname === '/api/admin/reviews' && request.method === 'GET') {
      return handleListReviews(env, url)
    }
    if (url.pathname === '/api/admin/audit' && request.method === 'GET') {
      return handleListAudit(env, url)
    }

    // /api/admin/reviews/{id}/approve и /regenerate
    const approveMatch = url.pathname.match(/^\/api\/admin\/reviews\/([^/]+)\/approve$/)
    if (approveMatch && request.method === 'POST') {
      return handleApproveReview(env, approveMatch[1]!, request)
    }
    const regenMatch = url.pathname.match(/^\/api\/admin\/reviews\/([^/]+)\/regenerate$/)
    if (regenMatch && request.method === 'POST') {
      return handleRegenerateReview(env, regenMatch[1]!)
    }

    // /api/admin/kick — ручной tick (для тестов)
    if (url.pathname === '/api/admin/kick' && request.method === 'POST') {
      const body = await request.json().catch(() => ({})) as { shopId?: string }
      if (!body.shopId) return errorResponse(400, 'shopId required')
      const r = await tick({ ...env }, body.shopId, Date.now())
      return jsonResponse({ ok: true, result: r })
    }

    return errorResponse(404, 'Not Found')
  } catch (e) {
    if (e instanceof AccessError) {
      return errorResponse(e.status, e.message)
    }
    throw e
  }
}

/** Cron trigger — каждый день в 07:00 UTC. */
export async function scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  console.log(`[scheduled] cron tick at ${new Date().toISOString()}, cron=${event.cron}`)
  ctx.waitUntil(runDailySync(env))
}

async function runDailySync(env: Env): Promise<void> {
  console.log(`[scheduled] would sync, deployment=${env.DEPLOYMENT_MODE}`)
  // TODO: coordinator.tick() для каждого активного магазина
}

/** Module worker default export (для DO поддержки). */
export default {
  fetch,
  scheduled,
}

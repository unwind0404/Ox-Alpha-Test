// ShopCoordinator: pure tick function, вызываемая из DO (Durable Object).
// Один tick = одна WB-операция (sync, reply, или nothing).
// Никаких долгих sleep — DO ставит alarm на следующий слот.

import type { Env } from '../index.js'
import type { ReplyStrategy } from '../core/types.js'
import type { RateState } from '../core/rate-policy.js'
import { selectNextWbOperation, type WbOperation } from '../core/operation-selector.js'
import { decryptToken } from '../adapters/cloudflare/token-crypto.js'
import { D1ShopRepository } from '../adapters/cloudflare/d1-shop-repository.js'
import { D1ReviewRepository } from '../adapters/cloudflare/d1-review-repository.js'
import { D1JobRepository } from '../adapters/cloudflare/d1-job-repository.js'
import { D1AuditRepository } from '../adapters/cloudflare/d1-audit-repository.js'
import { WbClient } from '../adapters/wb/wb-client.js'
import { syncUnanswered, type SyncResult } from './sync-reviews.js'

/** Контекст: общий Env + D1 binding. */
export interface CoordinatorEnv extends Env {
  DB: D1Database
}

/** Результат tick. */
export interface TickResult {
  shop: { id: string; mode: ReplyStrategy; enabled: boolean }
  op: WbOperation
  detail: string
}

/** Build RateState для rate-policy. */
async function buildRateState(
  shop: { id: string; mode: ReplyStrategy; enabled: boolean },
  jobRepo: D1JobRepository,
  audit: D1AuditRepository,
  nowMs: number,
): Promise<RateState> {
  // Считаем успешные reply за последние 24ч
  const recent = await jobRepo.listActiveByShop(shop.id, 1000)
  const dayAgo = nowMs - 24 * 60 * 60 * 1000
  const rollingDaySuccessCount = recent.filter(
    (j) => j.state === 'posted' && (j.postedAtMs ?? 0) >= dayAgo,
  ).length

  // Берём lastWbRequestAtMs из audit (последний wb.request)
  const audits = await audit.listRecent(shop.id, 50)
  const wbRequest = audits.find((a) => a.action === 'wb.request')
  const lastWbRequestAtMs = wbRequest ? wbRequest.createdAtMs : null

  // cooldown из последнего 429 audit
  const last429 = audits.find((a) => a.action === 'wb.429')
  let cooldownUntilMs = 0
  if (last429) {
    const elapsed = nowMs - last429.createdAtMs
    const m = /retryAfterSec":(\d+)/.exec(last429.detail ?? '')
    const retryAfter = m ? Number(m[1]) * 1000 : 900_000
    cooldownUntilMs = elapsed >= retryAfter ? 0 : last429.createdAtMs + retryAfter
  }

  return {
    lastWbRequestAtMs,
    cooldownUntilMs,
    rollingDaySuccessCount,
  }
}

/** Получить next-attempt-at для oldest ready job. */
async function getOldestReady(
  shop: { id: string },
  jobRepo: D1JobRepository,
): Promise<{ id: string; nextAttemptAtMs: number } | null> {
  const ready = await jobRepo.listReadyToSend(shop.id, Number.MAX_SAFE_INTEGER, 1)
  if (ready.length === 0) return null
  return { id: ready[0]!.id, nextAttemptAtMs: ready[0]!.nextAttemptAtMs }
}

/** Один tick. Возвращает результат операции + ставит alarm на следующий. */
export async function tick(env: CoordinatorEnv, shopId: string, nowMs: number): Promise<TickResult> {
  const shopRepo = new D1ShopRepository(env.DB)
  const reviewRepo = new D1ReviewRepository(env.DB)
  const jobRepo = new D1JobRepository(env.DB)
  const auditRepo = new D1AuditRepository(env.DB)

  const shop = await shopRepo.getById(shopId)
  if (!shop) {
    return { shop: { id: shopId, mode: 'drafts', enabled: false }, op: { kind: 'none' }, detail: 'shop not found' }
  }
  if (!shop.enabled) {
    return { shop, op: { kind: 'none' }, detail: 'shop disabled' }
  }

  const todayUtc = new Date(nowMs).toISOString().slice(0, 10)
  const rateState = await buildRateState(shop, jobRepo, auditRepo, nowMs)
  const oldestReady = await getOldestReady(shop, jobRepo)

  const op = selectNextWbOperation({
    nowMs,
    profile: shop.tokenProfile,
    rateState,
    todayUtc,
    lastSyncDayUtc: shop.lastSyncDayUtc,
    hasReconcileJobs: false,
    oldestReadyJob: oldestReady,
    hasMorePages: false,
    currentSkip: 0,
  })

  let detail = 'noop'

  switch (op.kind) {
    case 'daily_sync': {
      const token = await decryptTokenInShop(env, shop.id)
      if (!token) {
        detail = 'sync: cannot decrypt token'
        break
      }
      const wb = new WbClient({ token })
      const r = await syncUnanswered(shop.id, wb, reviewRepo, jobRepo, shop.mode, nowMs)
      if (r.ok) {
        await shopRepo.setLastSyncDay(shop.id, todayUtc)
        const sr: SyncResult = r.data
        detail = `sync: ${sr.newCount} new, ${sr.duplicateCount} dup, ${sr.jobsCreated} jobs`
      } else {
        detail = `sync: error ${r.error.kind}`
      }
      break
    }
    case 'reply': {
      // Публикация (Task 9) — stub
      detail = 'reply: not yet implemented (Task 9)'
      break
    }
    default:
      detail = `op ${op.kind}: noop`
  }

  await auditRepo.insert({
    shopId: shop.id,
    jobId: null,
    action: 'coordinator.tick',
    reasonCode: null,
    detail: `${op.kind}: ${detail}`,
    correlationId: `tick-${nowMs}-${shop.id}`,
  })

  return { shop, op, detail }
}

/** Decrypt token из БД (нужен для WBClient). */
async function decryptTokenInShop(env: CoordinatorEnv, shopId: string): Promise<string | null> {
  const row = await env.DB
    .prepare('SELECT token_ciphertext, token_iv, token_key_version FROM shops WHERE id = ?1')
    .bind(shopId)
    .first<{ token_ciphertext: string; token_iv: string; token_key_version: number }>()
  if (!row) return null
  try {
    return await decryptToken(
      row.token_ciphertext,
      row.token_iv,
      row.token_key_version,
      { MASTER_KEY: env.MASTER_KEY, FINGERPRINT_KEY: env.FINGERPRINT_KEY },
    )
  } catch {
    return null
  }
}

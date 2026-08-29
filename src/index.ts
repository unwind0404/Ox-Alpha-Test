// Worker entrypoint.
// export default {
//   fetch,    // admin API (требует Cloudflare Access)
//   scheduled // cron trigger (no auth, internal only)
// }

import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types'
import { requireAccess, securityHeaders, AccessError, type AccessEnv } from './adapters/cloudflare/access-auth.js'
import { D1ShopRepository } from './adapters/cloudflare/d1-shop-repository.js'
import { D1ReviewRepository } from './adapters/cloudflare/d1-review-repository.js'
import { D1JobRepository } from './adapters/cloudflare/d1-job-repository.js'

export { D1ShopRepository, D1ReviewRepository, D1JobRepository }

// Полный env-binding от wrangler.toml
export interface Env extends AccessEnv {
  DB: D1Database
  DEPLOYMENT_MODE: 'cloud' | 'self_managed'
  DEFAULT_STRATEGY: 'templates' | 'drafts' | 'llm'
  WB_API_BASE: string
  OPENROUTER_API_KEY: string
  MASTER_KEY: string
  FINGERPRINT_KEY: string
}

/** Healthcheck endpoint, без auth. */
function handleHealth(): Response {
  return new Response(
    JSON.stringify({ ok: true, ts: Date.now() }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...securityHeaders() } },
  )
}

/** Default 404 для всего неизвестного. */
function handleNotFound(): Response {
  return new Response('Not Found', { status: 404, headers: securityHeaders() })
}

/** Главный fetch handler. */
export async function fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url)

  // Healthcheck — без auth
  if (url.pathname === '/health' && request.method === 'GET') {
    return handleHealth()
  }

  // Все остальные пути требуют Cloudflare Access Service Token
  try {
    const identity = requireAccess(request, env, ctx)
    console.log(`[admin] ${request.method} ${url.pathname} by ${identity.kind}:${identity.clientId}`)

    // Маршруты (пока минимальные — Task 10 добавит UI)
    if (url.pathname === '/api/admin/status' && request.method === 'GET') {
      return new Response(
        JSON.stringify({ ok: true, identity, deployment: env.DEPLOYMENT_MODE }),
        { status: 200, headers: { 'Content-Type': 'application/json', ...securityHeaders() } },
      )
    }

    return handleNotFound()
  } catch (e) {
    if (e instanceof AccessError) {
      return new Response(
        JSON.stringify({ error: e.message }),
        { status: e.status, headers: { 'Content-Type': 'application/json', ...securityHeaders() } },
      )
    }
    throw e
  }
}

/** Cron trigger — никакого HTTP, никакой auth, никаких внешних вызовов.
 *  Один раз в день в 07:00 UTC. */
export async function scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  console.log(`[scheduled] cron tick at ${new Date().toISOString()}, cron=${event.cron}`)
  ctx.waitUntil(runDailySync(env))
}

/** Stub для daily sync — Task 6 реализует полностью. */
async function runDailySync(env: Env): Promise<void> {
  console.log(`[scheduled] would sync, deployment=${env.DEPLOYMENT_MODE}, default=${env.DEFAULT_STRATEGY}`)
  // TODO Task 6: syncUnanswered → generateReplies → forecast
  // TODO Task 9: publishNext
}

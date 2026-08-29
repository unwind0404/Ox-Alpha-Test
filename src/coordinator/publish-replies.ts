// publish-replies: одна попытка опубликовать oldest ready_to_send job.
// Идемпотентно: CAS ready_to_send -> sending.
// При timeout после POST → reconcile_pending (GET review, проверяем answered).
// При 8 attempts → dead.

import { decryptToken } from '../adapters/cloudflare/token-crypto.js'
import { WbClient, type WbResult } from '../adapters/wb/wb-client.js'
import { D1JobRepository } from '../adapters/cloudflare/d1-job-repository.js'
import { D1AuditRepository } from '../adapters/cloudflare/d1-audit-repository.js'
import { D1ShopRepository } from '../adapters/cloudflare/d1-shop-repository.js'
import type { Env } from '../index.js'

export type PublishOutcome =
  | 'posted'
  | 'rate_limited'
  | 'failed'
  | 'reconcile_needed'
  | 'no_jobs'
  | 'shop_disabled'
  | 'dead'

export interface PublishResult {
  outcome: PublishOutcome
  jobId: string | null
  text: string | null
  attempts: number
  detail: string
}

const DEAD_THRESHOLD = 8
const RETRY_DELAY_MS = 12 * 60_000

async function getEncryptedToken(env: Env, shopId: string): Promise<{ token_ciphertext: string; token_iv: string; token_key_version: number } | null> {
  const row = await env.DB
    .prepare('SELECT token_ciphertext, token_iv, token_key_version FROM shops WHERE id = ?1')
    .bind(shopId)
    .first<{ token_ciphertext: string; token_iv: string; token_key_version: number }>()
  return row ?? null
}

export async function publishOne(input: { shopId: string; env: Env; nowMs: number }): Promise<PublishResult> {
  const { shopId, env, nowMs } = input

  const shopRepo = new D1ShopRepository(env.DB)
  const jobRepo = new D1JobRepository(env.DB)
  const auditRepo = new D1AuditRepository(env.DB)

  const shop = await shopRepo.getById(shopId)
  if (!shop) return { outcome: 'no_jobs', jobId: null, text: null, attempts: 0, detail: 'shop not found' }
  if (!shop.enabled) return { outcome: 'shop_disabled', jobId: null, text: null, attempts: 0, detail: 'shop disabled' }

  const ready = await jobRepo.listReadyToSend(shopId, nowMs, 1)
  if (ready.length === 0) {
    return { outcome: 'no_jobs', jobId: null, text: null, attempts: 0, detail: 'no ready jobs' }
  }
  const job = ready[0]!

  const claimed = await jobRepo.transition(job.id, 'ready_to_send', 'sending', {
    nextAttemptAtMs: nowMs + RETRY_DELAY_MS,
    statusUpdatedAtMs: nowMs,
  })
  if (!claimed) {
    return { outcome: 'failed', jobId: job.id, text: job.postedReplyText, attempts: job.attempts, detail: 'CAS failed' }
  }

  const newAttempts = job.attempts + 1
  await env.DB
    .prepare('UPDATE reply_jobs SET attempts = ?1, updated_at_ms = ?2 WHERE id = ?3')
    .bind(newAttempts, nowMs, job.id)
    .run()

  const encRow = await getEncryptedToken(env, shopId)
  if (!encRow) {
    return { outcome: 'failed', jobId: job.id, text: job.postedReplyText, attempts: newAttempts, detail: 'no encrypted token' }
  }
  let token: string
  try {
    token = await decryptToken(encRow.token_ciphertext, encRow.token_iv, encRow.token_key_version, {
      MASTER_KEY: env.MASTER_KEY,
      FINGERPRINT_KEY: env.FINGERPRINT_KEY,
    })
  } catch (e) {
    return { outcome: 'failed', jobId: job.id, text: job.postedReplyText, attempts: newAttempts, detail: `decrypt: ${(e as Error).message}` }
  }

  const wb = new WbClient({ token })
  const result: WbResult<null> = await wb.postReply(job.id, job.postedReplyText ?? '')

  if (result.ok) {
    await jobRepo.transition(job.id, 'sending', 'posted', {
      postedAtMs: nowMs,
      statusUpdatedAtMs: nowMs,
    })
    await auditRepo.insert({
      shopId, jobId: job.id, action: 'publish.success',
      reasonCode: null,
      detail: `attempts=${newAttempts}`,
      correlationId: `pub-${nowMs}-${job.id}`,
    })
    return { outcome: 'posted', jobId: job.id, text: job.postedReplyText, attempts: newAttempts, detail: 'posted' }
  }

  // err.kind сужен в if/else if (явный cast чтобы TS понимал discriminated union)
  const err = result.error as { kind: 'http'; status: number; bodyText: string; rateLimit: { retryAfterSec: number | null } } | { kind: 'timeout'; ms: number } | { kind: 'network'; message: string } | { kind: 'host_blocked'; host: string } | { kind: 'parse'; message: string } | { kind: 'rate_limit'; retryAfterSec: number }
  if (err.kind === 'rate_limit') {
    await jobRepo.transition(job.id, 'sending', 'ready_to_send', {
      nextAttemptAtMs: nowMs + err.retryAfterSec * 1000,
      statusReasonCode: 'rate_limited',
      statusUpdatedAtMs: nowMs,
    })
    await auditRepo.insert({
      shopId, jobId: job.id, action: 'publish.429',
      reasonCode: 'rate_limited',
      detail: `retryAfterSec=${err.retryAfterSec}`,
      correlationId: `pub-${nowMs}-${job.id}`,
    })
    return { outcome: 'rate_limited', jobId: job.id, text: job.postedReplyText, attempts: newAttempts, detail: `rate_limited retry=${err.retryAfterSec}s` }
  }

  if (err.kind === 'http' && (err.status === 400 || err.status === 422)) {
    await jobRepo.transition(job.id, 'sending', 'manual_review', {
      statusReasonCode: 'length_invalid',
      statusUpdatedAtMs: nowMs,
    })
    await auditRepo.insert({
      shopId, jobId: job.id, action: 'publish.bad_payload',
      reasonCode: 'length_invalid',
      detail: `status=${err.status}`,
      correlationId: `pub-${nowMs}-${job.id}`,
    })
    return { outcome: 'failed', jobId: job.id, text: job.postedReplyText, attempts: newAttempts, detail: `bad payload ${err.status}` }
  }

  if (newAttempts >= DEAD_THRESHOLD) {
    await jobRepo.transition(job.id, 'sending', 'dead', {
      statusReasonCode: 'dead_threshold',
      statusUpdatedAtMs: nowMs,
    })
    await auditRepo.insert({
      shopId, jobId: job.id, action: 'publish.dead',
      reasonCode: 'dead_threshold',
      detail: `attempts=${newAttempts} error=${err.kind}`,
      correlationId: `pub-${nowMs}-${job.id}`,
    })
    return { outcome: 'dead', jobId: job.id, text: job.postedReplyText, attempts: newAttempts, detail: `dead after ${newAttempts} attempts` }
  }

  await jobRepo.transition(job.id, 'sending', 'reconcile_pending', {
    statusReasonCode: 'reconcile_unknown',
    statusUpdatedAtMs: nowMs,
  })
  await auditRepo.insert({
    shopId, jobId: job.id, action: 'publish.reconcile',
    reasonCode: 'reconcile_unknown',
    detail: `kind=${err.kind} attempts=${newAttempts}`,
    correlationId: `pub-${nowMs}-${job.id}`,
  })
  return { outcome: 'reconcile_needed', jobId: job.id, text: job.postedReplyText, attempts: newAttempts, detail: `kind=${err.kind}` }
}

export async function reconcileJob(
  input: { shopId: string; env: Env; nowMs: number; jobId: string },
): Promise<PublishResult> {
  const { shopId, env, nowMs, jobId } = input

  const jobRepo = new D1JobRepository(env.DB)
  const auditRepo = new D1AuditRepository(env.DB)
  void new D1ShopRepository(env.DB)

  const encRow = await getEncryptedToken(env, shopId)
  if (!encRow) return { outcome: 'failed', jobId, text: null, attempts: 0, detail: 'no encrypted token' }

  let token: string
  try {
    token = await decryptToken(encRow.token_ciphertext, encRow.token_iv, encRow.token_key_version, {
      MASTER_KEY: env.MASTER_KEY,
      FINGERPRINT_KEY: env.FINGERPRINT_KEY,
    })
  } catch (e) {
    return { outcome: 'failed', jobId, text: null, attempts: 0, detail: `decrypt: ${(e as Error).message}` }
  }

  const wb = new WbClient({ token })
  const r = await wb.getFeedback(jobId)
  if (!r.ok) {
    return { outcome: 'failed', jobId, text: null, attempts: 0, detail: `getFeedback: ${r.error.kind}` }
  }

  if (r.data.feedback.answer && r.data.feedback.answer.text) {
    await jobRepo.transition(jobId, 'reconcile_pending', 'posted', {
      postedAtMs: nowMs,
      postedReplyText: r.data.feedback.answer.text,
      statusUpdatedAtMs: nowMs,
    })
    await auditRepo.insert({
      shopId, jobId, action: 'reconcile.posted',
      reasonCode: null,
      detail: 'WB reports answered',
      correlationId: `rec-${nowMs}-${jobId}`,
    })
    return { outcome: 'posted', jobId, text: r.data.feedback.answer.text, attempts: 0, detail: 'reconciled' }
  }

  const job = await jobRepo.getById(jobId)
  if (!job) return { outcome: 'failed', jobId, text: null, attempts: 0, detail: 'job not found' }

  if (job.attempts >= DEAD_THRESHOLD) {
    await jobRepo.transition(jobId, 'reconcile_pending', 'dead', {
      statusReasonCode: 'dead_threshold',
      statusUpdatedAtMs: nowMs,
    })
    return { outcome: 'dead', jobId, text: null, attempts: job.attempts, detail: 'dead after reconcile' }
  }

  await jobRepo.transition(jobId, 'reconcile_pending', 'ready_to_send', {
    nextAttemptAtMs: nowMs + RETRY_DELAY_MS,
    statusUpdatedAtMs: nowMs,
  })
  await auditRepo.insert({
    shopId, jobId, action: 'reconcile.retry',
    reasonCode: null,
    detail: 'WB reports unanswered, re-queued',
    correlationId: `rec-${nowMs}-${jobId}`,
  })
  return { outcome: 'reconcile_needed', jobId, text: job.postedReplyText, attempts: job.attempts, detail: 're-queued' }
}

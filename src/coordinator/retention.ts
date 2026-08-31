// Retention: scheduled cleanup старых данных.
// - reviews старше 90 дней удаляются (НЕ posted — их можно оставить дольше для истории)
// - audit_events старше 180 дней удаляются
// - jobs: terminal (posted/rejected/dead) старше 180 дней удаляются
// Активные jobs (generating, draft_ready, ready_to_send и т.д.) НЕ трогаем.

import { D1AuditRepository } from '../adapters/cloudflare/d1-audit-repository.js'
import type { Env } from '../index.js'

export interface RetentionConfig {
  /** Сколько дней хранить отзывы. */
  reviewRetentionDays: number
  /** Сколько дней хранить audit_events. */
  auditRetentionDays: number
}

export const DEFAULT_RETENTION: RetentionConfig = {
  reviewRetentionDays: 90,
  auditRetentionDays: 180,
}

export interface RetentionResult {
  reviewsDeleted: number
  auditsDeleted: number
  jobsDeleted: number
  config: RetentionConfig
  executedAtMs: number
}

export async function runRetention(env: Env, nowMs: number, config: RetentionConfig = DEFAULT_RETENTION): Promise<RetentionResult> {
  
  
  const auditRepo = new D1AuditRepository(env.DB)

  // reviews: удаляем всё старше reviewRetentionDays, КРОМЕ posted (для истории)
  const reviewCutoff = nowMs - config.reviewRetentionDays * 24 * 60 * 60_000
  // Используем D1 напрямую (нет API в репозитории для bulk delete)
  const reviewResult = await env.DB
    .prepare(`DELETE FROM reviews WHERE received_at_ms < ?1 AND id NOT IN (
      SELECT review_id FROM reply_jobs WHERE state = 'posted'
    )`)
    .bind(reviewCutoff)
    .run()
  const reviewsDeleted = Number(reviewResult.meta?.changes ?? 0)

  // audit_events: удаляем старше auditRetentionDays
  const auditCutoff = nowMs - config.auditRetentionDays * 24 * 60 * 60_000
  const auditResult = await env.DB
    .prepare('DELETE FROM audit_events WHERE created_at_ms < ?1')
    .bind(auditCutoff)
    .run()
  const auditsDeleted = Number(auditResult.meta?.changes ?? 0)

  // jobs: удаляем TERMINAL jobs старше auditRetentionDays (180 дней)
  // Терминальные: posted, rejected, dead
  // НЕ удаляем active jobs (готовятся, отправляются, в ретрае)
  const jobsResult = await env.DB
    .prepare(`DELETE FROM reply_jobs
      WHERE state IN ('posted', 'rejected', 'dead')
        AND updated_at_ms < ?1`)
    .bind(auditCutoff)
    .run()
  const jobsDeleted = Number(jobsResult.meta?.changes ?? 0)

  // Audit самой очистки
  await auditRepo.insert({
    shopId: null, jobId: null,
    action: 'retention.cleanup',
    reasonCode: null,
    detail: `reviews=${reviewsDeleted} audits=${auditsDeleted} jobs=${jobsDeleted} (cutoffs: reviews<${config.reviewRetentionDays}d, audits<${config.auditRetentionDays}d)`,
    correlationId: `retention-${nowMs}`,
  })

  return {
    reviewsDeleted,
    auditsDeleted,
    jobsDeleted,
    config,
    executedAtMs: nowMs,
  }
}

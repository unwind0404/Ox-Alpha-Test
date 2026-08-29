// D1 adapter для JobRepository.
// Compare-and-set через UPDATE ... WHERE state = ?expected.
// Возвращает обновлённый job или null, если CAS не прошёл.

import type { D1Database } from '@cloudflare/workers-types'
import type {
  JobState,
  ReplyJob,
  ReplyStrategy,
  StatusReasonCode,
} from '../../core/types.js'
import type { JobRepository } from '../../ports/repositories.js'

interface JobRow {
  id: string
  review_id: string
  shop_id: string
  state: JobState
  strategy: ReplyStrategy
  scheduled_send_at_ms: number | null
  queue_position: number | null
  schedule_revision: number
  next_attempt_at_ms: number
  attempts: number
  status_reason_code: StatusReasonCode | null
  status_updated_at_ms: number
  posted_at_ms: number | null
  posted_reply_text: string | null
  created_at_ms: number
  updated_at_ms: number
}

function rowToJob(row: JobRow): ReplyJob {
  return {
    id: row.id,
    reviewId: row.review_id,
    shopId: row.shop_id,
    state: row.state,
    strategy: row.strategy,
    scheduledSendAtMs: row.scheduled_send_at_ms,
    queuePosition: row.queue_position,
    scheduleRevision: row.schedule_revision,
    nextAttemptAtMs: row.next_attempt_at_ms,
    attempts: row.attempts,
    statusReasonCode: row.status_reason_code,
    statusUpdatedAtMs: row.status_updated_at_ms,
    postedAtMs: row.posted_at_ms,
    postedReplyText: row.posted_reply_text,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  }
}

/** Утилита: patch-параметры в SQL SET clause. */
function buildSetClause(
  patch: Partial<Pick<ReplyJob, 'attempts' | 'nextAttemptAtMs' | 'postedAtMs' | 'postedReplyText' | 'statusReasonCode' | 'statusUpdatedAtMs' | 'scheduledSendAtMs' | 'queuePosition' | 'scheduleRevision'>>,
): { sql: string; values: unknown[] } {
  const fields: string[] = []
  const values: unknown[] = []
  let i = 0
  const next = () => `?${++i}`

  if ('attempts' in patch && patch.attempts !== undefined) {
    fields.push(`attempts = ${next()}`)
    values.push(patch.attempts)
  }
  if ('nextAttemptAtMs' in patch && patch.nextAttemptAtMs !== undefined) {
    fields.push(`next_attempt_at_ms = ${next()}`)
    values.push(patch.nextAttemptAtMs)
  }
  if ('postedAtMs' in patch && patch.postedAtMs !== undefined) {
    fields.push(`posted_at_ms = ${next()}`)
    values.push(patch.postedAtMs)
  }
  if ('postedReplyText' in patch && patch.postedReplyText !== undefined) {
    fields.push(`posted_reply_text = ${next()}`)
    values.push(patch.postedReplyText)
  }
  if ('statusReasonCode' in patch) {
    fields.push(`status_reason_code = ${next()}`)
    values.push(patch.statusReasonCode)
  }
  if ('statusUpdatedAtMs' in patch && patch.statusUpdatedAtMs !== undefined) {
    fields.push(`status_updated_at_ms = ${next()}`)
    values.push(patch.statusUpdatedAtMs)
  }
  if ('scheduledSendAtMs' in patch) {
    fields.push(`scheduled_send_at_ms = ${next()}`)
    values.push(patch.scheduledSendAtMs)
  }
  if ('queuePosition' in patch) {
    fields.push(`queue_position = ${next()}`)
    values.push(patch.queuePosition)
  }
  if ('scheduleRevision' in patch && patch.scheduleRevision !== undefined) {
    fields.push(`schedule_revision = ${next()}`)
    values.push(patch.scheduleRevision)
  }
  // updated_at — всегда
  fields.push(`updated_at_ms = ${next()}`)
  values.push(Date.now())

  return { sql: fields.join(', '), values }
}

export class D1JobRepository implements JobRepository {
  constructor(private readonly db: D1Database) {}

  async createOnce(job: ReplyJob): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO reply_jobs (
          id, review_id, shop_id, state, strategy, scheduled_send_at_ms,
          queue_position, schedule_revision, next_attempt_at_ms, attempts,
          status_reason_code, status_updated_at_ms, posted_at_ms, posted_reply_text,
          created_at_ms, updated_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
        ON CONFLICT(review_id) DO NOTHING`,
      )
      .bind(
        job.id,
        job.reviewId,
        job.shopId,
        job.state,
        job.strategy,
        job.scheduledSendAtMs,
        job.queuePosition,
        job.scheduleRevision,
        job.nextAttemptAtMs,
        job.attempts,
        job.statusReasonCode,
        job.statusUpdatedAtMs,
        job.postedAtMs,
        job.postedReplyText,
        job.createdAtMs,
        job.updatedAtMs,
      )
      .run()
    return (result.meta?.changes ?? 0) > 0
  }

  async getById(id: string): Promise<ReplyJob | null> {
    const row = await this.db
      .prepare('SELECT * FROM reply_jobs WHERE id = ?1')
      .bind(id)
      .first<JobRow>()
    return row ? rowToJob(row) : null
  }

  async transition(
    id: string,
    expectedState: JobState,
    newState: JobState,
    patch: Partial<Pick<ReplyJob, 'attempts' | 'nextAttemptAtMs' | 'postedAtMs' | 'postedReplyText' | 'statusReasonCode' | 'statusUpdatedAtMs' | 'scheduledSendAtMs' | 'queuePosition' | 'scheduleRevision'>>,
  ): Promise<ReplyJob | null> {
    const { sql, values } = buildSetClause(patch)
    const i = values.length + 1
    const result = await this.db
      .prepare(
        `UPDATE reply_jobs SET state = ?${i}, ${sql}
         WHERE id = ?${i + 1} AND state = ?${i + 2}
         RETURNING *`,
      )
      .bind(newState, ...values, id, expectedState)
      .first<JobRow>()
    return result ? rowToJob(result) : null
  }

  async listReadyToSend(shopId: string, nowMs: number, limit: number): Promise<ReplyJob[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM reply_jobs
         WHERE shop_id = ?1 AND state = 'ready_to_send' AND next_attempt_at_ms <= ?2
         ORDER BY scheduled_send_at_ms ASC
         LIMIT ?3`,
      )
      .bind(shopId, nowMs, limit)
      .all<JobRow>()
    return result.results.map(rowToJob)
  }

  async listActiveByShop(shopId: string, limit: number): Promise<ReplyJob[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM reply_jobs
         WHERE shop_id = ?1
           AND state NOT IN ('posted', 'rejected', 'dead')
         ORDER BY created_at_ms ASC
         LIMIT ?2`,
      )
      .bind(shopId, limit)
      .all<JobRow>()
    return result.results.map(rowToJob)
  }

  async listByShopForQueue(shopId: string, limit: number): Promise<ReplyJob[]> {
    return this.listActiveByShop(shopId, limit)
  }

  async bumpScheduleRevision(shopId: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE reply_jobs
         SET schedule_revision = schedule_revision + 1, updated_at_ms = ?1
         WHERE shop_id = ?2
           AND state NOT IN ('posted', 'rejected', 'dead')`,
      )
      .bind(Date.now(), shopId)
      .run()
  }
}

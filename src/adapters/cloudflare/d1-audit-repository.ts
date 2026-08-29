// D1 adapter для AuditRepository.

import type { D1Database } from '@cloudflare/workers-types'
import type { AuditEvent, StatusReasonCode } from '../../core/types.js'
import type { AuditRepository } from '../../ports/repositories.js'

interface AuditRow {
  id: number
  shop_id: string | null
  job_id: string | null
  action: string
  reason_code: string | null
  detail: string | null
  correlation_id: string
  created_at_ms: number
}

function rowToEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    shopId: row.shop_id,
    jobId: row.job_id,
    action: row.action,
    reasonCode: row.reason_code as StatusReasonCode | null,
    detail: row.detail,
    correlationId: row.correlation_id,
    createdAtMs: row.created_at_ms,
  }
}

export class D1AuditRepository implements AuditRepository {
  constructor(private readonly db: D1Database) {}

  async insert(event: Omit<AuditEvent, 'id' | 'createdAtMs'>): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO audit_events (
          shop_id, job_id, action, reason_code, detail, correlation_id, created_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(
        event.shopId,
        event.jobId,
        event.action,
        event.reasonCode,
        event.detail,
        event.correlationId,
        Date.now(),
      )
      .run()
  }

  async listRecent(shopId: string | null, limit: number): Promise<AuditEvent[]> {
    const result = shopId === null
      ? await this.db
          .prepare('SELECT * FROM audit_events ORDER BY created_at_ms DESC LIMIT ?1')
          .bind(limit)
          .all<AuditRow>()
      : await this.db
          .prepare(
            'SELECT * FROM audit_events WHERE shop_id = ?1 ORDER BY created_at_ms DESC LIMIT ?2',
          )
          .bind(shopId, limit)
          .all<AuditRow>()
    return result.results.map(rowToEvent)
  }
}

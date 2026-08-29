// D1 adapter для LlmUsageRepository.

import type { D1Database } from '@cloudflare/workers-types'
import type { LlmDailyUsage } from '../../core/types.js'
import type { LlmUsageRepository } from '../../ports/repositories.js'

interface LlmUsageRow {
  shop_id: string
  day_utc: string
  calls: number
  tokens_input: number
  tokens_output: number
  updated_at_ms: number
}

function rowToUsage(row: LlmUsageRow): LlmDailyUsage {
  return {
    shopId: row.shop_id,
    dayUtc: row.day_utc,
    calls: row.calls,
    tokensInput: row.tokens_input,
    tokensOutput: row.tokens_output,
  }
}

export class D1LlmUsageRepository implements LlmUsageRepository {
  constructor(private readonly db: D1Database) {}

  async incrementAndGet(
    shopId: string,
    dayUtc: string,
    tokensInput: number,
    tokensOutput: number,
  ): Promise<LlmDailyUsage> {
    // UPSERT с инкрементом
    const now = Date.now()
    await this.db
      .prepare(
        `INSERT INTO llm_daily_usage (shop_id, day_utc, calls, tokens_input, tokens_output, updated_at_ms)
         VALUES (?1, ?2, 1, ?3, ?4, ?5)
         ON CONFLICT(shop_id, day_utc) DO UPDATE SET
           calls = calls + 1,
           tokens_input = tokens_input + ?3,
           tokens_output = tokens_output + ?4,
           updated_at_ms = ?5`,
      )
      .bind(shopId, dayUtc, tokensInput, tokensOutput, now)
      .run()
    const row = await this.get(shopId, dayUtc)
    if (!row) {
      throw new Error(`Failed to read llm_daily_usage after upsert for ${shopId}/${dayUtc}`)
    }
    return row
  }

  async get(shopId: string, dayUtc: string): Promise<LlmDailyUsage | null> {
    const row = await this.db
      .prepare('SELECT * FROM llm_daily_usage WHERE shop_id = ?1 AND day_utc = ?2')
      .bind(shopId, dayUtc)
      .first<LlmUsageRow>()
    return row ? rowToUsage(row) : null
  }
}

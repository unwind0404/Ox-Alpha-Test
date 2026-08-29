// D1 adapter для ShopRepository.
// Использует prepared statements, избегает string concatenation.

import type { D1Database } from '@cloudflare/workers-types'
import type {
  Shop,
  ReplyStrategy,
  TokenProfile,
  DeploymentMode,
} from '../../core/types.js'
import type { ShopRepository, EncryptedToken } from '../../ports/repositories.js'

interface ShopRow {
  id: string
  name: string
  wb_account_key: string
  token_ciphertext: string
  token_iv: string
  token_key_version: number
  token_fingerprint: string
  token_profile: TokenProfile
  deployment_mode: DeploymentMode
  mode: ReplyStrategy
  enabled: number
  last_sync_day_utc: string | null
  next_sync_at: number
  token_expires_at: number | null
  disabled_reason: string | null
  created_at: number
  updated_at: number
}

function rowToShop(row: ShopRow): Shop {
  return {
    id: row.id,
    name: row.name,
    wbAccountKey: row.wb_account_key,
    tokenProfile: row.token_profile,
    deploymentMode: row.deployment_mode,
    mode: row.mode,
    enabled: row.enabled === 1,
    lastSyncDayUtc: row.last_sync_day_utc,
    nextSyncAtMs: row.next_sync_at,
    tokenExpiresAtMs: row.token_expires_at,
    disabledReason: row.disabled_reason,
    createdAtMs: row.created_at,
    updatedAtMs: row.updated_at,
  }
}

export class D1ShopRepository implements ShopRepository {
  constructor(private readonly db: D1Database) {}

  async getById(id: string): Promise<Shop | null> {
    const result = await this.db
      .prepare('SELECT * FROM shops WHERE id = ?1')
      .bind(id)
      .first<ShopRow>()
    return result ? rowToShop(result) : null
  }

  async getByAccountKey(wbAccountKey: string): Promise<Shop | null> {
    const result = await this.db
      .prepare('SELECT * FROM shops WHERE wb_account_key = ?1')
      .bind(wbAccountKey)
      .first<ShopRow>()
    return result ? rowToShop(result) : null
  }

  async getByTokenFingerprint(fingerprint: string): Promise<Shop | null> {
    const result = await this.db
      .prepare('SELECT * FROM shops WHERE token_fingerprint = ?1')
      .bind(fingerprint)
      .first<ShopRow>()
    return result ? rowToShop(result) : null
  }

  async listEnabled(): Promise<Shop[]> {
    const result = await this.db
      .prepare('SELECT * FROM shops WHERE enabled = 1 ORDER BY next_sync_at')
      .all<ShopRow>()
    return result.results.map(rowToShop)
  }

  async insert(shop: Shop, token: EncryptedToken): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO shops (
          id, name, wb_account_key, token_ciphertext, token_iv, token_key_version,
          token_fingerprint, token_profile, deployment_mode, mode, enabled,
          next_sync_at, token_expires_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
      )
      .bind(
        shop.id,
        shop.name,
        shop.wbAccountKey,
        token.ciphertext,
        token.iv,
        token.keyVersion,
        token.fingerprint,
        shop.tokenProfile,
        shop.deploymentMode,
        shop.mode,
        shop.enabled ? 1 : 0,
        shop.nextSyncAtMs,
        shop.tokenExpiresAtMs,
        shop.createdAtMs,
        shop.updatedAtMs,
      )
      .run()
  }

  async updateMode(id: string, mode: ReplyStrategy): Promise<void> {
    await this.db
      .prepare('UPDATE shops SET mode = ?1, updated_at = ?2 WHERE id = ?3')
      .bind(mode, Date.now(), id)
      .run()
  }

  async setEnabled(id: string, enabled: boolean, reason: string | null): Promise<void> {
    await this.db
      .prepare(
        'UPDATE shops SET enabled = ?1, disabled_reason = ?2, updated_at = ?3 WHERE id = ?4',
      )
      .bind(enabled ? 1 : 0, reason, Date.now(), id)
      .run()
  }

  async setLastSyncDay(id: string, dayUtc: string): Promise<void> {
    await this.db
      .prepare('UPDATE shops SET last_sync_day_utc = ?1, updated_at = ?2 WHERE id = ?3')
      .bind(dayUtc, Date.now(), id)
      .run()
  }

  async rotateToken(id: string, token: EncryptedToken): Promise<void> {
    await this.db
      .prepare(
        `UPDATE shops SET
          token_ciphertext = ?1, token_iv = ?2, token_key_version = ?3,
          token_fingerprint = ?4, updated_at = ?5
        WHERE id = ?6`,
      )
      .bind(
        token.ciphertext,
        token.iv,
        token.keyVersion,
        token.fingerprint,
        Date.now(),
        id,
      )
      .run()
  }
}

// Repository contracts — реализуются адаптерами (D1 сейчас, SQLite позже).
// Core и coordinator работают ТОЛЬКО через эти интерфейсы.

import type {
  AuditEvent,
  JobState,
  LlmDailyUsage,
  ReplyJob,
  ReplyStrategy,
  Review,
  Shop,
} from '../core/types.js'

/** Шифрованный токен магазина (ciphertext, IV, fingerprint). */
export interface EncryptedToken {
  ciphertext: string
  iv: string
  fingerprint: string
  keyVersion: number
}

/** Магазин + шифрованный токен (read-возврат). */
export interface ShopWithToken {
  shop: Shop
  token: EncryptedToken
}

export interface ShopRepository {
  getById(id: string): Promise<Shop | null>
  getByAccountKey(wbAccountKey: string): Promise<Shop | null>
  getByTokenFingerprint(fingerprint: string): Promise<Shop | null>
  listEnabled(): Promise<Shop[]>
  insert(shop: Shop, token: EncryptedToken): Promise<void>
  updateMode(id: string, mode: ReplyStrategy): Promise<void>
  setEnabled(id: string, enabled: boolean, reason: string | null): Promise<void>
  setLastSyncDay(id: string, dayUtc: string): Promise<void>
  rotateToken(id: string, token: EncryptedToken): Promise<void>
}

export interface ReviewRepository {
  /** Idempotent upsert. Возвращает true, если новая запись. */
  upsert(review: Review): Promise<boolean>
  getById(id: string): Promise<Review | null>
  getByWbFeedbackId(shopId: string, wbFeedbackId: string): Promise<Review | null>
  listByShopAfter(shopId: string, afterMs: number, limit: number): Promise<Review[]>
}

export interface JobRepository {
  /** Создать один job для пары (shopId, reviewId) — no-op если уже есть. */
  createOnce(job: ReplyJob): Promise<boolean>
  getById(id: string): Promise<ReplyJob | null>
  /** Compare-and-set переход состояния. Возвращает обновлённый job или null, если CAS не прошёл. */
  transition(
    id: string,
    expectedState: JobState,
    newState: JobState,
    patch: Partial<Pick<ReplyJob, 'attempts' | 'nextAttemptAtMs' | 'postedAtMs' | 'postedReplyText' | 'statusReasonCode' | 'statusUpdatedAtMs' | 'scheduledSendAtMs' | 'queuePosition' | 'scheduleRevision'>>,
  ): Promise<ReplyJob | null>
  /** Due jobs, готовые к публикации. */
  listReadyToSend(shopId: string, nowMs: number, limit: number): Promise<ReplyJob[]>
  /** Все активные jobs магазина (не terminal). */
  listActiveByShop(shopId: string, limit: number): Promise<ReplyJob[]>
  /** Pending jobs для UI (всех состояний). */
  listByShopForQueue(shopId: string, limit: number): Promise<ReplyJob[]>
  /** Увеличить scheduleRevision всем pending jobs магазина (после forecast rebuild). */
  bumpScheduleRevision(shopId: string): Promise<void>
}

export interface AuditRepository {
  insert(event: Omit<AuditEvent, 'id' | 'createdAtMs'>): Promise<void>
  listRecent(shopId: string | null, limit: number): Promise<AuditEvent[]>
}

export interface LlmUsageRepository {
  /** Increment + return new total. */
  incrementAndGet(shopId: string, dayUtc: string, tokensInput: number, tokensOutput: number): Promise<LlmDailyUsage>
  get(shopId: string, dayUtc: string): Promise<LlmDailyUsage | null>
}

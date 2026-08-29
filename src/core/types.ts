// Runtime-neutral core types.
// Не должен зависеть от Cloudflare, Node, DOM, etc.
// Только типы, чистые функции. Никаких I/O, никаких globals.

/** Тип WB-токена: определяет rate-limit и допустимое окружение. */
export type TokenProfile = 'basic' | 'personal' | 'service'

/** Окружение деплоя: где запускается бот. */
export type DeploymentMode = 'cloud' | 'self_managed'

/** Допустимые матрицы (deployment × profile) — fail-closed gate. */
export const ALLOWED_MATRIX: ReadonlyArray<{
  deployment: DeploymentMode
  profile: TokenProfile
}> = [
  { deployment: 'cloud', profile: 'basic' },
  { deployment: 'self_managed', profile: 'personal' },
]

/** Стратегия ответа на отзыв. */
export type ReplyStrategy = 'templates' | 'drafts' | 'llm'

/** Состояния job (state machine). */
export type JobState =
  | 'discovered'
  | 'generating'
  | 'draft_ready'
  | 'ready_to_send'
  | 'sending'
  | 'posted'
  | 'retry_wait'
  | 'reconcile_pending'
  | 'manual_review'
  | 'rejected'
  | 'waiting_llm_quota'
  | 'dead'

/** Допустимые переходы (state machine). */
export const ALLOWED_TRANSITIONS: Readonly<Record<JobState, ReadonlyArray<JobState>>> = {
  discovered: ['generating', 'draft_ready', 'ready_to_send', 'manual_review', 'waiting_llm_quota'],
  generating: ['draft_ready', 'ready_to_send', 'manual_review', 'waiting_llm_quota'],
  draft_ready: ['ready_to_send', 'rejected', 'generating'],
  ready_to_send: ['sending'],
  sending: ['posted', 'retry_wait', 'reconcile_pending', 'manual_review', 'dead'],
  retry_wait: ['ready_to_send', 'sending', 'manual_review', 'dead'],
  reconcile_pending: ['posted', 'ready_to_send', 'manual_review', 'dead'],
  posted: [], // terminal
  manual_review: ['generating', 'ready_to_send', 'draft_ready', 'rejected'],
  rejected: [], // terminal
  waiting_llm_quota: ['generating', 'manual_review'],
  dead: [], // terminal
}

/** Причина блокировки / статус-код для UI. */
export type StatusReasonCode =
  | 'low_rating'
  | 'pii_detected'
  | 'injection_detected'
  | 'length_invalid'
  | 'rate_limited'
  | 'auth_error'
  | 'token_expiring'
  | 'oldest_too_old'
  | 'llm_quota'
  | 'malformed_response'
  | 'dead_threshold'
  | 'reconcile_unknown'

/** Коды статусов для UI (derived из JobState + paused + age). */
export type ReviewDisplayStatusCode =
  | 'new'
  | 'preparing_reply'
  | 'waiting_llm_quota'
  | 'awaiting_approval'
  | 'scheduled'
  | 'sending'
  | 'published_on_wb'
  | 'retry_scheduled'
  | 'checking_delivery'
  | 'manual_review'
  | 'rejected'
  | 'paused'
  | 'failed'

/** UI-представление статуса (derived функцией, не хранится в БД). */
export interface ReviewStatusView {
  code: ReviewDisplayStatusCode
  label: string
  detail: string | null
  effectiveAtMs: number | null
  queuePosition: number | null
  queueSize: number | null
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger'
}

/** Рейтинг 1..5 (с WB). */
export type Rating = 1 | 2 | 3 | 4 | 5

/** Магазин (без чувствительных полей — токен шифруется отдельно). */
export interface Shop {
  id: string
  name: string
  wbAccountKey: string
  tokenProfile: TokenProfile
  deploymentMode: DeploymentMode
  mode: ReplyStrategy
  enabled: boolean
  lastSyncDayUtc: string | null
  nextSyncAtMs: number
  tokenExpiresAtMs: number | null
  disabledReason: string | null
  createdAtMs: number
  updatedAtMs: number
}

/** Отзыв (без медиа, отдельно). */
export interface Review {
  id: string // PRIMARY KEY
  shopId: string
  wbFeedbackId: string
  wbCreatedAtMs: number
  rating: Rating | null
  userName: string | null
  productName: string | null
  productNmId: number | null
  text: string | null
  pros: string | null
  cons: string | null
  photoUrls: ReadonlyArray<string>
  videoUrl: string | null
  receivedAtMs: number
  createdAtMs: number
}

/** Задача (job) на обработку отзыва. */
export interface ReplyJob {
  id: string
  reviewId: string
  shopId: string
  state: JobState
  strategy: ReplyStrategy
  scheduledSendAtMs: number | null
  queuePosition: number | null
  scheduleRevision: number
  nextAttemptAtMs: number
  attempts: number
  statusReasonCode: StatusReasonCode | null
  statusUpdatedAtMs: number
  postedAtMs: number | null
  postedReplyText: string | null
  createdAtMs: number
  updatedAtMs: number
}

/** Аудит-событие. */
export interface AuditEvent {
  id: number
  shopId: string | null
  jobId: string | null
  action: string
  reasonCode: StatusReasonCode | null
  detail: string | null
  correlationId: string
  createdAtMs: number
}

/** Использование LLM за день (для квоты). */
export interface LlmDailyUsage {
  shopId: string
  dayUtc: string
  calls: number
  tokensInput: number
  tokensOutput: number
}

/** Rate-profile (Basic, Personal, Service). */
export interface RateProfile {
  /** Минимальный интервал между WB-операциями (мс). */
  minIntervalMs: number
  /** Максимум операций за один wake (наш планировщик). */
  maxWbOpsPerWake: number
  /** Безопасный дневной лимит успешных reply за скользящие 24ч. */
  safeRepliesPerRollingDay: number
}

export const WB_RATE_PROFILES: Readonly<Record<TokenProfile, RateProfile>> = {
  basic: {
    minIntervalMs: 720_000, // 12 минут
    maxWbOpsPerWake: 1,
    safeRepliesPerRollingDay: 100,
  },
  personal: {
    minIntervalMs: 400,
    maxWbOpsPerWake: 10,
    safeRepliesPerRollingDay: Number.MAX_SAFE_INTEGER,
  },
  service: {
    minIntervalMs: 400,
    maxWbOpsPerWake: 10,
    safeRepliesPerRollingDay: Number.MAX_SAFE_INTEGER,
  },
} as const

/** Допустим ли такой (deployment, profile). */
export function isTokenAllowed(deployment: DeploymentMode, profile: TokenProfile): boolean {
  return ALLOWED_MATRIX.some((m) => m.deployment === deployment && m.profile === profile)
}

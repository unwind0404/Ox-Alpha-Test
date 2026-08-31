// UI types — derived from core, безопасные для браузера.
// Не зависят от @cloudflare/workers-types, чтобы можно было собрать в bundle.

export type ReviewStatusCode =
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

export interface ReviewUi {
  id: string
  shopId: string
  shopName: string
  wbFeedbackId: string
  rating: number | null
  userName: string | null
  productName: string | null
  text: string | null
  pros: string | null
  cons: string | null
  status: ReviewStatusCode
  statusLabel: string
  statusTone: 'info' | 'success' | 'warning' | 'danger' | 'neutral'
  queuePosition: number | null
  scheduledSendAtMs: number | null
  postedReplyText: string | null
  receivedAtMs: number
}

export interface ShopUi {
  id: string
  name: string
  mode: 'templates' | 'drafts' | 'llm'
  enabled: boolean
  tokenProfile: 'basic' | 'personal' | 'service'
  lastSyncDayUtc: string | null
}

export interface AuditEventUi {
  id: number
  shopId: string | null
  jobId: string | null
  action: string
  reasonCode: string | null
  detail: string | null
  createdAtMs: number
}

export interface Metrics {
  fetched: number
  queued: number
  drafted: number
  ready: number
  posted: number
  manual: number
  rate_limited: number
  failed: number
  oldestAgeMs: number | null
  nextSlotMs: number | null
}

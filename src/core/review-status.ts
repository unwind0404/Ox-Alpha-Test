// ReviewStatusView — derives UI-friendly status from internal job state.
// Хранится в БД: state, timestamps, reason_code. НЕ русские подписи.

import type { JobState, ReviewStatusView, ReviewDisplayStatusCode } from './types.js'

/** Маппинг (state, причина) -> UI статус. */
function deriveCode(state: JobState, hasShopPaused: boolean, oldestReadyAgeMs: number | null): ReviewDisplayStatusCode {
  if (hasShopPaused) return 'paused'
  if (oldestReadyAgeMs !== null && oldestReadyAgeMs > 24 * 60 * 60 * 1000) {
    return 'failed'
  }
  switch (state) {
    case 'discovered':
      return 'new'
    case 'generating':
      return 'preparing_reply'
    case 'waiting_llm_quota':
      return 'waiting_llm_quota'
    case 'draft_ready':
      return 'awaiting_approval'
    case 'ready_to_send':
      return 'scheduled'
    case 'sending':
      return 'sending'
    case 'posted':
      return 'published_on_wb'
    case 'retry_wait':
      return 'retry_scheduled'
    case 'reconcile_pending':
      return 'checking_delivery'
    case 'manual_review':
      return 'manual_review'
    case 'rejected':
      return 'rejected'
    case 'dead':
      return 'failed'
  }
}

const LABELS: Readonly<Record<ReviewDisplayStatusCode, string>> = {
  new: 'Новый',
  preparing_reply: 'Готовим ответ',
  waiting_llm_quota: 'Ожидает генерации',
  awaiting_approval: 'Черновик готов',
  scheduled: 'Запланирована отправка',
  sending: 'Отправляется на WB',
  published_on_wb: 'Ответ опубликован на WB',
  retry_scheduled: 'Повторная отправка',
  checking_delivery: 'Проверяем отправку',
  manual_review: 'Нужна проверка',
  rejected: 'Черновик отклонён',
  paused: 'Пауза',
  failed: 'Ошибка — требуется действие',
}

const TONES: Readonly<Record<ReviewDisplayStatusCode, ReviewStatusView['tone']>> = {
  new: 'info',
  preparing_reply: 'info',
  waiting_llm_quota: 'warning',
  awaiting_approval: 'info',
  scheduled: 'info',
  sending: 'info',
  published_on_wb: 'success',
  retry_scheduled: 'warning',
  checking_delivery: 'warning',
  manual_review: 'warning',
  rejected: 'neutral',
  paused: 'warning',
  failed: 'danger',
}

export interface DeriveInput {
  state: JobState
  hasShopPaused: boolean
  /** Возраст oldest ready job магазина в мс (null если нет ready). */
  oldestReadyAgeMs: number | null
  /** Плановое время отправки (UTC epoch, мс). null если ещё не рассчитано. */
  scheduledSendAtMs: number | null
  /** Позиция в очереди. */
  queuePosition: number | null
  /** Размер очереди (всех активных jobs магазина). */
  queueSize: number | null
  /** Когда состояние изменилось в последний раз. */
  effectiveAtMs: number | null
}

export function deriveReviewStatus(input: DeriveInput): ReviewStatusView {
  const code = deriveCode(input.state, input.hasShopPaused, input.oldestReadyAgeMs)
  return {
    code,
    label: LABELS[code],
    detail: null,
    effectiveAtMs: input.effectiveAtMs,
    queuePosition: input.queuePosition,
    queueSize: input.queueSize,
    tone: TONES[code],
  }
}

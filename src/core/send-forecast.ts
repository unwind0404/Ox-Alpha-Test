// send-forecast: назначает ETA для ready_to_send jobs.
// - 12-минутный интервал для basic
// - Слоты идут подряд, но НЕ раньше max(now, nextRequestAt, cooldown, nextAttemptAt)
// - Резервируем слот для daily_sync (если пересекает 07:00 UTC)
// - Возвращаем те же job'ы с обновлёнными scheduledSendAtMs и queuePosition.

import type { RateProfile, TokenProfile } from './types.js'
import { WB_RATE_PROFILES } from './types.js'
import { nextAllowedAt, type RateState } from './rate-policy.js'

export interface ForecastInput {
  nowMs: number
  profile: TokenProfile
  rateState: RateState
  /** Все active ready_to_send jobs магазина, отсортированы по (wb_created_at ASC, created_at ASC). */
  readyJobs: Array<{ id: string; nextAttemptAtMs: number }>
  /** UTC час, когда cron делает daily sync (по умолчанию 7 = 07:00 UTC). */
  dailySyncUtcHour: number
}

export interface ForecastJob {
  id: string
  scheduledSendAtMs: number
  queuePosition: number
}

const JITTER_MS = 2_000 // ±2 сек, чтобы не все запросы уходили ровно в 12:00

function withJitter(baseMs: number): number {
  // Детерминированный jitter на основе времени (всё в окне 12 мин)
  const offset = (baseMs % (JITTER_MS * 2)) - JITTER_MS
  return baseMs + offset
}

function msToNextUtcHour(nowMs: number, utcHour: number): number {
  const d = new Date(nowMs)
  const next = new Date(Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    utcHour, 0, 0, 0,
  ))
  if (next.getTime() <= nowMs) {
    next.setUTCDate(next.getUTCDate() + 1)
  }
  return next.getTime()
}

/** Назначить ETA для ready jobs. Возвращает массив (тот же порядок). */
export function rebuildSendForecast(input: ForecastInput): ForecastJob[] {
  const profile: RateProfile = WB_RATE_PROFILES[input.profile]
  const interval = profile.minIntervalMs
  const dailySyncAt = msToNextUtcHour(input.nowMs, input.dailySyncUtcHour)

  let cursor = input.nowMs
  // Применяем rate limit к стартовой позиции
  cursor = nextAllowedAt(input.nowMs, input.profile, input.rateState, 0)

  const result: ForecastJob[] = []

  // Резервируем слот для daily sync если cursor в окне (dailySyncAt, dailySyncAt+interval)
  // или уже после daily sync в этом дне но до следующего слота
  const dailySyncWindowStart = dailySyncAt
  const dailySyncWindowEnd = dailySyncAt + interval
  if (cursor >= dailySyncWindowStart && cursor < dailySyncWindowEnd) {
    // cursor внутри окна daily sync — сдвигаем за него
    cursor = dailySyncWindowEnd
  } else if (cursor < dailySyncWindowStart && (input.nowMs + interval) > dailySyncWindowStart) {
    // cursor сейчас, но следующий слот попадёт в окно daily sync
    // сдвигаем за daily sync
    cursor = dailySyncWindowEnd
  }

  for (let i = 0; i < input.readyJobs.length; i++) {
    // nextAttemptAtMs у job может быть позже cursor (например, после ошибки)
    let scheduled = Math.max(cursor, input.readyJobs[i]!.nextAttemptAtMs)
    // Применяем interval ПЛЮС jitter
    scheduled = withJitter(scheduled + JITTER_MS) // небольшой сдвиг
    result.push({
      id: input.readyJobs[i]!.id,
      scheduledSendAtMs: scheduled,
      queuePosition: i + 1,
    })
    // Следующий слот — через interval
    cursor = scheduled + interval
  }

  return result
}

/** Подсчитать общее время, которое займёт публикация всех jobs. */
export function totalForecastDurationMs(profile: TokenProfile, jobCount: number): number {
  if (jobCount === 0) return 0
  const interval = WB_RATE_PROFILES[profile].minIntervalMs
  return interval * jobCount
}

// Приоритет операций WB. Один selectNextWbOperation возвращает ровно одну операцию.
// Никакого I/O — pure function, тестируется без моков.

import type { TokenProfile } from './types.js'
import { canSendNow, isDailyLimitReached, nextAllowedAt, type RateState } from './rate-policy.js'

/** Тип операции, которую мы хотим выполнить следующей. */
export type WbOperation =
  | { kind: 'daily_sync' }
  | { kind: 'reconcile'; jobId: string }
  | { kind: 'reply'; jobId: string }
  | { kind: 'fetch_next_page'; skip: number }
  | { kind: 'none' }

export interface OperationSelectorInput {
  nowMs: number
  profile: TokenProfile
  rateState: RateState
  /** UTC дата 'YYYY-MM-DD' (только для daily_sync_due). */
  todayUtc: string
  /** last_sync_day_utc магазина (или null). */
  lastSyncDayUtc: string | null
  /** Есть ли reconcile_pending jobs? */
  hasReconcileJobs: boolean
  /** Oldest ready_to_send job (или null). */
  oldestReadyJob: { id: string; nextAttemptAtMs: number } | null
  /** Должны ли мы fetch_next_page? (предыдущая страница вернула take=5000) */
  hasMorePages: boolean
  /** Текущий skip для pagination. */
  currentSkip: number
}

/** Выбрать следующую операцию по приоритету. */
export function selectNextWbOperation(input: OperationSelectorInput): WbOperation {
  // 1. daily_sync_due — самый высокий приоритет (1 раз в сутки)
  if (input.lastSyncDayUtc !== input.todayUtc) {
    return { kind: 'daily_sync' }
  }

  // 2. reconcile_unknown — доделываем то, что могло зависнуть
  if (input.hasReconcileJobs) {
    return { kind: 'reconcile', jobId: 'oldest' } // конкретный ID берёт coordinator
  }

  // 3. oldest ready_to_send (с учётом rate limit)
  if (input.oldestReadyJob) {
    const job = input.oldestReadyJob
    const check = canSendNow(input.nowMs, input.profile, input.rateState, 'ready_to_send', job.nextAttemptAtMs)
    if (check.allowed) {
      return { kind: 'reply', jobId: job.id }
    }
    // Rate limit не позволяет — попробуем later
    return { kind: 'none' }
  }

  // 4. next_feedback_page (если предыдущий sync вернул ровно take=5000)
  if (input.hasMorePages) {
    return { kind: 'fetch_next_page', skip: input.currentSkip + 5000 }
  }

  // 5. Нет задач
  return { kind: 'none' }
}

/** Хелпер: проверяет, нужен ли daily sync. */
export function isDailySyncDue(input: { nowMs: number; lastSyncDayUtc: string | null; todayUtc: string }): boolean {
  return input.lastSyncDayUtc !== input.todayUtc
}

/** Хелпер: можно ли вообще отправлять сегодня (daily limit). */
export function isDailyLimitReachedNow(profile: TokenProfile, count: number): boolean {
  return isDailyLimitReached(profile, count)
}

/** Хелпер: безопасная проверка rate (используется в логике "должен ли cron запускать WB"). */
export function rateLimitHeadroom(nowMs: number, profile: TokenProfile, state: RateState): {
  nextAllowedAtMs: number
  canDoNow: boolean
} {
  const next = nextAllowedAt(nowMs, profile, state, 0)
  return { nextAllowedAtMs: next, canDoNow: next <= nowMs }
}

// Rate policy — расчёт когда разрешён следующий WB-вызов.
// Pure function, не делает I/O.

import type { JobState, RateProfile, TokenProfile } from './types.js'
import { WB_RATE_PROFILES } from './types.js'

/** Время последнего WB-вызова (мс epoch). */
export interface RateState {
  lastWbRequestAtMs: number | null
  /** Cooldown после 429 до (мс epoch). */
  cooldownUntilMs: number
  /** Количество успешных reply за скользящие 24ч. */
  rollingDaySuccessCount: number
}

/** Рассчитать, когда разрешён следующий WB-вызов. */
export function nextAllowedAt(
  nowMs: number,
  profile: TokenProfile,
  state: RateState,
  jobNextAttemptAtMs: number = 0,
): number {
  const p: RateProfile = WB_RATE_PROFILES[profile]
  const intervalFromLast = state.lastWbRequestAtMs !== null
    ? state.lastWbRequestAtMs + p.minIntervalMs
    : 0
  return Math.max(nowMs, intervalFromLast, state.cooldownUntilMs, jobNextAttemptAtMs)
}

/** Превышен ли дневной safety-лимит. */
export function isDailyLimitReached(
  profile: TokenProfile,
  rollingDaySuccessCount: number,
): boolean {
  return rollingDaySuccessCount >= WB_RATE_PROFILES[profile].safeRepliesPerRollingDay
}

/** Можно ли отправить reply прямо сейчас. */
export function canSendNow(
  nowMs: number,
  profile: TokenProfile,
  state: RateState,
  jobState: JobState,
  jobNextAttemptAtMs: number = 0,
): { allowed: boolean; nextAllowedAtMs: number; reason: 'rate_limit' | 'daily_limit' | 'job_not_ready' | null } {
  if (jobState !== 'ready_to_send') {
    return { allowed: false, nextAllowedAtMs: 0, reason: 'job_not_ready' }
  }
  if (isDailyLimitReached(profile, state.rollingDaySuccessCount)) {
    return { allowed: false, nextAllowedAtMs: 0, reason: 'daily_limit' }
  }
  const next = nextAllowedAt(nowMs, profile, state, jobNextAttemptAtMs)
  if (next > nowMs) {
    return { allowed: false, nextAllowedAtMs: next, reason: 'rate_limit' }
  }
  return { allowed: true, nextAllowedAtMs: nowMs, reason: null }
}

/** Допустимое число операций в одном wake. */
export function maxOpsPerWake(profile: TokenProfile): number {
  return WB_RATE_PROFILES[profile].maxWbOpsPerWake
}

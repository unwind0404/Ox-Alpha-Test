// scripts/smoke-staging.ts
// Smoke-тест: fake-clock симуляция для проверки 12-минутных интервалов.

import { rebuildSendForecast, totalForecastDurationMs } from '../src/core/send-forecast.js'
import { WB_RATE_PROFILES } from '../src/core/types.js'

const T0 = 1_700_000_000_000 // 2023-11-14 22:13:20 UTC (просто для примера)

let failed = 0
function assert(name: string, condition: boolean, detail: string): void {
  const icon = condition ? '✅' : '❌'
  console.log(`${icon} ${name.padEnd(40)} ${detail}`)
  if (!condition) failed++
}

console.log('\n=== Smoke test: Basic profile (12 min interval) ===\n')

// Acceptance: 1 list + 100 replies >= 20 hours
const basicReplies = 100
const basicDuration = totalForecastDurationMs('basic', basicReplies)
const basicHours = basicDuration / 60 / 60_000
assert('basic 100 replies duration', basicHours >= 20 && basicHours <= 21, `${basicHours.toFixed(1)} hours`)

// Acceptance: 11 jobs → 10 интервалов по 12 мин = 120 мин (НЕ 132)
const jobs = Array.from({ length: 11 }, (_, i) => ({
  id: `j${i}`,
  nextAttemptAtMs: 0,
}))
const forecast = rebuildSendForecast({
  nowMs: T0,
  profile: 'basic',
  rateState: { lastWbRequestAtMs: null, cooldownUntilMs: 0, rollingDaySuccessCount: 0 },
  readyJobs: jobs,
  dailySyncUtcHour: 7,
})
assert('11 jobs forecast count', forecast.length === 11, `${forecast.length} jobs`)
const spanMin = (forecast[10]!.scheduledSendAtMs - forecast[0]!.scheduledSendAtMs) / 60_000
assert('11 jobs span ~120 min', spanMin >= 118 && spanMin <= 122, `${spanMin.toFixed(1)} min`)

// Acceptance: 101-я reply НЕ влезает в сутки (для basic 100/day limit)
assert('100/day limit', WB_RATE_PROFILES.basic.safeRepliesPerRollingDay === 100, '')

console.log('\n=== Smoke test: Personal profile (400 ms interval) ===\n')

// Acceptance: 10 replies within ~5 sec
const personalJobs = Array.from({ length: 10 }, (_, i) => ({
  id: `pj${i}`,
  nextAttemptAtMs: 0,
}))
const personalForecast = rebuildSendForecast({
  nowMs: T0,
  profile: 'personal',
  rateState: { lastWbRequestAtMs: null, cooldownUntilMs: 0, rollingDaySuccessCount: 0 },
  readyJobs: personalJobs,
  dailySyncUtcHour: 7,
})
const personalSpan = (personalForecast[9]!.scheduledSendAtMs - personalForecast[0]!.scheduledSendAtMs) / 1000
assert('10 jobs span < 60 sec', personalSpan < 60, `${personalSpan.toFixed(1)} sec`)

console.log()
if (failed > 0) {
  console.log(`❌ ${failed} smoke check(s) failed\n`)
  process.exit(1)
}
console.log(`✅ All smoke checks passed\n`)

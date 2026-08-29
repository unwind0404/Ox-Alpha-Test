// Clock port — реальное время или fake для тестов.

export interface ClockPort {
  nowMs(): number
}

/** Реальные часы (UTC epoch). */
export const systemClock: ClockPort = {
  nowMs: () => Date.now(),
}

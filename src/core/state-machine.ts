// State machine — чистая функция для проверки допустимости переходов.

import { ALLOWED_TRANSITIONS, type JobState } from './types.js'

/** Можно ли перейти из `from` в `to`? */
export function canTransition(from: JobState, to: JobState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

/** Бросить ошибку при недопустимом переходе. */
export function assertTransition(from: JobState, to: JobState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Недопустимый переход: ${from} → ${to}. Допустимо: ${ALLOWED_TRANSITIONS[from].join(', ')}`)
  }
}

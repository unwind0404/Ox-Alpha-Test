// Проверка token matrix: только разрешённые комбинации (deployment × profile).
// Источник: plan §1.3, Task 13.

import { describe, it, expect } from 'vitest'
import { ALLOWED_MATRIX, isTokenAllowed } from '../../src/core/types.js'

describe('token matrix: fail-closed', () => {
  it('ALLOWED_MATRIX содержит ровно 2 комбинации', () => {
    expect(ALLOWED_MATRIX).toHaveLength(2)
  })

  it('cloud + basic — разрешено', () => {
    expect(isTokenAllowed('cloud', 'basic')).toBe(true)
  })

  it('cloud + personal — ЗАПРЕЩЕНО (WB ToS)', () => {
    expect(isTokenAllowed('cloud', 'personal')).toBe(false)
  })

  it('cloud + service — ЗАПРЕЩЕНО', () => {
    expect(isTokenAllowed('cloud', 'service')).toBe(false)
  })

  it('self_managed + personal — разрешено', () => {
    expect(isTokenAllowed('self_managed', 'personal')).toBe(true)
  })

  it('self_managed + basic — ЗАПРЕЩЕНО (production profile)', () => {
    expect(isTokenAllowed('self_managed', 'basic')).toBe(false)
  })

  it('self_managed + service — ЗАПРЕЩЕНО', () => {
    expect(isTokenAllowed('self_managed', 'service')).toBe(false)
  })
})

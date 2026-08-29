import { describe, it, expect } from 'vitest'
import { isAllowedWbHost, assertAllowedWbUrl } from '../../src/adapters/wb/allowlist.js'

describe('wb/allowlist', () => {
  it('production host — allowed', () => {
    expect(isAllowedWbHost('feedbacks-api.wildberries.ru')).toBe(true)
  })

  it('sandbox host — allowed', () => {
    expect(isAllowedWbHost('feedbacks-api-sandbox.wildberries.ru')).toBe(true)
  })

  it('неизвестный host — blocked', () => {
    expect(isAllowedWbHost('evil.com')).toBe(false)
    expect(isAllowedWbHost('localhost')).toBe(false)
    expect(isAllowedWbHost('feedbacks-api.wildberries.ru.evil.com')).toBe(false)
  })

  it('assertAllowedWbUrl для allowed — OK', () => {
    expect(() => assertAllowedWbUrl('https://feedbacks-api.wildberries.ru/api/v1/feedbacks')).not.toThrow()
  })

  it('assertAllowedWbUrl для evil — throw', () => {
    expect(() => assertAllowedWbUrl('https://evil.com/steal-token')).toThrow(/not in allowlist/)
  })
})

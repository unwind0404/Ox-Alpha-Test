import { describe, it, expect } from 'vitest'
import { parseRateHeaders } from '../../src/adapters/wb/rate-headers.js'

function makeResponse(headers: Record<string, string>): Response {
  return new Response(null, { headers })
}

describe('wb/rate-headers: parseRateHeaders', () => {
  it('пустые headers — все null', () => {
    const r = parseRateHeaders(makeResponse({}))
    expect(r.retryAfterSec).toBe(null)
    expect(r.resetAtMs).toBe(null)
    expect(r.remaining).toBe(null)
  })

  it('X-RateLimit-Retry: 720', () => {
    const r = parseRateHeaders(makeResponse({ 'X-RateLimit-Retry': '720' }))
    expect(r.retryAfterSec).toBe(720)
  })

  it('X-RateLimit-Retry: invalid — null', () => {
    const r = parseRateHeaders(makeResponse({ 'X-RateLimit-Retry': 'foo' }))
    expect(r.retryAfterSec).toBe(null)
  })

  it('X-RateLimit-Reset: epoch seconds → ms', () => {
    const epochSec = 1735689600
    const r = parseRateHeaders(makeResponse({ 'X-RateLimit-Reset': String(epochSec) }))
    expect(r.resetAtMs).toBe(epochSec * 1000)
  })

  it('X-RateLimit-Reset: epoch ms (если > 1e12) — as is', () => {
    const epochMs = 1735689600000
    const r = parseRateHeaders(makeResponse({ 'X-RateLimit-Reset': String(epochMs) }))
    expect(r.resetAtMs).toBe(epochMs)
  })

  it('X-RateLimit-Remaining: 42', () => {
    const r = parseRateHeaders(makeResponse({ 'X-RateLimit-Remaining': '42' }))
    expect(r.remaining).toBe(42)
  })

  it('X-RateLimit-Remaining: 3.7 (дробное) — floor', () => {
    const r = parseRateHeaders(makeResponse({ 'X-RateLimit-Remaining': '3.7' }))
    expect(r.remaining).toBe(3)
  })
})

// Тест для access-auth: pure logic, без реального Cloudflare.
// Проверяет что headers правильно парсятся, и в dev-режиме auth пропускается.

import { describe, it, expect } from 'vitest'
import { requireAccess, AccessError } from '../../src/adapters/cloudflare/access-auth.js'

const prodEnv = {
  ACCESS_CLIENT_ID: 'cid-123',
  ACCESS_CLIENT_SECRET: 'sec-abc',
  ENVIRONMENT: 'production',
}

const devEnvNoSecrets = {
  ACCESS_CLIENT_ID: '',
  ACCESS_CLIENT_SECRET: '',
  ENVIRONMENT: 'dev',
}

const ctx = {} as Parameters<typeof requireAccess>[2]

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://example.com/api/test', { headers })
}

describe('access-auth: production mode', () => {
  it('валидный Service Token — пускает', () => {
    const req = makeRequest({
      'Cf-Access-Client-Id': 'cid-123',
      'Cf-Access-Client-Secret': 'sec-abc',
    })
    const id = requireAccess(req, prodEnv, ctx)
    expect(id.kind).toBe('service')
    expect(id.clientId).toBe('cid-123')
  })

  it('нет headers — 401', () => {
    const req = makeRequest()
    expect(() => requireAccess(req, prodEnv, ctx)).toThrow(AccessError)
    try {
      requireAccess(req, prodEnv, ctx)
    } catch (e) {
      expect((e as AccessError).status).toBe(401)
    }
  })

  it('только Client-Id без Secret — 401', () => {
    const req = makeRequest({ 'Cf-Access-Client-Id': 'cid-123' })
    expect(() => requireAccess(req, prodEnv, ctx)).toThrow(AccessError)
  })

  it('неверный Secret — 403', () => {
    const req = makeRequest({
      'Cf-Access-Client-Id': 'cid-123',
      'Cf-Access-Client-Secret': 'WRONG',
    })
    expect(() => requireAccess(req, prodEnv, ctx)).toThrow(AccessError)
    try {
      requireAccess(req, prodEnv, ctx)
    } catch (e) {
      expect((e as AccessError).status).toBe(403)
    }
  })

  it('неверный Client-Id — 403', () => {
    const req = makeRequest({
      'Cf-Access-Client-Id': 'WRONG',
      'Cf-Access-Client-Secret': 'sec-abc',
    })
    expect(() => requireAccess(req, prodEnv, ctx)).toThrow(AccessError)
  })
})

describe('access-auth: dev mode без секретов', () => {
  it('пропускает без headers (с warning)', () => {
    const req = makeRequest()
    const id = requireAccess(req, devEnvNoSecrets, ctx)
    expect(id.kind).toBe('dev')
    expect(id.clientId).toBe('dev')
  })

  it('даже с headers всё равно dev', () => {
    const req = makeRequest({
      'Cf-Access-Client-Id': 'whatever',
      'Cf-Access-Client-Secret': 'whatever',
    })
    const id = requireAccess(req, devEnvNoSecrets, ctx)
    expect(id.kind).toBe('dev')
  })
})

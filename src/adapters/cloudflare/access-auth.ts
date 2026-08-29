// Cloudflare Access authentication через Service Token.
// Header-форма: Cf-Access-Client-Id + Cf-Access-Client-Secret.
// В dev (wrangler dev) токены пустые — auth пропускается (warning).
// В production — обязательны и проверяются.

import type { ExecutionContext } from '@cloudflare/workers-types'

/** Environment vars. */
export interface AccessEnv {
  /** Service Token Client ID. */
  ACCESS_CLIENT_ID: string
  /** Service Token Client Secret. */
  ACCESS_CLIENT_SECRET: string
  /** Если 'dev' — auth пропускается с warning. */
  ENVIRONMENT: string
}

export interface AccessIdentity {
  /** ID сервис-токена. */
  clientId: string
  /** 'service' для Service Token, 'dev' для dev-режима. */
  kind: 'service' | 'dev'
}

export class AccessError extends Error {
  constructor(
    public readonly status: 401 | 403,
    message: string,
  ) {
    super(message)
    this.name = 'AccessError'
  }
}

/** Извлечь identity из request headers. Бросает AccessError если невалидно. */
export function requireAccess(request: Request, env: AccessEnv, _ctx: ExecutionContext): AccessIdentity {
  const isDev = env.ENVIRONMENT === 'dev'
  const hasSecrets = Boolean(env.ACCESS_CLIENT_ID && env.ACCESS_CLIENT_SECRET)

  // Dev-режим без секретов: пускаем всех, но помечаем в лог
  if (isDev && !hasSecrets) {
    console.warn('[access] DEV mode without secrets — skipping auth')
    return { clientId: 'dev', kind: 'dev' }
  }

  const clientId = request.headers.get('Cf-Access-Client-Id') ?? ''
  const clientSecret = request.headers.get('Cf-Access-Client-Secret') ?? ''

  if (!clientId || !clientSecret) {
    throw new AccessError(401, 'Cloudflare Access headers missing')
  }

  if (clientId !== env.ACCESS_CLIENT_ID || clientSecret !== env.ACCESS_CLIENT_SECRET) {
    throw new AccessError(403, 'Cloudflare Access token invalid')
  }

  return { clientId, kind: 'service' }
}

/** Security headers для всех ответов Worker. */
export function securityHeaders(): HeadersInit {
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "img-src 'self' https: data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Cache-Control': 'no-store',
  }
}

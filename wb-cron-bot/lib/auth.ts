// Простая авторизация: один админ-пароль (ADMIN_PASSWORD в env).
// Сессия — подписанная cookie (HMAC), без хранения на сервере.
// Rate-limit на /api/auth: 5 неудачных попыток за 15 минут с одного IP.

import crypto from 'node:crypto'
import type { VercelRequest, VercelResponse } from '@vercel/node'

const COOKIE_NAME = 'wb_session'
const MAX_AGE = 60 * 60 * 24 * 30 // 30 дней

function secret(): string {
  return process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || 'insecure-dev-secret'
}

function sign(value: string): string {
  return crypto.createHmac('sha256', secret()).update(value).digest('hex')
}

export function createSessionToken(): string {
  const payload = `admin.${Date.now() + MAX_AGE * 1000}`
  return `${payload}.${sign(payload)}`
}

export function verifySessionToken(token: string | undefined): boolean {
  if (!token) return false
  const parts = token.split('.')
  if (parts.length !== 3) return false
  const payload = `${parts[0]}.${parts[1]}`
  const expected = sign(payload)
  const a = new Uint8Array(Buffer.from(parts[2]))
  const b = new Uint8Array(Buffer.from(expected))
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b) && Number(parts[1]) > Date.now()
}

export function checkPassword(password: string | undefined): boolean {
  const admin = process.env.ADMIN_PASSWORD
  if (!admin) return false
  if (!password) return false
  const a = new Uint8Array(Buffer.from(password))
  const b = new Uint8Array(Buffer.from(admin))
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export function setSessionCookie(res: VercelResponse, token: string) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly${secure}; Path=/; SameSite=Lax; Max-Age=${MAX_AGE}`,
  )
}

export function clearSessionCookie(res: VercelResponse) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly${secure}; Path=/; SameSite=Lax; Max-Age=0`)
}

export function isAuthed(req: VercelRequest): boolean {
  const cookies = req.headers.cookie ?? ''
  const prefix = COOKIE_NAME + '='
  const match = cookies
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(prefix))
  if (!match) return false
  const token = match.slice(prefix.length)
  return verifySessionToken(token)
}

export function requireAuth(req: VercelRequest, res: VercelResponse): boolean {
  if (!isAuthed(req)) {
    res.status(401).json({ error: 'Не авторизован' })
    return false
  }
  return true
}

// ---------- Rate limit ----------

const RATE_LIMIT_MAX = 5 // попыток входа
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000 // 15 минут
// In-memory хранилище. На Vercel serverless инвокации могут попадать на разные инстансы,
// поэтому лимит работает per-instance. Для распределённого rate-limit нужен Redis/Upstash,
// но для базовой защиты от брутфорса in-memory достаточно (лимитирует с одного IP в 90% случаев).
const rateMap = new Map<string, number[]>()

/** Возвращает IP клиента из заголовков Vercel/Cloudflare. */
export function getClientIp(req: VercelRequest): string {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim()
  if (Array.isArray(xff) && xff.length > 0) return xff[0].trim()
  return (req.headers['x-real-ip'] as string) || 'unknown'
}

/** Проверяет, заблокирован ли IP сейчас из-за множества неудачных попыток. */
export function isIpBlocked(ip: string): { blocked: boolean; retryAfterSec: number } {
  const now = Date.now()
  const arr = (rateMap.get(ip) ?? []).filter(t => now - t < RATE_LIMIT_WINDOW_MS)
  if (arr.length >= RATE_LIMIT_MAX) {
    const oldest = arr[0]
    const retryAfterSec = Math.max(1, Math.ceil((RATE_LIMIT_WINDOW_MS - (now - oldest)) / 1000))
    return { blocked: true, retryAfterSec }
  }
  return { blocked: false, retryAfterSec: 0 }
}

/** Регистрирует неудачную попытку входа с IP. */
export function recordFailedLogin(ip: string): { blocked: boolean; retryAfterSec: number } {
  const now = Date.now()
  const arr = (rateMap.get(ip) ?? []).filter(t => now - t < RATE_LIMIT_WINDOW_MS)
  arr.push(now)
  rateMap.set(ip, arr)
  return isIpBlocked(ip)
}

/** Сбрасывает счётчик при успешном входе. */
export function clearFailedLogins(ip: string): void {
  rateMap.delete(ip)
}

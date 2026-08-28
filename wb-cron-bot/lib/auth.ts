// Простая авторизация: один админ-пароль (ADMIN_PASSWORD в env).
// Сессия — подписанная cookie (HMAC), без хранения на сервере.

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

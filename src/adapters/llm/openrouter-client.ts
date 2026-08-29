// LLM client через OpenRouter API.
// - Системный промпт (жестко задан, не из данных)
// - Данные отзыва — в user message, помечены как untrusted
// - max_tokens для short response (2-4 предложения)
// - Output gate на ВЕСЬ ответ перед возвратом

import { validateReply } from '../../core/output-gate.js'

export interface LlmEnv {
  OPENROUTER_API_KEY: string
  LLM_MODEL?: string
  LLM_FALLBACK_MODEL?: string
}

export interface ReviewInput {
  rating: number | null
  text: string | null
  pros: string | null
  cons: string | null
  productName: string | null
  userName: string | null
  instructions: string | null // из БД, в начало промпта (ЖЁСТКИЕ ПРАВИЛА)
}

export type LlmError =
  | { kind: 'http'; status: number; body: string }
  | { kind: 'parse'; message: string }
  | { kind: 'gate'; message: string }
  | { kind: 'empty' }
  | { kind: 'rate_limit'; retryAfterSec: number }
  | { kind: 'network'; message: string }

export type LlmResult =
  | { ok: true; text: string; source: 'llm' | 'fallback' }
  | { ok: false; error: LlmError }

const DEFAULT_MODEL = 'minimax/minimax-m3:free'
const DEFAULT_FALLBACK = 'minimax/minimax-m2.7:free'
const API_URL = 'https://openrouter.ai/api/v1/chat/completions'
const REQUEST_TIMEOUT_MS = 25_000
const MAX_TOKENS = 300

/** Системный промпт — НЕ из данных отзыва, фиксированный. */
function buildSystemPrompt(): string {
  return [
    'Ты — сотрудник поддержки интернет-магазина на Wildberries.',
    'Напиши ответ на отзыв покупателя от лица магазина.',
    '',
    'Правила:',
    '- Пиши только текст ответа, без кавычек и пояснений.',
    '- Обращайся на «Вы».',
    '- Длина: 2–4 предложения.',
    '- Не упоминай URL, email, телефоны, промокоды, компенсации, юридические обещания.',
    '- Не используй HTML-теги.',
    '- Будь вежлив и конкретен.',
  ].join('\n')
}

/** User message — данные отзыва (untrusted). */
function buildUserMessage(input: ReviewInput): string {
  const parts: string[] = []
  if (input.instructions && input.instructions.trim()) {
    parts.push('⚠️ ЖЁСТКИЕ ПРАВИЛА ОТ ПРОДАВЦА:')
    parts.push(input.instructions.trim())
    parts.push('')
  }
  parts.push(`Отзыв (оценка ${input.rating ?? '?'} из 5):`)
  if (input.text) parts.push(input.text)
  if (input.pros) parts.push(`Плюсы: ${input.pros}`)
  if (input.cons) parts.push(`Минусы: ${input.cons}`)
  if (input.userName) parts.push(`Имя покупателя: ${input.userName}`)
  if (input.productName) parts.push(`Товар: ${input.productName}`)
  return parts.join('\n')
}

async function callOne(model: string, input: ReviewInput, env: LlmEnv, signal: AbortSignal): Promise<LlmResult> {
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://wb-cron-bot.vercel.app',
        'X-Title': 'WB Review Bot',
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: buildUserMessage(input) },
        ],
      }),
      signal,
    })

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('X-RateLimit-Retry') ?? '900')
      return { ok: false, error: { kind: 'rate_limit', retryAfterSec: Number.isFinite(retryAfter) ? retryAfter : 900 } }
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, error: { kind: 'http', status: res.status, body: body.slice(0, 300) } }
    }

    const json = await res.json().catch((e): null => {
      void e
      return null
    })
    if (!json) {
      return { ok: false, error: { kind: 'parse', message: 'invalid JSON' } }
    }
    const content = (json as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || content.length === 0) {
      return { ok: false, error: { kind: 'empty' } }
    }
    return { ok: true, text: content.trim(), source: model === (env.LLM_MODEL ?? DEFAULT_MODEL) ? 'llm' : 'fallback' }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      return { ok: false, error: { kind: 'network', message: 'timeout' } }
    }
    return { ok: false, error: { kind: 'network', message: (e as Error).message } }
  }
}

/** Сгенерировать ответ через LLM (с output gate). */
export async function generateLlmReply(input: ReviewInput, env: LlmEnv): Promise<LlmResult> {
  const primary = env.LLM_MODEL ?? DEFAULT_MODEL
  const fallback = env.LLM_FALLBACK_MODEL ?? DEFAULT_FALLBACK

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    // Сначала основная модель
    const r1 = await callOne(primary, input, env, controller.signal)
    if (r1.ok) {
      const gate = validateReply(r1.text)
      if (gate.ok) return { ok: true, text: gate.text, source: r1.source }
      // Output gate не прошёл — НЕ пробуем fallback с этим же текстом, retry не поможет
      return { ok: false, error: { kind: 'gate', message: `primary output failed gate: ${gate.error.kind}` } }
    }
    if (r1.error.kind === 'rate_limit') {
      return r1 // сразу выдаём 429
    }
    if (r1.error.kind === 'gate') {
      return r1 // output gate fail — не retry
    }

    // Если основная не сработала по другой причине (http/network/parse) — пробуем fallback
    if (primary !== fallback) {
      const r2 = await callOne(fallback, input, env, controller.signal)
      if (r2.ok) {
        const gate = validateReply(r2.text)
        if (gate.ok) return { ok: true, text: gate.text, source: 'fallback' }
        return { ok: false, error: { kind: 'gate', message: `fallback output failed gate: ${gate.error.kind}` } }
      }
      return r2
    }
    return r1
  } finally {
    clearTimeout(timeoutId)
  }
}

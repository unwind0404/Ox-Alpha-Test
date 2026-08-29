// output-gate: валидация ответа LLM перед отправкой на WB.
// Запреты:
// - length 2..5000 Unicode code points (WB limit)
// - URLs (http/https/ftp, без wb-allowed)
// - emails
// - телефоны (разные форматы)
// - HTML tags
// - промокоды (опционально)
// - юридические обещания
// - оскорбления (минимум)


export const MIN_REPLY_LENGTH = 2
export const MAX_REPLY_LENGTH = 5000

// Разрешённые домены для ссылок (WB и его CDN). Если есть URL с другим доменом — fail.
const ALLOWED_DOMAINS: ReadonlyArray<string> = [
  'wildberries.ru',
  'wb.ru',
  'wbcnt.ru',
  'static.wbstatic.net',
  'images.wbstatic.net',
]

/** Категория ошибки. */
export type GateError =
  | { kind: 'too_short'; length: number; min: number }
  | { kind: 'too_long'; length: number; max: number }
  | { kind: 'forbidden_url'; url: string; domain: string }
  | { kind: 'forbidden_email'; email: string }
  | { kind: 'forbidden_phone'; phone: string }
  | { kind: 'forbidden_html'; tag: string }
  | { kind: 'forbidden_promise'; phrase: string }
  | { kind: 'forbidden_word'; word: string }
  | { kind: 'empty' }

export type GateResult =
  | { ok: true; text: string }
  | { ok: false; error: GateError }

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi
const EMAIL_PATTERN = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g
// Телефоны: +7/8/+, с пробелами и без
const PHONE_PATTERN = /(?:\+?\d[\s\-().]*){7,}/g
const HTML_TAG_PATTERN = /<\/?[a-z][a-z0-9]*\b[^>]*>/gi

const FORBIDDEN_PROMISES: RegExp[] = [
  // TODO: русские варианты "вернём" с ё (JS RegExp \b не работает с Unicode boundary)
  /верн\S+\s+деньги/i, // вернём/вернём/вернём/вернуть → деньги
  /возвратим\s+деньги/i,
  /возврат\s+средств/i,
  /компенсац\S+/i,
  /гарантируем?\s+возврат/i,
  /полный\s+возврат/i,
  /верн\S+\s+100%/i,
]

// Минимальный список — расширяется по фидбеку безопасника
const FORBIDDEN_WORDS: RegExp[] = [
  /(?:дурак|идиот|тупой|урод)/i,
]

/** Валидация ответа LLM. */
export function validateReply(text: string): GateResult {
  const trimmed = text.trim()

  if (trimmed.length === 0) {
    return { ok: false, error: { kind: 'empty' } }
  }

  // Length считаем в Unicode code points (WB — 2..5000)
  const length = Array.from(trimmed).length
  if (length < MIN_REPLY_LENGTH) {
    return { ok: false, error: { kind: 'too_short', length, min: MIN_REPLY_LENGTH } }
  }
  if (length > MAX_REPLY_LENGTH) {
    return { ok: false, error: { kind: 'too_long', length, max: MAX_REPLY_LENGTH } }
  }

  // URLs
  const urlMatch = trimmed.match(URL_PATTERN)
  if (urlMatch) {
    for (const url of urlMatch) {
      const domain = extractDomain(url)
      if (domain && !isAllowedDomain(domain)) {
        return { ok: false, error: { kind: 'forbidden_url', url, domain } }
      }
    }
  }

  // Emails
  const emailMatch = trimmed.match(EMAIL_PATTERN)
  if (emailMatch && emailMatch.length > 0) {
    return { ok: false, error: { kind: 'forbidden_email', email: emailMatch[0]! } }
  }

  // Phones
  const phoneMatch = trimmed.match(PHONE_PATTERN)
  if (phoneMatch) {
    // Проверяем что это не случайно цифры (требуем хотя бы 10 цифр подряд)
    for (const phone of phoneMatch) {
      const digitsOnly = phone.replace(/\D/g, '')
      if (digitsOnly.length >= 10) {
        return { ok: false, error: { kind: 'forbidden_phone', phone: phone.trim() } }
      }
    }
  }

  // HTML
  const htmlMatch = trimmed.match(HTML_TAG_PATTERN)
  if (htmlMatch) {
    return { ok: false, error: { kind: 'forbidden_html', tag: htmlMatch[0]! } }
  }

  // Promises
  for (const pattern of FORBIDDEN_PROMISES) {
    if (pattern.test(trimmed)) {
      return { ok: false, error: { kind: 'forbidden_promise', phrase: pattern.source } }
    }
  }

  // Insults
  for (const pattern of FORBIDDEN_WORDS) {
    if (pattern.test(trimmed)) {
      return { ok: false, error: { kind: 'forbidden_word', word: pattern.source } }
    }
  }

  return { ok: true, text: trimmed }
}

/** Извлечь домен из URL. */
function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** Домен в allowlist? */
function isAllowedDomain(domain: string): boolean {
  for (const allowed of ALLOWED_DOMAINS) {
    if (domain === allowed || domain.endsWith('.' + allowed)) {
      return true
    }
  }
  return false
}

/** Человеческое описание ошибки. */
export function formatGateError(error: GateError): string {
  switch (error.kind) {
    case 'too_short': return `Слишком короткий ответ (${error.length} < ${error.min})`
    case 'too_long': return `Слишком длинный ответ (${error.length} > ${error.max})`
    case 'forbidden_url': return `Запрещённый URL: ${error.domain}`
    case 'forbidden_email': return `Email в ответе: ${error.email}`
    case 'forbidden_phone': return `Телефон в ответе: ${error.phone}`
    case 'forbidden_html': return `HTML-тег: ${error.tag}`
    case 'forbidden_promise': return `Запрещённое обещание: ${error.phrase}`
    case 'forbidden_word': return `Запрещённое слово: ${error.word}`
    case 'empty': return 'Пустой ответ'
  }
}

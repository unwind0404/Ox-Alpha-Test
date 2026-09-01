// scripts/add-shop.ts
// Добавить магазин в D1 с зашифрованным WB-токеном.
// Запуск: npx tsx scripts/add-shop.ts <wb_account_key> <wb_basic_token>

import { readFileSync, existsSync } from 'node:fs'
import postgres from 'postgres'

// Генерируем client (зашифрованный) — нужны MASTER_KEY + FINGERPRINT_KEY
// Из .dev.vars (для локальной разработки) или process.env (для CI)
function readEnv(): Record<string, string> {
  if (existsSync('.dev.vars')) {
    const content = readFileSync('.dev.vars', 'utf-8')
    const env: Record<string, string> = {}
    for (const line of content.split('\n')) {
      const m = /^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/.exec(line.trim())
      if (m && m[1] && m[2]) env[m[1]] = m[2]
    }
    return env
  }
  return process.env as Record<string, string>
}

// AES-256-GCM encrypt через Web Crypto (Node 19+)
async function encryptToken(plaintext: string, masterKey: string, fingerprintKey: string): Promise<{
  ciphertext: string
  iv: string
  fingerprint: string
  keyVersion: number
}> {
  const masterBytes = Buffer.from(masterKey, 'base64')
  if (masterBytes.length !== 32) throw new Error('MASTER_KEY must be 32 bytes (256 bits)')

  const masterKeyObj = await crypto.subtle.importKey('raw', masterBytes, { name: 'AES-GCM' }, false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new TextEncoder().encode(plaintext)
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv), additionalData: new TextEncoder().encode('wb-bot:shop-token:v1') },
    masterKeyObj,
    new Uint8Array(data),
  )

  const fpBytes = Buffer.from(fingerprintKey, 'base64')
  const fpKey = await crypto.subtle.importKey('raw', fpBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', fpKey, new Uint8Array(data))
  const fingerprint = Buffer.from(sig).toString('hex')

  return {
    ciphertext: Buffer.from(ct).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
    fingerprint,
    keyVersion: 1,
  }
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

async function main() {
  const wbAccountKey = process.argv[2]
  const wbToken = process.argv[3]
  const shopName = process.argv[4] ?? 'Test Shop'
  const mode = (process.argv[5] ?? 'drafts') as 'templates' | 'drafts' | 'llm'

  if (!wbAccountKey || !wbToken) {
    console.error('Использование: npx tsx scripts/add-shop.ts <wb_account_key> <wb_basic_token> [shop_name] [mode]')
    process.exit(1)
  }

  const env = readEnv()
  const masterKey = env.MASTER_KEY
  const fingerprintKey = env.FINGERPRINT_KEY
  const databaseUrl = env.DATABASE_URL

  if (!masterKey || !fingerprintKey) {
    console.error('MASTER_KEY и FINGERPRINT_KEY обязательны (в .dev.vars или env)')
    process.exit(1)
  }
  if (!databaseUrl) {
    console.error('DATABASE_URL обязателен (для прямого подключения к D1)')
    process.exit(1)
  }

  console.log('Шифрую токен...')
  const enc = await encryptToken(wbToken, masterKey, fingerprintKey)
  const shopId = crypto.randomUUID()
  const now = Date.now()

  console.log('Подключаюсь к D1...')
  const sql = postgres(databaseUrl, { ssl: 'require', max: 1 })
  try {
    // Проверим что такого wb_account_key ещё нет
    const existing = await sql`SELECT id FROM shops WHERE wb_account_key = ${wbAccountKey}`
    if (existing.length > 0) {
      console.error(`Магазин с wb_account_key="${wbAccountKey}" уже существует: ${existing[0].id}`)
      process.exit(1)
    }

    await sql`INSERT INTO shops (
      id, name, wb_account_key,
      token_ciphertext, token_iv, token_key_version, token_fingerprint,
      token_profile, deployment_mode,
      mode, enabled,
      last_sync_day_utc, next_sync_at,
      token_expires_at,
      disabled_reason,
      created_at_ms, updated_at_ms
    ) VALUES (
      ${shopId}, ${shopName}, ${wbAccountKey},
      ${enc.ciphertext}, ${enc.iv}, ${enc.keyVersion}, ${enc.fingerprint},
      'basic', 'cloud',
      ${mode}, 0,
      NULL, ${now},
      NULL,
      'shadow mode (initial setup)',
      ${now}, ${now}
    )`
    console.log(`✅ Магазин создан: id=${shopId}`)
    console.log(`   wb_account_key: ${wbAccountKey}`)
    console.log(`   name: ${shopName}`)
    console.log(`   mode: ${mode}`)
    console.log(`   enabled: 0 (shadow mode)`)
    console.log(`   token_fingerprint: ${enc.fingerprint.slice(0, 16)}...`)
  } finally {
    await sql.end({ timeout: 1 })
  }
}

main().catch((e) => {
  console.error('Ошибка:', e)
  process.exit(1)
})

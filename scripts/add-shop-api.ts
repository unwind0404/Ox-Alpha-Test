// scripts/add-shop-api.ts
// Добавить магазин через Cloudflare API (без прямого postgres-коннекта).
// Использует D1 HTTP API для INSERT.
// Запуск: CLOUDFLARE_API_TOKEN=... npx tsx scripts/add-shop-api.ts <wb_account_key> <wb_basic_token> [shop_name] [mode]

import { readFileSync, existsSync } from 'node:fs'

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

async function encryptToken(plaintext: string, masterKey: string, fingerprintKey: string): Promise<{
  ciphertext: string
  iv: string
  fingerprint: string
}> {
  const masterBytes = Buffer.from(masterKey, 'base64')
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
  return {
    ciphertext: Buffer.from(ct).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
    fingerprint: Buffer.from(sig).toString('hex'),
  }
}

async function d1Exec(accountId: string, dbId: string, sql: string, params: unknown[], apiToken: string): Promise<{ success: boolean; result?: unknown; error?: string }> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}/query`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }),
    },
  )
  return (await res.json()) as { success: boolean; result?: unknown; error?: string }
}

async function main() {
  const wbAccountKey = process.argv[2]
  const wbToken = process.argv[3]
  const shopName = process.argv[4] ?? 'Test Shop'
  const mode = (process.argv[5] ?? 'drafts') as 'templates' | 'drafts' | 'llm'

  if (!wbAccountKey || !wbToken) {
    console.error('Использование: CLOUDFLARE_API_TOKEN=... npx tsx scripts/add-shop-api.ts <wb_account_key> <wb_basic_token> [shop_name] [mode]')
    process.exit(1)
  }

  const env = { ...readEnv(), ...process.env }
  const apiToken = env.CLOUDFLARE_API_TOKEN
  const masterKey = env.MASTER_KEY
  const fingerprintKey = env.FINGERPRINT_KEY
  const accountId = env.CLOUDFLARE_ACCOUNT_ID
  const dbId = env.D1_DATABASE_ID

  if (!apiToken || !masterKey || !fingerprintKey || !accountId || !dbId) {
    console.error('Нужны env: CLOUDFLARE_API_TOKEN, MASTER_KEY, FINGERPRINT_KEY, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID')
    process.exit(1)
  }

  console.log('Шифрую токен...')
  const enc = await encryptToken(wbToken, masterKey, fingerprintKey)
  const shopId = crypto.randomUUID()
  const now = Date.now()

  console.log('INSERT в D1...')
  const sql = `INSERT INTO shops (
    id, name, wb_account_key,
    token_ciphertext, token_iv, token_key_version, token_fingerprint,
    token_profile, deployment_mode,
    mode, enabled,
    last_sync_day_utc, next_sync_at,
    token_expires_at,
    disabled_reason,
    created_at_ms, updated_at_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'basic', 'cloud', ?, 0, NULL, ?, NULL, 'shadow mode', ?, ?)`
  const params = [
    shopId, shopName, wbAccountKey,
    enc.ciphertext, enc.iv, 1, enc.fingerprint,
    mode,
    now,
    now, now,
  ]

  const r = await d1Exec(accountId, dbId, sql, params, apiToken)
  if (!r.success) {
    console.error('D1 error:', r.error ?? JSON.stringify(r))
    process.exit(1)
  }
  console.log(`✅ Магазин создан: id=${shopId}`)
  console.log(`   wb_account_key: ${wbAccountKey}`)
  console.log(`   name: ${shopName}`)
  console.log(`   mode: ${mode}`)
  console.log(`   enabled: 0 (shadow mode)`)
  console.log(`   token_fingerprint: ${enc.fingerprint.slice(0, 16)}...`)
}

main().catch((e) => {
  console.error('Ошибка:', e)
  process.exit(1)
})

// Чистый Node-скрипт: шифрует токен и вставляет через D1 HTTP API.
// Запуск: node scripts/test-add-shop-via-api.mjs

import { readFileSync, existsSync } from 'node:fs'

// Читаем env из .dev.vars
function readEnv() {
  if (!existsSync('.dev.vars')) {
    console.error('.dev.vars не найден')
    process.exit(1)
  }
  const content = readFileSync('.dev.vars', 'utf-8')
  const env = {}
  for (const line of content.split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/.exec(line.trim())
    if (m && m[1] && m[2]) env[m[1]] = m[2]
  }
  return env
}

const env = readEnv()
const apiToken = env.CLOUDFLARE_API_TOKEN
const accountId = env.CLOUDFLARE_ACCOUNT_ID
const dbId = env.D1_DATABASE_ID
const masterKeyB64 = env.MASTER_KEY
const fingerprintKeyB64 = env.FINGERPRINT_KEY

if (!apiToken || !accountId || !dbId || !masterKeyB64 || !fingerprintKeyB64) {
  console.error('Нужны: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID, MASTER_KEY, FINGERPRINT_KEY в .dev.vars')
  process.exit(1)
}

async function encryptToken(plaintext, masterKeyB64, fingerprintKeyB64) {
  const masterBytes = Buffer.from(masterKeyB64, 'base64')
  if (masterBytes.length !== 32) throw new Error('MASTER_KEY must be 32 bytes')
  const masterKey = await crypto.subtle.importKey('raw', masterBytes, { name: 'AES-GCM' }, false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new TextEncoder().encode(plaintext)
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('wb-bot:shop-token:v1') },
    masterKey,
    data,
  )
  const fpBytes = Buffer.from(fingerprintKeyB64, 'base64')
  const fpKey = await crypto.subtle.importKey('raw', fpBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', fpKey, data)
  return {
    ciphertext: Buffer.from(ct).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
    fingerprint: Buffer.from(sig).toString('hex'),
  }
}

const wbAccountKey = 'test-shop-1'
const wbToken = 'eyJhbGciOiJIUzI1NiJ9.fake-test-token-12345'
const shopName = 'Test Shop'
const mode = 'drafts'
const enabled = false

const enc = await encryptToken(wbToken, masterKeyB64, fingerprintKeyB64)
console.log('Encrypted. fingerprint:', enc.fingerprint.slice(0, 16) + '...')

const shopId = crypto.randomUUID()
const now = Date.now()

const sql = `INSERT INTO shops (
  id, name, wb_account_key,
  token_ciphertext, token_iv, token_key_version, token_fingerprint,
  token_profile, deployment_mode,
  mode, enabled,
  last_sync_day_utc, next_sync_at,
  token_expires_at,
  disabled_reason,
  created_at_ms, updated_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, 'basic', 'cloud', ?, ?, NULL, ?, NULL, 'added via test script', ?, ?)`

const params = [
  shopId, shopName, wbAccountKey,
  enc.ciphertext, enc.iv, 1, enc.fingerprint,
  mode, enabled ? 1 : 0,
  now,
  now, now,
]

const res = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}/query`,
  {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  },
)
const result = await res.json()
console.log(JSON.stringify(result, null, 2))

if (result.success) {
  console.log(`\n✅ Shop added: ${shopId}`)
  console.log(`   wb_account_key: ${wbAccountKey}`)
  console.log(`   name: ${shopName}`)
  console.log(`   mode: ${mode}`)
  console.log(`   enabled: ${enabled}`)
} else {
  console.error('❌ Failed')
  process.exit(1)
}

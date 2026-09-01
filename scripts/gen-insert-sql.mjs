// Генерирует SQL INSERT для wb-review-bot-db.
// Запуск: node scripts/gen-insert-sql.mjs > /tmp/insert.sql && wrangler d1 execute wb-review-bot-db --remote --file=/tmp/insert.sql
import { readFileSync } from 'node:fs'
import { webcrypto as crypto } from 'node:crypto'

const env = {}
for (const line of readFileSync('.dev.vars', 'utf-8').split('\n')) {
  const m = /^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/.exec(line.trim())
  if (m && m[1] && m[2]) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
}

const masterBytes = Buffer.from(env.MASTER_KEY, 'base64')
if (masterBytes.length !== 32) throw new Error('MASTER must be 32 bytes, got ' + masterBytes.length)
const masterKey = await crypto.subtle.importKey('raw', masterBytes, { name: 'AES-GCM' }, false, ['encrypt'])
const iv = crypto.getRandomValues(new Uint8Array(12))
const data = new TextEncoder().encode('eyJhbGciOiJIUzI1NiJ9.fake-test-token-12345')
const ct = await crypto.subtle.encrypt(
  { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('wb-bot:shop-token:v1') },
  masterKey,
  data,
)
const fpBytes = Buffer.from(env.FINGERPRINT_KEY, 'base64')
const fpKey = await crypto.subtle.importKey('raw', fpBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
const sig = await crypto.subtle.sign('HMAC', fpKey, data)

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
) VALUES (
  '${shopId}',
  'Test Shop',
  'test-shop-1',
  '${Buffer.from(ct).toString('base64')}',
  '${Buffer.from(iv).toString('base64')}',
  1,
  '${Buffer.from(sig).toString('hex')}',
  'basic',
  'cloud',
  'drafts',
  0,
  NULL,
  ${now},
  NULL,
  'added via test',
  ${now},
  ${now}
);`
process.stdout.write(sql)

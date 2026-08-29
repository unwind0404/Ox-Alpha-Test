// Token crypto — AES-256-GCM + HMAC fingerprint.
// Использует Web Crypto API (встроен в Cloudflare Workers, Node 18+).
// MASTER_KEY (32 bytes) + FINGERPRINT_KEY (32 bytes) передаются через env.

const AAD = new TextEncoder().encode('wb-bot:shop-token:v1')
const KEY_VERSION = 1

export interface CryptoEnv {
  MASTER_KEY: string
  FINGERPRINT_KEY: string
}

export interface EncryptedToken {
  ciphertext: string // base64
  iv: string          // base64, 12 bytes
  fingerprint: string // hex, 32 bytes (HMAC-SHA-256)
  keyVersion: number
}

/** Конвертировать base64 в Uint8Array. */
function fromBase64(s: string): Uint8Array {
  const binary = atob(s)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/** Конвертировать Uint8Array в base64. */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

/** Конвертировать Uint8Array в hex. */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}


/** Импортировать MASTER_KEY как AES-GCM CryptoKey. */
async function importMasterKey(env: CryptoEnv): Promise<CryptoKey> {
  if (!env.MASTER_KEY) {
    throw new Error('MASTER_KEY is required for token encryption/decryption')
  }
  // Master key хранится как base64 (32 байта = 256 бит)
  const raw = fromBase64(env.MASTER_KEY)
  if (raw.length !== 32) {
    throw new Error(`MASTER_KEY must be 32 bytes (256 bits), got ${raw.length}`)
  }
  return crypto.subtle.importKey('raw', new Uint8Array(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/** Импортировать FINGERPRINT_KEY как HMAC-SHA-256 CryptoKey. */
async function importFingerprintKey(env: CryptoEnv): Promise<CryptoKey> {
  if (!env.FINGERPRINT_KEY) {
    throw new Error('FINGERPRINT_KEY is required for token fingerprinting')
  }
  const raw = fromBase64(env.FINGERPRINT_KEY)
  if (raw.length < 16) {
    throw new Error(`FINGERPRINT_KEY must be at least 16 bytes, got ${raw.length}`)
  }
  return crypto.subtle.importKey(
    'raw',
    new Uint8Array(raw),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

/** HMAC-SHA-256 fingerprint — уникальный ID токена без раскрытия. */
export async function fingerprintToken(plaintext: string, env: CryptoEnv): Promise<string> {
  const key = await importFingerprintKey(env)
  const data = new TextEncoder().encode(plaintext)
  const sig = await crypto.subtle.sign('HMAC', key, new Uint8Array(data))
  return toHex(new Uint8Array(sig))
}

/** Зашифровать plaintext токен. */
export async function encryptToken(plaintext: string, env: CryptoEnv): Promise<EncryptedToken> {
  const key = await importMasterKey(env)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new TextEncoder().encode(plaintext)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv), additionalData: AAD },
    key,
    new Uint8Array(data),
  )
  const fp = await fingerprintToken(plaintext, env)
  return {
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    iv: toBase64(iv),
    fingerprint: fp,
    keyVersion: KEY_VERSION,
  }
}

/** Расшифровать токен. Бросает Error если ключ неверный или IV/fingerprint подделан. */
export async function decryptToken(
  ciphertext: string,
  iv: string,
  keyVersion: number,
  env: CryptoEnv,
): Promise<string> {
  if (keyVersion !== KEY_VERSION) {
    throw new Error(`Unsupported token key version: ${keyVersion}, expected ${KEY_VERSION}`)
  }
  const key = await importMasterKey(env)
  const ivBytes = fromBase64(iv)
  const ctBytes = fromBase64(ciphertext)
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(ivBytes), additionalData: AAD },
      key,
      new Uint8Array(ctBytes),
    )
    return new TextDecoder().decode(plaintext)
  } catch {
    // Не раскрываем детали: "tampered or wrong key"
    throw new Error('Token decryption failed (tampered, wrong key, or wrong AAD)')
  }
}

/** Сгенерировать пару base64-ключей для MASTER_KEY и FINGERPRINT_KEY. */
export async function generateKeys(): Promise<{ masterKey: string; fingerprintKey: string }> {
  const master = crypto.getRandomValues(new Uint8Array(32))
  const fp = crypto.getRandomValues(new Uint8Array(32))
  return {
    masterKey: toBase64(master),
    fingerprintKey: toBase64(fp),
  }
}

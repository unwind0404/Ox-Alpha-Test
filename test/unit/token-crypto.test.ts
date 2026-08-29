import { describe, it, expect } from 'vitest'
import {
  encryptToken,
  decryptToken,
  fingerprintToken,
  generateKeys,
} from '../../src/adapters/cloudflare/token-crypto.js'

const env = {
  MASTER_KEY: 'k'.repeat(43) + '=', // base64 32 байта = 44 символа (с padding)
  FINGERPRINT_KEY: 'f'.repeat(43) + '=',
}

describe('token-crypto', () => {
  it('encrypt → decrypt возвращает тот же plaintext', async () => {
    const plaintext = 'eyJhbGciOiJIUzI1NiJ9.test.signature'
    const encrypted = await encryptToken(plaintext, env)
    const decrypted = await decryptToken(encrypted.ciphertext, encrypted.iv, encrypted.keyVersion, env)
    expect(decrypted).toBe(plaintext)
  })

  it('encrypt с разными IV для одного plaintext', async () => {
    const plaintext = 'same-token-value'
    const a = await encryptToken(plaintext, env)
    const b = await encryptToken(plaintext, env)
    expect(a.ciphertext).not.toBe(b.ciphertext) // разные IV
    expect(a.iv).not.toBe(b.iv)
    expect(a.fingerprint).toBe(b.fingerprint) // HMAC детерминирован
  })

  it('fingerprint стабилен для одного токена', async () => {
    const fp1 = await fingerprintToken('my-token', env)
    const fp2 = await fingerprintToken('my-token', env)
    expect(fp1).toBe(fp2)
    expect(fp1).toHaveLength(64) // 32 байта hex = 64 символа
  })

  it('fingerprint разный для разных токенов', async () => {
    const fp1 = await fingerprintToken('token-a', env)
    const fp2 = await fingerprintToken('token-b', env)
    expect(fp1).not.toBe(fp2)
  })

  it('tampered ciphertext — decrypt падает', async () => {
    const plaintext = 'real-token'
    const encrypted = await encryptToken(plaintext, env)
    // Подменим 1 байт в ciphertext
    const tampered = encrypted.ciphertext.slice(0, -4) + 'AAAA'
    await expect(
      decryptToken(tampered, encrypted.iv, encrypted.keyVersion, env),
    ).rejects.toThrow(/decryption failed/)
  })

  it('tampered IV — decrypt падает', async () => {
    const plaintext = 'real-token'
    const encrypted = await encryptToken(plaintext, env)
    // Подменим последний байт IV
    const ivBytes = atob(encrypted.iv)
    const tamperedIv = btoa(ivBytes.slice(0, -1) + 'X')
    await expect(
      decryptToken(encrypted.ciphertext, tamperedIv, encrypted.keyVersion, env),
    ).rejects.toThrow(/decryption failed/)
  })

  it('wrong key — decrypt падает', async () => {
    const plaintext = 'real-token'
    const encrypted = await encryptToken(plaintext, env)
    const wrongEnv = { MASTER_KEY: 'a'.repeat(43) + '=', FINGERPRINT_KEY: env.FINGERPRINT_KEY }
    await expect(
      decryptToken(encrypted.ciphertext, encrypted.iv, encrypted.keyVersion, wrongEnv),
    ).rejects.toThrow(/decryption failed/)
  })

  it('keyVersion mismatch — decrypt падает', async () => {
    const plaintext = 'real-token'
    const encrypted = await encryptToken(plaintext, env)
    await expect(
      decryptToken(encrypted.ciphertext, encrypted.iv, 999, env),
    ).rejects.toThrow(/Unsupported token key version/)
  })

  it('encrypted token содержит все нужные поля', async () => {
    const plaintext = 'x'
    const e = await encryptToken(plaintext, env)
    expect(e.keyVersion).toBe(1)
    expect(e.ciphertext).toBeTruthy()
    expect(e.iv).toBeTruthy()
    expect(e.fingerprint).toHaveLength(64)
    // IV = 12 байт = 16 base64 chars
    expect(atob(e.iv).length).toBe(12)
  })

  it('generateKeys возвращает 32-байтные ключи (base64)', async () => {
    const keys = await generateKeys()
    expect(atob(keys.masterKey).length).toBe(32)
    expect(atob(keys.fingerprintKey).length).toBe(32)
  })

  it('пустой MASTER_KEY → ошибка при encrypt', async () => {
    const empty = { MASTER_KEY: '', FINGERPRINT_KEY: env.FINGERPRINT_KEY }
    await expect(encryptToken('x', empty)).rejects.toThrow(/MASTER_KEY is required/)
  })

  it('короткий MASTER_KEY → ошибка', async () => {
    const short = { MASTER_KEY: 'aGVsbG8=', FINGERPRINT_KEY: env.FINGERPRINT_KEY } // base64 "hello" = 5 байт
    await expect(encryptToken('x', short)).rejects.toThrow(/32 bytes/)
  })

  it('encrypt/decode работает с большим токеном (>1KB)', async () => {
    const big = 'a'.repeat(2000)
    const e = await encryptToken(big, env)
    const d = await decryptToken(e.ciphertext, e.iv, e.keyVersion, env)
    expect(d).toBe(big)
  })
})

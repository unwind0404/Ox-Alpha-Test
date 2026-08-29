// Secret store port — encrypt/decrypt токенов WB.
// В cloud: Worker Secret (AES-256-GCM) + HMAC fingerprint key.
// В self_managed: env + filesystem, реализация другая.

export interface SecretStorePort {
  /** Зашифровать plaintext токен для хранения. */
  encrypt(plaintext: string): Promise<{
    ciphertext: string
    iv: string
    fingerprint: string
    keyVersion: number
  }>
  /** Расшифровать для WB-вызова. */
  decrypt(ciphertext: string, iv: string, keyVersion: number): Promise<string>
  /** HMAC fingerprint — уникальный ID токена без раскрытия. */
  fingerprint(plaintext: string): string
}

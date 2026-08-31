// scripts/check-env.ts
// Валидация env-vars перед деплоем. Запускать локально + в CI.

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface Check {
  name: string
  ok: boolean
  detail: string
}

const checks: Check[] = []

function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail })
}

// Читаем .dev.vars (для локальной валидации) или .env
function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const content = readFileSync(path, 'utf-8')
  const env: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/.exec(line.trim())
    if (m && m[1] && m[2]) env[m[1]] = m[2]
  }
  return env
}

const envFile = existsSync('.dev.vars') ? '.dev.vars' : '.env'
const fileEnv = readEnvFile(envFile)
const env = { ...process.env, ...fileEnv }

// 1. DEPLOYMENT_MODE
const deploymentMode = env.DEPLOYMENT_MODE
check(
  'DEPLOYMENT_MODE',
  deploymentMode === 'cloud' || deploymentMode === 'self_managed',
  deploymentMode ?? '(missing)',
)

// 2. WB_TOKEN_TYPE
const wbTokenType = env.WB_TOKEN_TYPE
const isCloud = deploymentMode === 'cloud'
const isSelfManaged = deploymentMode === 'self_managed'
check(
  'WB_TOKEN_TYPE',
  wbTokenType === 'basic' || wbTokenType === 'personal' || wbTokenType === 'service',
  wbTokenType ?? '(missing)',
)
if (isCloud && wbTokenType !== 'basic') {
  check('WB_TOKEN_TYPE + DEPLOYMENT_MODE', false, `cloud deployment требует basic, получено ${wbTokenType}`)
}
if (isSelfManaged && wbTokenType !== 'personal') {
  check('WB_TOKEN_TYPE + DEPLOYMENT_MODE', false, `self_managed deployment требует personal, получено ${wbTokenType}`)
}

// 3. MAX_ANSWERS_PER_RUN
const maxAnswers = Number(env.MAX_ANSWERS_PER_RUN ?? '1')
check(
  'MAX_ANSWERS_PER_RUN',
  Number.isInteger(maxAnswers) && maxAnswers > 0 && maxAnswers <= 100,
  String(maxAnswers),
)

// 4. CRON_SECRET
check('CRON_SECRET', Boolean(env.CRON_SECRET), env.CRON_SECRET ? `длина ${env.CRON_SECRET.length}` : '(missing)')

// 5. ADMIN_PASSWORD
check('ADMIN_PASSWORD', Boolean(env.ADMIN_PASSWORD), env.ADMIN_PASSWORD ? `длина ${env.ADMIN_PASSWORD.length}` : '(missing)')

// 6. DATABASE_URL
check(
  'DATABASE_URL',
  Boolean(env.DATABASE_URL) && (env.DATABASE_URL?.startsWith('postgres://') ?? false),
  env.DATABASE_URL ? `${env.DATABASE_URL.slice(0, 30)}...` : '(missing)',
)

// 7. WB_API_BASE
const allowedHosts = ['feedbacks-api.wildberries.ru', 'feedbacks-api-sandbox.wildberries.ru']
check(
  'WB_API_BASE',
  allowedHosts.some((h) => env.WB_API_BASE?.includes(h)),
  env.WB_API_BASE ?? '(missing)',
)

// 8. OPENROUTER_API_KEY
check(
  'OPENROUTER_API_KEY',
  Boolean(env.OPENROUTER_API_KEY) && (env.OPENROUTER_API_KEY?.startsWith('sk-or-') ?? false),
  env.OPENROUTER_API_KEY ? `${env.OPENROUTER_API_KEY.slice(0, 10)}...` : '(missing)',
)

// 9. MASTER_KEY / FINGERPRINT_KEY (для cloud)
if (isCloud) {
  check('MASTER_KEY', Boolean(env.MASTER_KEY), env.MASTER_KEY ? `длина ${env.MASTER_KEY.length}` : '(missing — нужен для шифрования токенов)')
  check('FINGERPRINT_KEY', Boolean(env.FINGERPRINT_KEY), env.FINGERPRINT_KEY ? `длина ${env.FINGERPRINT_KEY.length}` : '(missing)')
} else {
  checks.push({ name: 'MASTER_KEY', ok: true, detail: 'N/A (self_managed)' })
  checks.push({ name: 'FINGERPRINT_KEY', ok: true, detail: 'N/A (self_managed)' })
}

// 10. SESSION_SECRET
check('SESSION_SECRET', Boolean(env.SESSION_SECRET), env.SESSION_SECRET ? `длина ${env.SESSION_SECRET.length}` : '(missing)')

// Вывод
console.log(`\nПроверка env (источник: ${envFile})\n`)
for (const c of checks) {
  const icon = c.ok ? '✅' : '❌'
  console.log(`${icon} ${c.name.padEnd(28)} ${c.detail}`)
}
const failed = checks.filter((c) => !c.ok)
if (failed.length > 0) {
  console.log(`\n❌ ${failed.length} check(s) failed\n`)
  process.exit(1)
}
console.log(`\n✅ All ${checks.length} checks passed\n`)

// Тесты, подтверждающие что core/ports/adapters — runtime-neutral.
// Запускаются без Cloudflare runtime, без Vercel, без DOM.

import { describe, it, expect } from 'vitest'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '..', '..')

const FORBIDDEN_IMPORTS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /from\s+['"]cloudflare:/, reason: 'Cloudflare runtime — use ports/adapters' },
  { pattern: /from\s+['"]@cloudflare\//, reason: 'Cloudflare package — use ports/adapters' },
  { pattern: /from\s+['"]node:/, reason: 'Node.js import — runtime-neutral' },
  { pattern: /from\s+['"]fs['"]/, reason: 'node:fs import — use ports' },
  { pattern: /from\s+['"]path['"]/, reason: 'node:path import' },
  { pattern: /from\s+['"]\.\.\/adapters/, reason: 'core/ports must not import adapters' },
  { pattern: /from\s+['"]\.\.\/coordinator/, reason: 'core/ports must not import coordinator' },
  { pattern: /from\s+['"]next\//, reason: 'Next.js — wrong stack' },
  { pattern: /from\s+['"]react\//, reason: 'React — wrong stack (vanilla JS)' },
]

const PROTECTED_DIRS = ['core', 'ports']

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, acc)
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      acc.push(full)
    }
  }
  return acc
}

describe('core/ports: runtime-neutral (portable)', () => {
  for (const dir of PROTECTED_DIRS) {
    const full = join(ROOT, 'src', dir)
    const files = walk(full)

    it(`${dir}/ не импортирует Cloudflare/Node/React/Adapters`, () => {
      const violations: Array<{ file: string; reason: string }> = []
      for (const file of files) {
        const content = require('fs').readFileSync(file, 'utf-8')
        for (const { pattern, reason } of FORBIDDEN_IMPORTS) {
          if (pattern.test(content)) {
            violations.push({ file: relative(ROOT, file), reason })
          }
        }
      }
      if (violations.length > 0) {
        const msg = violations.map((v) => `  ${v.file}: ${v.reason}`).join('\n')
        throw new Error(`Архитектурные нарушения:\n${msg}`)
      }
      expect(violations).toHaveLength(0)
    })
  }
})

import { describe, it, expect } from 'vitest'
import { templateForRating } from '../../src/core/reply-templates.js'

describe('reply-templates: templateForRating', () => {
  it('rating=5 → благодарность', () => {
    const t = templateForRating(5)
    expect(t).toContain('спасибо')
    expect(t).toContain('высокую оценку')
  })

  it('rating=4 → благодарность + улучшения', () => {
    const t = templateForRating(4)
    expect(t.toLowerCase()).toContain('благодарим')
    expect(t.toLowerCase()).toContain('хорошую')
  })

  it('rating=3 → благодарность + просьба feedback', () => {
    const t = templateForRating(3)
    expect(t.toLowerCase()).toContain('спасибо')
    expect(t.toLowerCase()).toContain('улучшить')
  })

  it('rating=2 → извинения + уточнение', () => {
    const t = templateForRating(2)
    expect(t.toLowerCase()).toContain('извинения')
  })

  it('rating=1 → глубокие извинения + связь', () => {
    const t = templateForRating(1)
    expect(t.toLowerCase()).toContain('сожалеем')
    expect(t.toLowerCase()).toContain('свяжитесь')
  })

  it('rating=null → дефолт', () => {
    const t = templateForRating(null)
    expect(t.toLowerCase()).toContain('здравствуйте')
    expect(t.toLowerCase()).toContain('спасибо')
  })

  it('все шаблоны < 5000 символов (WB limit)', () => {
    for (let r = 1; r <= 5; r++) {
      expect(templateForRating(r as 1 | 2 | 3 | 4 | 5).length).toBeLessThan(5000)
    }
    expect(templateForRating(null).length).toBeLessThan(5000)
  })
})

import { describe, it, expect } from 'vitest'
import { canTransition, assertTransition } from '../../src/core/state-machine.js'
import type { JobState } from '../../src/core/types.js'

describe('core/state-machine', () => {
  describe('canTransition', () => {
    it('happy path: discovered -> generating -> ready_to_send -> sending -> posted', () => {
      const path: JobState[] = ['discovered', 'generating', 'ready_to_send', 'sending', 'posted']
      for (let i = 0; i < path.length - 1; i++) {
        expect(canTransition(path[i]!, path[i + 1]!)).toBe(true)
      }
    })

    it('happy path: discovered -> draft_ready -> ready_to_send -> sending -> posted', () => {
      const path: JobState[] = ['discovered', 'draft_ready', 'ready_to_send', 'sending', 'posted']
      for (let i = 0; i < path.length - 1; i++) {
        expect(canTransition(path[i]!, path[i + 1]!)).toBe(true)
      }
    })

    it('terminal states: никаких переходов из posted', () => {
      const states: JobState[] = ['generating', 'draft_ready', 'ready_to_send', 'sending', 'manual_review', 'rejected', 'dead', 'waiting_llm_quota']
      for (const s of states) {
        expect(canTransition('posted', s)).toBe(false)
      }
    })

    it('terminal states: никаких переходов из rejected', () => {
      const states: JobState[] = ['generating', 'ready_to_send', 'posted', 'manual_review']
      for (const s of states) {
        expect(canTransition('rejected', s)).toBe(false)
      }
    })

    it('terminal states: никаких переходов из dead', () => {
      const states: JobState[] = ['generating', 'ready_to_send', 'posted', 'manual_review', 'retry_wait']
      for (const s of states) {
        expect(canTransition('dead', s)).toBe(false)
      }
    })

    it('manual_review может возобновить работу', () => {
      expect(canTransition('manual_review', 'generating')).toBe(true)
      expect(canTransition('manual_review', 'ready_to_send')).toBe(true)
      expect(canTransition('manual_review', 'draft_ready')).toBe(true)
      expect(canTransition('manual_review', 'rejected')).toBe(true)
    })

    it('sending -> retry_wait при сбое', () => {
      expect(canTransition('sending', 'retry_wait')).toBe(true)
    })

    it('sending -> reconcile_pending при таймауте', () => {
      expect(canTransition('sending', 'reconcile_pending')).toBe(true)
    })

    it('reconcile_pending -> posted (если WB подтвердил)', () => {
      expect(canTransition('reconcile_pending', 'posted')).toBe(true)
    })

    it('reconcile_pending -> ready_to_send (если нет — повтор)', () => {
      expect(canTransition('reconcile_pending', 'ready_to_send')).toBe(true)
    })
  })

  describe('assertTransition', () => {
    it('проходит для допустимого перехода', () => {
      expect(() => assertTransition('discovered', 'generating')).not.toThrow()
    })

    it('бросает для недопустимого перехода', () => {
      expect(() => assertTransition('posted', 'generating')).toThrow(/Недопустимый переход/)
    })
  })
})

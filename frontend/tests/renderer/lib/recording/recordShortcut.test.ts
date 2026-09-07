import { describe, expect, it } from 'vitest'
import {
  isRecordShortcutKey,
  type RecordShortcutContext
} from '@/lib/recording/recordShortcut'

function ctx(overrides: Partial<RecordShortcutContext> = {}): RecordShortcutContext {
  return {
    key: ' ',
    targetTagName: null,
    targetInputType: null,
    targetIsContentEditable: false,
    isReviewing: false,
    ...overrides
  }
}

describe('isRecordShortcutKey', () => {
  it('claims the space bar whatever holds focus', () => {
    // The regression this guards: starting a take destroys the Record button and
    // disables the setup controls, so focus lands wherever it lands. Space has to keep
    // working or a rolling take cannot be stopped from the keyboard.
    for (const target of ['BUTTON', 'INPUT', 'SELECT', 'DIV', null]) {
      const inputType = target === 'INPUT' ? 'checkbox' : null
      expect(
        isRecordShortcutKey(ctx({ targetTagName: target, targetInputType: inputType })),
        `space should record with ${target ?? 'nothing'} focused`
      ).toBe(true)
    }
  })

  it('claims R except from a focused select, which needs its letter keys', () => {
    expect(isRecordShortcutKey(ctx({ key: 'r', targetTagName: 'BUTTON' }))).toBe(true)
    expect(isRecordShortcutKey(ctx({ key: 'R', targetTagName: 'BUTTON' }))).toBe(true)
    // The input-device picker uses type-ahead; space still covers it.
    expect(isRecordShortcutKey(ctx({ key: 'r', targetTagName: 'SELECT' }))).toBe(false)
    expect(isRecordShortcutKey(ctx({ key: ' ', targetTagName: 'SELECT' }))).toBe(true)
  })

  it('leaves typing alone', () => {
    const text = { targetTagName: 'INPUT', targetInputType: 'text' }
    expect(isRecordShortcutKey(ctx({ key: ' ', ...text }))).toBe(false)
    expect(isRecordShortcutKey(ctx({ key: 'r', ...text }))).toBe(false)
    expect(isRecordShortcutKey(ctx({ key: ' ', targetTagName: 'TEXTAREA' }))).toBe(false)
    expect(isRecordShortcutKey(ctx({ key: ' ', targetIsContentEditable: true }))).toBe(false)
  })

  it('does not fire once the take is in review', () => {
    expect(isRecordShortcutKey(ctx({ key: ' ', isReviewing: true }))).toBe(false)
    expect(isRecordShortcutKey(ctx({ key: 'r', isReviewing: true }))).toBe(false)
  })

  it('ignores every other key', () => {
    for (const key of ['Enter', 'Escape', 'a', 'Tab', 'ArrowLeft']) {
      expect(isRecordShortcutKey(ctx({ key })), `${key} should not record`).toBe(false)
    }
  })
})

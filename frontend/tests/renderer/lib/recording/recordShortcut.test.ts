import { describe, expect, it } from 'vitest'
import {
  isRecordShortcutKey,
  isReviewPlayShortcutKey,
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

describe('isReviewPlayShortcutKey', () => {
  it('claims the space bar whatever holds focus', () => {
    // Review is a listening step: the tick boxes and the backing slider are exactly what
    // the user has just clicked, so space has to replay the take rather than re-toggle
    // whichever of them still holds focus.
    for (const target of ['BUTTON', 'INPUT', 'SELECT', 'DIV', null]) {
      const inputType = target === 'INPUT' ? 'checkbox' : null
      expect(
        isReviewPlayShortcutKey(
          ctx({ isReviewing: true, targetTagName: target, targetInputType: inputType })
        ),
        `space should audition with ${target ?? 'nothing'} focused`
      ).toBe(true)
    }
  })

  it('leaves the take name alone', () => {
    expect(
      isReviewPlayShortcutKey(
        ctx({ isReviewing: true, targetTagName: 'INPUT', targetInputType: 'text' })
      )
    ).toBe(false)
    expect(isReviewPlayShortcutKey(ctx({ isReviewing: true, targetTagName: 'TEXTAREA' }))).toBe(
      false
    )
    expect(
      isReviewPlayShortcutKey(ctx({ isReviewing: true, targetIsContentEditable: true }))
    ).toBe(false)
  })

  it('does not fire while the take is still being made', () => {
    // Space belongs to record until there is something to hear back.
    expect(isReviewPlayShortcutKey(ctx({ isReviewing: false }))).toBe(false)
  })

  it('ignores every other key', () => {
    for (const key of ['Enter', 'Escape', 'r', 'R', 'Tab', 'ArrowLeft']) {
      expect(
        isReviewPlayShortcutKey(ctx({ key, isReviewing: true })),
        `${key} should not audition`
      ).toBe(false)
    }
  })

  it('never overlaps with the record shortcut', () => {
    // The two rules share one keydown, so a key that satisfied both would record and
    // audition off a single press.
    for (const isReviewing of [false, true]) {
      for (const key of [' ', 'r', 'R', 'Enter']) {
        const context = ctx({ key, isReviewing })
        expect(
          isRecordShortcutKey(context) && isReviewPlayShortcutKey(context),
          `${key} while ${isReviewing ? 'reviewing' : 'recording'}`
        ).toBe(false)
      }
    }
  })
})

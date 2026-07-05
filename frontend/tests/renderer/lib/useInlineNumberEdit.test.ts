import { describe, expect, it, vi } from 'vitest'
import { useInlineNumberEdit } from '@/lib/useInlineNumberEdit'

function make(initial: number, opts?: Partial<{ min: number; max: number; step: number }>) {
  let current = initial
  const set = vi.fn((v: number) => {
    current = v
  })
  const edit = useInlineNumberEdit({
    get: () => current,
    set,
    min: opts?.min ?? -12,
    max: opts?.max ?? 12,
    step: opts?.step
  })
  return { edit, set, get: () => current }
}

describe('useInlineNumberEdit', () => {
  it('begins editing with the current value as text', () => {
    const { edit } = make(3)
    edit.begin()
    expect(edit.editing.value).toBe(true)
    expect(edit.text.value).toBe('3')
  })

  it('commits a parsed value and stops editing', () => {
    const { edit, set } = make(0)
    edit.begin()
    edit.text.value = '5'
    edit.commit()
    expect(set).toHaveBeenCalledWith(5)
    expect(edit.editing.value).toBe(false)
  })

  it('clamps the committed value to the range', () => {
    const { edit, set } = make(0)
    edit.begin()
    edit.text.value = '99'
    edit.commit()
    expect(set).toHaveBeenCalledWith(12)
  })

  it('rounds to the configured step', () => {
    const { edit, set } = make(0, { min: -100, max: 100, step: 1 })
    edit.begin()
    edit.text.value = '4.7'
    edit.commit()
    expect(set).toHaveBeenCalledWith(5)
  })

  it('ignores empty or non-numeric input on commit', () => {
    const { edit, set } = make(2)
    edit.begin()
    edit.text.value = 'abc'
    edit.commit()
    expect(set).not.toHaveBeenCalled()
    expect(edit.editing.value).toBe(false)
  })

  it('cancel discards the edit without applying', () => {
    const { edit, set } = make(2)
    edit.begin()
    edit.text.value = '7'
    edit.cancel()
    expect(set).not.toHaveBeenCalled()
    expect(edit.editing.value).toBe(false)
  })

  it('Enter commits and Escape cancels', () => {
    const key = (k: string): KeyboardEvent =>
      ({ key: k, preventDefault: () => {} }) as unknown as KeyboardEvent
    const { edit, set } = make(0)
    edit.begin()
    edit.text.value = '-4'
    edit.onKeydown(key('Enter'))
    expect(set).toHaveBeenCalledWith(-4)

    edit.begin()
    edit.text.value = '8'
    edit.onKeydown(key('Escape'))
    expect(edit.editing.value).toBe(false)
    expect(set).toHaveBeenCalledTimes(1)
  })
})

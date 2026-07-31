import { describe, expect, it } from 'vitest'
import {
  shouldActivateDefaultButton,
  type DefaultButtonKeyContext
} from '@/lib/app/useDialogDefaultButton'

const ENTER: DefaultButtonKeyContext = {
  key: 'Enter',
  defaultPrevented: false,
  isComposing: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  activeTagName: null,
  activeIsActivatable: false
}

describe('shouldActivateDefaultButton', () => {
  it('accepts a plain Enter with nothing focused', () => {
    expect(shouldActivateDefaultButton(ENTER)).toBe(true)
  })

  it('accepts Enter from a text input, which is the point of the feature', () => {
    expect(shouldActivateDefaultButton({ ...ENTER, activeTagName: 'INPUT' })).toBe(true)
  })

  it('ignores every key other than Enter', () => {
    for (const key of ['Escape', ' ', 'a', 'NumpadEnter', 'Tab']) {
      expect(shouldActivateDefaultButton({ ...ENTER, key })).toBe(false)
    }
  })

  it('stands down when a local handler already claimed the key', () => {
    expect(shouldActivateDefaultButton({ ...ENTER, defaultPrevented: true })).toBe(false)
  })

  it('stands down mid-IME composition, where Enter commits a candidate', () => {
    expect(shouldActivateDefaultButton({ ...ENTER, isComposing: true })).toBe(false)
  })

  it('stands down for any modifier, which makes it a different gesture', () => {
    expect(shouldActivateDefaultButton({ ...ENTER, ctrlKey: true })).toBe(false)
    expect(shouldActivateDefaultButton({ ...ENTER, metaKey: true })).toBe(false)
    expect(shouldActivateDefaultButton({ ...ENTER, altKey: true })).toBe(false)
    expect(shouldActivateDefaultButton({ ...ENTER, shiftKey: true })).toBe(false)
  })

  it('leaves a textarea free to insert a newline', () => {
    expect(shouldActivateDefaultButton({ ...ENTER, activeTagName: 'TEXTAREA' })).toBe(false)
  })

  it('leaves a select free to commit its own value', () => {
    expect(shouldActivateDefaultButton({ ...ENTER, activeTagName: 'SELECT' })).toBe(false)
  })

  it('does not override a focused button — Cancel must stay Cancel', () => {
    // The browser already clicks the focused button, so acting here would both
    // hijack Cancel and double-fire when the primary itself has focus.
    expect(
      shouldActivateDefaultButton({
        ...ENTER,
        activeTagName: 'BUTTON',
        activeIsActivatable: true
      })
    ).toBe(false)
  })
})

import { nextTick, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { useDecimalFieldText } from '@/lib/useDecimalFieldText'

function inputEvent(value: string): Event {
  return { target: { value } } as unknown as Event
}

describe('useDecimalFieldText', () => {
  it('formats the initial model value to two decimals', () => {
    const model = ref(100)
    const field = useDecimalFieldText(model)
    expect(field.text.value).toBe('100.00')
  })

  it('reformats when the model changes while unfocused', async () => {
    const model = ref(100)
    const field = useDecimalFieldText(model)

    model.value = 99.5
    await nextTick()
    expect(field.text.value).toBe('99.50')

    model.value = 133.333
    await nextTick()
    expect(field.text.value).toBe('133.33')
  })

  it('shows raw keystrokes verbatim while focused and formats on blur', async () => {
    const model = ref(100)
    const field = useDecimalFieldText(model)

    field.onFocus()
    field.onInput(inputEvent('1'))
    await nextTick()
    expect(field.text.value).toBe('1')
    expect(model.value).toBe(1)

    field.onInput(inputEvent('12'))
    await nextTick()
    expect(field.text.value).toBe('12')

    field.onBlur()
    expect(field.text.value).toBe('12.00')
  })

  it('leaves the model untouched for blank or non-numeric input', () => {
    const model = ref(100)
    const field = useDecimalFieldText(model)

    field.onFocus()
    field.onInput(inputEvent(''))
    expect(model.value).toBe(100)
    field.onInput(inputEvent('-'))
    expect(model.value).toBe(100)

    // Blur restores the display from what the model actually holds.
    field.onBlur()
    expect(field.text.value).toBe('100.00')
  })

  it('reformats on demand after a programmatic change while focused', () => {
    const model = ref(120)
    const field = useDecimalFieldText(model)

    field.onFocus()
    model.value = 121
    field.sync()
    expect(field.text.value).toBe('121.00')
  })

  it('honours a custom decimal count', () => {
    const model = ref(2.5)
    const field = useDecimalFieldText(model, 3)
    expect(field.text.value).toBe('2.500')
  })

  // What is displayed must be what is applied: a value the field cannot show in
  // full would otherwise stay in the model and drive the warp maths.
  it('quantises the model to the displayed precision on blur', () => {
    const model = ref(100)
    const field = useDecimalFieldText(model)

    field.onFocus()
    field.onInput(inputEvent('100.567'))
    expect(model.value).toBe(100.567)

    field.onBlur()
    expect(field.text.value).toBe('100.57')
    expect(model.value).toBe(100.57)
  })

  it('leaves an already-exact value untouched on blur', () => {
    const model = ref(120.25)
    const field = useDecimalFieldText(model)

    field.onFocus()
    field.onBlur()
    expect(model.value).toBe(120.25)
    expect(field.text.value).toBe('120.25')
  })

  it('quantises to a custom decimal count on blur', () => {
    const model = ref(1)
    const field = useDecimalFieldText(model, 1)

    field.onFocus()
    field.onInput(inputEvent('2.46'))
    field.onBlur()
    expect(model.value).toBe(2.5)
    expect(field.text.value).toBe('2.5')
  })

  it('blanks the display for a non-finite model value', async () => {
    const model = ref(100)
    const field = useDecimalFieldText(model)

    model.value = Number.NaN
    await nextTick()
    expect(field.text.value).toBe('')
  })
})

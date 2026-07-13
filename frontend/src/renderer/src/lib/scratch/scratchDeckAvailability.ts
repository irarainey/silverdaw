import type { MidiInputDevice } from '@shared/bridge-protocol'
import type { MidiDeckSelection } from '@shared/types'

export function hasAvailableScratchDeck(
  inputs: readonly MidiInputDevice[],
  deckSelections: Readonly<Record<string, MidiDeckSelection>>
): boolean {
  return inputs.some((input) => {
    if (!input.connected || !input.enabled || input.controllerProfile === null) return false
    const selection = deckSelections[input.identifier]
    return selection?.deck1Enabled === true || selection?.deck2Enabled === true
  })
}

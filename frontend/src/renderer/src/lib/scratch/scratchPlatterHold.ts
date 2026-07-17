import { ref, type Ref } from 'vue'

export interface ScratchPlatterHoldController {
  isHeld: Ref<boolean>
  toggle(): void
  release(): void
}

export function createScratchPlatterHoldController(): ScratchPlatterHoldController {
  const isHeld = ref(false)

  function toggle(): void {
    isHeld.value = !isHeld.value
  }

  function release(): void {
    isHeld.value = false
  }

  return { isHeld, toggle, release }
}

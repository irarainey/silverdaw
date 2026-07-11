const STARTUP_RECONNECT_DELAY_MS = 100
const MAX_STARTUP_FAST_RETRIES = 10
const RECOVERY_RECONNECT_DELAY_MS = 1000
const MAX_RECOVERY_RECONNECT_DELAY_MS = 5000

export class BridgeReconnectPolicy {
  private startupRetryCount = 0
  private hasConnected = false
  private recoveryDelayMs = RECOVERY_RECONNECT_DELAY_MS

  nextDelayMs(): number {
    if (!this.hasConnected && this.startupRetryCount < MAX_STARTUP_FAST_RETRIES) {
      this.startupRetryCount++
      return STARTUP_RECONNECT_DELAY_MS
    }

    const delayMs = this.recoveryDelayMs
    this.recoveryDelayMs = Math.min(
      this.recoveryDelayMs * 2,
      MAX_RECOVERY_RECONNECT_DELAY_MS
    )
    return delayMs
  }

  markConnected(): void {
    this.hasConnected = true
    this.recoveryDelayMs = RECOVERY_RECONNECT_DELAY_MS
  }

  reset(): void {
    this.startupRetryCount = 0
    this.hasConnected = false
    this.recoveryDelayMs = RECOVERY_RECONNECT_DELAY_MS
  }
}

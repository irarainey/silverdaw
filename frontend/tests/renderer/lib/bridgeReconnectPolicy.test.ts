import { describe, expect, it } from 'vitest'
import { BridgeReconnectPolicy } from '@/lib/bridgeReconnectPolicy'

describe('BridgeReconnectPolicy', () => {
  it('retries quickly during initial startup before using recovery backoff', () => {
    const policy = new BridgeReconnectPolicy()

    expect(Array.from({ length: 10 }, () => policy.nextDelayMs())).toEqual(
      Array.from({ length: 10 }, () => 100)
    )
    expect([
      policy.nextDelayMs(),
      policy.nextDelayMs(),
      policy.nextDelayMs(),
      policy.nextDelayMs(),
      policy.nextDelayMs()
    ]).toEqual([1000, 2000, 4000, 5000, 5000])
  })

  it('uses recovery backoff after the first connection', () => {
    const policy = new BridgeReconnectPolicy()
    policy.markConnected()

    expect([
      policy.nextDelayMs(),
      policy.nextDelayMs(),
      policy.nextDelayMs(),
      policy.nextDelayMs(),
      policy.nextDelayMs()
    ]).toEqual([1000, 2000, 4000, 5000, 5000])
  })

  it('resets recovery backoff when a connection succeeds', () => {
    const policy = new BridgeReconnectPolicy()
    policy.markConnected()
    policy.nextDelayMs()
    policy.nextDelayMs()

    policy.markConnected()

    expect(policy.nextDelayMs()).toBe(1000)
  })

  it('restores startup retries after an explicit reset', () => {
    const policy = new BridgeReconnectPolicy()
    policy.markConnected()
    policy.nextDelayMs()

    policy.reset()

    expect(policy.nextDelayMs()).toBe(100)
  })
})

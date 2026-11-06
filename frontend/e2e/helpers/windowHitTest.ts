import { execFileSync } from 'node:child_process'
import type { ElectronApplication } from '@playwright/test'

/** Queries Windows routing, which Playwright's browser input bypasses. */
export async function windowHitTest(
  electronApp: ElectronApplication,
  points: { x: number; y: number }[]
): Promise<number[]> {
  const target = await electronApp.evaluate(({ BrowserWindow, screen }, points) => {
    const win = BrowserWindow.getAllWindows()[0]!
    const bounds = win.getContentBounds()
    const zoom = win.webContents.getZoomFactor()
    return {
      handle: win.getNativeWindowHandle().readBigUInt64LE().toString(),
      points: points.map((point) => screen.dipToScreenPoint({
        x: Math.round(bounds.x + point.x * zoom),
        y: Math.round(bounds.y + point.y * zoom)
      }))
    }
  }, points)
  const encoded = Buffer.from(JSON.stringify(target)).toString('base64')
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WindowHitTest {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SendMessageTimeoutW(
    IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam,
    uint flags, uint timeout, out UIntPtr result);
}
'@
if ([WindowHitTest]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) -eq [IntPtr]::Zero) {
  throw [System.ComponentModel.Win32Exception]::new()
}
$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
foreach ($point in $target.points) {
  $coords = ([int]$point.y -shl 16) -bor ([int]$point.x -band 65535)
  $result = [UIntPtr]::Zero
  $sent = [WindowHitTest]::SendMessageTimeoutW(
    [IntPtr]::new([long]$target.handle), 0x84, [IntPtr]::Zero,
    [IntPtr]::new($coords), 3, 1000, [ref]$result)
  if ($sent -eq [IntPtr]::Zero) { throw 'WM_NCHITTEST timed out or failed' }
  $result.ToUInt64()
}
`
  const output = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 15_000 }
  )
  const results = output.trim().split(/\r?\n/).map(Number)
  if (results.length !== points.length || results.some((result) => !Number.isInteger(result))) {
    throw new Error(`Unexpected WM_NCHITTEST results: ${output}`)
  }
  return results
}

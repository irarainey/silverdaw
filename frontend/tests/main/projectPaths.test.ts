import { describe, expect, it } from 'vitest'
import { isAbsolute } from 'node:path'
import { canonicaliseProjectPath, projectFolderPath, PROJECT_FILE_EXTENSION } from '@main/projectPaths'

// Use platform-appropriate absolute roots so the test is valid on Windows and POSIX.
const ROOT = process.platform === 'win32' ? 'C:\\projects' : '/projects'
const sep = process.platform === 'win32' ? '\\' : '/'
const abs = (...parts: string[]): string => ROOT + sep + parts.join(sep)

describe('canonicaliseProjectPath', () => {
  it('exposes the project extension', () => {
    expect(PROJECT_FILE_EXTENSION).toBe('silverdaw')
  })

  it('rejects non-string input', () => {
    expect(canonicaliseProjectPath(undefined)).toBeNull()
    expect(canonicaliseProjectPath(null)).toBeNull()
    expect(canonicaliseProjectPath(42)).toBeNull()
    expect(canonicaliseProjectPath({})).toBeNull()
  })

  it('rejects empty strings', () => {
    expect(canonicaliseProjectPath('')).toBeNull()
  })

  it('rejects relative paths', () => {
    expect(canonicaliseProjectPath('song.silverdaw')).toBeNull()
    expect(canonicaliseProjectPath('./song.silverdaw')).toBeNull()
    expect(canonicaliseProjectPath('sub/song.silverdaw')).toBeNull()
  })

  it('rejects non-.silverdaw extensions', () => {
    expect(canonicaliseProjectPath(abs('song.txt'))).toBeNull()
    expect(canonicaliseProjectPath(abs('song'))).toBeNull()
    expect(canonicaliseProjectPath(abs('song.silverdaw.bak'))).toBeNull()
  })

  it('accepts an absolute .silverdaw path and returns it canonicalised', () => {
    const p = abs('song.silverdaw')
    const result = canonicaliseProjectPath(p)
    expect(result).not.toBeNull()
    expect(isAbsolute(result!)).toBe(true)
    expect(result!.toLowerCase().endsWith('.silverdaw')).toBe(true)
  })

  it('accepts a mixed-case extension', () => {
    expect(canonicaliseProjectPath(abs('song.SILVERDAW'))).not.toBeNull()
  })

  it('collapses traversal segments while still requiring the extension', () => {
    const traversal = abs('a', '..', 'song.silverdaw')
    const result = canonicaliseProjectPath(traversal)
    expect(result).toBe(abs('song.silverdaw'))
    expect(result).not.toContain('..')
  })

  it('rejects a traversal path that resolves to a non-.silverdaw file', () => {
    expect(canonicaliseProjectPath(abs('a', '..', 'secret.txt'))).toBeNull()
  })
})

describe('projectFolderPath', () => {
  it('nests a chosen project file into a folder named after the project', () => {
    expect(projectFolderPath(abs('MyMix.silverdaw'))).toBe(abs('MyMix', 'MyMix.silverdaw'))
  })

  it('does not double-nest when the parent folder already matches the name', () => {
    const already = abs('MyMix', 'MyMix.silverdaw')
    expect(projectFolderPath(already)).toBe(already)
  })

  it('treats the folder-name match case-insensitively', () => {
    const p = abs('mymix', 'MyMix.silverdaw')
    expect(projectFolderPath(p)).toBe(p)
  })

  it('preserves the chosen parent directory when nesting', () => {
    const chosen = abs('Songs', '2026', 'Anthem.silverdaw')
    expect(projectFolderPath(chosen)).toBe(abs('Songs', '2026', 'Anthem', 'Anthem.silverdaw'))
  })
})

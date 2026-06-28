import { describe, it, expect } from 'vitest'
import { basename, projectNameFromPath } from '@/lib/project/projectPath'

describe('basename', () => {
  it('returns the final segment of a Windows path', () => {
    expect(basename('C:\\Users\\me\\Mix\\Mix.silverdaw')).toBe('Mix.silverdaw')
  })

  it('returns the final segment of a POSIX path', () => {
    expect(basename('/home/me/Mix/Mix.silverdaw')).toBe('Mix.silverdaw')
  })

  it('returns the input unchanged when there is no separator', () => {
    expect(basename('Mix.silverdaw')).toBe('Mix.silverdaw')
  })
})

describe('projectNameFromPath', () => {
  it('strips the folder and the .silverdaw extension', () => {
    expect(projectNameFromPath('C:\\Users\\me\\Summer Mix\\Summer Mix.silverdaw')).toBe('Summer Mix')
  })

  it('matches the extension case-insensitively', () => {
    expect(projectNameFromPath('/home/me/Demo/Demo.SILVERDAW')).toBe('Demo')
  })

  it('leaves a name without the extension untouched', () => {
    expect(projectNameFromPath('C:\\proj\\Untitled')).toBe('Untitled')
  })
})

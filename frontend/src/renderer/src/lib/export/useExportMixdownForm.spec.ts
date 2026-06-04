import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { useExportMixdownForm } from './useExportMixdownForm'
import { useProjectStore } from '@/stores/projectStore'

const sendMock = vi.hoisted(() => vi.fn())
const beginMixdownMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/bridgeService', () => ({ send: sendMock }))
vi.mock('@/lib/mixdownState', () => ({ beginMixdown: beginMixdownMock }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

const resolveMixdownDefaultPath = vi.fn(async () => 'C:/proj/mixdown/Song.wav')
const chooseMixdownSaveAs = vi.fn(async () => 'C:/proj/mixdown/Picked.wav')
const confirmMixdownOverwrite = vi.fn(async () => 'overwrite' as 'overwrite' | 'cancel')

function stubSilverdaw(): void {
  globalThis.window = {
    silverdaw: { resolveMixdownDefaultPath, chooseMixdownSaveAs, confirmMixdownOverwrite }
  } as unknown as Window & typeof globalThis
}

function makeForm(): ReturnType<typeof useExportMixdownForm> {
  return useExportMixdownForm({ requestClose: requestCloseMock })
}

const requestCloseMock = vi.fn()

describe('useExportMixdownForm', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    beginMixdownMock.mockClear()
    requestCloseMock.mockClear()
    resolveMixdownDefaultPath.mockClear()
    confirmMixdownOverwrite.mockClear()
    confirmMixdownOverwrite.mockResolvedValue('overwrite')
    stubSilverdaw()
  })

  it('availableBitDepths and ditherApplies track the selected format', () => {
    const f = makeForm()
    f.draftFormat.value = 'wav'
    f.draftBitDepth.value = 16
    expect(f.availableBitDepths.value).toEqual([16, 24, 32])
    expect(f.ditherApplies.value).toBe(true)
    f.draftBitDepth.value = 24
    expect(f.ditherApplies.value).toBe(false)
    f.draftFormat.value = 'flac'
    expect(f.availableBitDepths.value).toEqual([16, 24])
    f.draftFormat.value = 'mp3'
    expect(f.availableBitDepths.value).toEqual([])
    expect(f.ditherApplies.value).toBe(false)
  })

  it('switching format snaps an unsupported bit-depth and rewrites the path extension', async () => {
    const f = makeForm()
    f.draftOutputPath.value = 'C:/out/song.wav'
    f.draftFormat.value = 'wav'
    f.draftBitDepth.value = 32
    await nextTick()
    f.draftFormat.value = 'flac'
    await nextTick()
    expect(f.draftBitDepth.value).toBe(24)
    expect(f.draftOutputPath.value).toBe('C:/out/song.flac')
    expect(f.expectedFileExtension.value).toBe('flac')
  })

  it('loudness validation only gates the custom preset', () => {
    const f = makeForm()
    f.draftLoudnessPreset.value = 'off'
    expect(f.loudnessValid.value).toBe(true)
    f.draftLoudnessPreset.value = 'custom'
    f.draftCustomTargetText.value = '-14'
    f.draftCustomCeilingText.value = '-1'
    expect(f.customTargetValid.value).toBe(true)
    expect(f.customCeilingValid.value).toBe(true)
    expect(f.loudnessValid.value).toBe(true)
    f.draftCustomTargetText.value = '-2'
    expect(f.customTargetValid.value).toBe(false)
    expect(f.loudnessValid.value).toBe(false)
  })

  it('formIsValid requires a path, a valid duration and a valid tail', () => {
    const f = makeForm()
    f.draftLengthMode.value = 'fixed-duration'
    f.draftDurationText.value = '0:10'
    f.draftTailSecondsText.value = '0'
    expect(f.pathValid.value).toBe(false)
    expect(f.formIsValid.value).toBe(false)
    f.draftOutputPath.value = 'C:/out/song.wav'
    expect(f.formIsValid.value).toBe(true)
    f.draftTailSecondsText.value = '999'
    expect(f.tailValid.value).toBe(false)
    expect(f.formIsValid.value).toBe(false)
  })

  it('reseedOnOpen applies persisted settings over the base defaults', async () => {
    const project = useProjectStore()
    project.exportSettingsJson = JSON.stringify({
      version: 1,
      outputPath: 'C:/saved/out.flac',
      format: 'flac',
      sampleRate: 48000,
      bitDepth: 24,
      dither: false,
      tailSecondsText: '2',
      bitrate: 320,
      loudnessPreset: 'streaming-14',
      customTargetText: '-14',
      customCeilingText: '-1',
      lengthMode: 'trim-to-last-clip',
      durationText: '1:00',
      title: 'My Song',
      artist: 'Me',
      album: '',
      year: '',
      genre: '',
      comment: ''
    })
    const f = makeForm()
    await f.reseedOnOpen()
    expect(f.draftFormat.value).toBe('flac')
    expect(f.draftSampleRate.value).toBe(48000)
    expect(f.draftBitDepth.value).toBe(24)
    expect(f.draftLoudnessPreset.value).toBe('streaming-14')
    expect(f.draftLengthMode.value).toBe('trim-to-last-clip')
    expect(f.draftTitle.value).toBe('My Song')
    expect(f.draftOutputPath.value).toBe('C:/saved/out.flac')
    expect(resolveMixdownDefaultPath).not.toHaveBeenCalled()
  })

  it('reseedOnOpen derives a default path when none is persisted', async () => {
    const f = makeForm()
    await f.reseedOnOpen()
    expect(resolveMixdownDefaultPath).toHaveBeenCalledOnce()
    expect(f.draftOutputPath.value).toBe('C:/proj/mixdown/Song.wav')
    expect(f.draftFormat.value).toBe('wav')
  })

  it('onSave is a no-op while the form is invalid', () => {
    const f = makeForm()
    f.draftOutputPath.value = ''
    f.onSave()
    expect(sendMock).not.toHaveBeenCalled()
    expect(requestCloseMock).not.toHaveBeenCalled()
  })

  it('onSave dispatches MIXDOWN_START, persists settings and closes', async () => {
    const project = useProjectStore()
    const setExportSettingsJson = vi.spyOn(project, 'setExportSettingsJson')
    const f = makeForm()
    f.draftOutputPath.value = 'C:/out/song.wav'
    f.draftFormat.value = 'wav'
    f.draftSampleRate.value = 44100
    f.draftLengthMode.value = 'fixed-duration'
    f.draftDurationText.value = '0:30'
    f.draftTailSecondsText.value = '0'

    f.onSave()
    await Promise.resolve()
    await Promise.resolve()

    expect(confirmMixdownOverwrite).toHaveBeenCalledWith('C:/out/song.wav')
    expect(beginMixdownMock).toHaveBeenCalledWith('C:/out/song.wav', 'wav')
    expect(setExportSettingsJson).toHaveBeenCalledOnce()
    const startCall = sendMock.mock.calls.find((c) => c[0] === 'MIXDOWN_START')
    expect(startCall).toBeDefined()
    expect(startCall?.[1]).toMatchObject({
      outputPath: 'C:/out/song.wav',
      sampleRate: 44100,
      format: 'wav',
      lengthMode: 'fixed-duration',
      bitDepth: 16,
      dither: true
    })
    expect(requestCloseMock).toHaveBeenCalledOnce()
  })

  it('onSave stays open when the overwrite confirmation is declined', async () => {
    confirmMixdownOverwrite.mockResolvedValue('cancel')
    const f = makeForm()
    f.draftOutputPath.value = 'C:/out/song.wav'
    f.draftDurationText.value = '0:30'

    f.onSave()
    await Promise.resolve()
    await Promise.resolve()

    expect(sendMock).not.toHaveBeenCalledWith('MIXDOWN_START', expect.anything())
    expect(requestCloseMock).not.toHaveBeenCalled()
  })

  it('onBrowseClick stores the chosen path', async () => {
    const f = makeForm()
    await f.onBrowseClick()
    expect(chooseMixdownSaveAs).toHaveBeenCalled()
    expect(f.draftOutputPath.value).toBe('C:/proj/mixdown/Picked.wav')
  })

  it('mp3 export sends a bitrate instead of bit-depth', async () => {
    const f = makeForm()
    f.draftOutputPath.value = 'C:/out/song.mp3'
    f.draftFormat.value = 'mp3'
    f.draftBitrate.value = 320
    f.draftDurationText.value = '0:30'

    f.onSave()
    await Promise.resolve()
    await Promise.resolve()

    const startCall = sendMock.mock.calls.find((c) => c[0] === 'MIXDOWN_START')
    expect(startCall?.[1]).toMatchObject({ format: 'mp3', bitrateKbps: 320 })
    expect(startCall?.[1]).not.toHaveProperty('bitDepth')
  })
})

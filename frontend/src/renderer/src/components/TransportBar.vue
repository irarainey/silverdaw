<script setup lang="ts">
// Transport controls and project timing readouts.

import TransportOutputSection from '@/components/TransportOutputSection.vue'
import TransportPlaybackControls from '@/components/TransportPlaybackControls.vue'
import TransportTimingDisplay from '@/components/TransportTimingDisplay.vue'
import { useTransportBarController } from '@/lib/transport/useTransportBarController'

const {
  project,
  transport,
  ui,
  audioDevices,
  audioMenuOpen,
  setAudioMenuRoot,
  audioMenuLabel,
  audioLatencyCaption,
  quickSwitchDevices,
  toggleAudioMenu,
  pickUniqueDevice,
  isCurrentUniqueDevice,
  positionDisplay,
  barPosition,
  effectiveSampleRateLabel,
  lengthInput,
  isEditingLength,
  bpmInput,
  isEditingBpm,
  lengthEditable,
  timingEditable,
  projectBpmPending,
  playDisabled,
  playButtonTitle,
  skipBackTitle,
  skipForwardTitle,
  onLengthCommit,
  onLengthKeydown,
  bumpLength,
  onBpmCommit,
  onBpmKeydown,
  bumpBpm,
  onSkipBack,
  onPlay,
  onSkipForward,
  onToggleFollow,
  onToggleLoopSelection,
  onMasterVolumeInput
} = useTransportBarController()
</script>

<template>
  <header
    class="flex h-16 w-full select-none items-center justify-between border-b border-zinc-800 bg-zinc-900 px-4 text-zinc-300"
  >
    <TransportOutputSection
      v-model:audio-menu-open="audioMenuOpen"
      :audio-devices="audioDevices"
      :audio-menu-label="audioMenuLabel"
      :audio-latency-caption="audioLatencyCaption"
      :quick-switch-devices="quickSwitchDevices"
      :master-volume="project.masterVolume"
      :set-audio-menu-root="setAudioMenuRoot"
      :toggle-audio-menu="toggleAudioMenu"
      :pick-unique-device="pickUniqueDevice"
      :is-current-unique-device="isCurrentUniqueDevice"
      :on-master-volume-input="onMasterVolumeInput"
    />

    <TransportPlaybackControls
      :is-playing="transport.isPlaying"
      :is-playback-held="transport.isPlaybackHeld"
      :follow-playback="ui.followPlayback"
      :has-timeline-selection="ui.timelineSelection !== null"
      :loop-timeline-selection="ui.loopTimelineSelection"
      :skip-back-title="skipBackTitle"
      :play-button-title="playButtonTitle"
      :play-disabled="playDisabled"
      :skip-forward-title="skipForwardTitle"
      @skip-back="onSkipBack"
      @play="onPlay"
      @skip-forward="onSkipForward"
      @toggle-follow="onToggleFollow"
      @toggle-loop-selection="onToggleLoopSelection"
    />

    <TransportTimingDisplay
      v-model:length-input="lengthInput"
      v-model:bpm-input="bpmInput"
      v-model:is-editing-length="isEditingLength"
      v-model:is-editing-bpm="isEditingBpm"
      :position-display="positionDisplay"
      :bar-position="barPosition"
      :timing-editable="timingEditable"
      :length-editable="lengthEditable"
      :project-bpm-pending="projectBpmPending"
      :effective-sample-rate-label="effectiveSampleRateLabel"
      :metronome-enabled="project.metronomeEnabled"
      @length-commit="onLengthCommit"
      @length-keydown="onLengthKeydown"
      @bump-length="bumpLength"
      @bpm-commit="onBpmCommit"
      @bpm-keydown="onBpmKeydown"
      @bump-bpm="bumpBpm"
      @toggle-metronome="project.setMetronomeEnabled(!project.metronomeEnabled)"
    />
  </header>
</template>

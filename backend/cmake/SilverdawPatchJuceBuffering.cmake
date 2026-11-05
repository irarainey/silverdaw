function(silverdaw_patch_juce_buffering source_dir)
    set(buffering_source "${source_dir}/modules/juce_audio_basics/sources/juce_BufferingAudioSource.cpp")
    file(READ "${buffering_source}" content)
    set(original [=[        do
        {
            const ScopedUnlock ul (bufferRangeLock);

            backgroundThread.moveToFrontOfQueue (this);
            Thread::sleep (5);
        }
        while (prefillBuffer
         && (bufferValidEnd - bufferValidStart < jmin (((int) newSampleRate) / 4, buffer.getNumSamples() / 2)));]=])
    string(REPLACE "Thread::sleep (5);" "bufferReadyEvent.wait (5);" patched "${original}")

    string(FIND "${content}" "${patched}" patched_at)
    if(NOT patched_at EQUAL -1)
        return()
    endif()
    string(FIND "${content}" "${original}" original_at)
    if(original_at EQUAL -1)
        message(FATAL_ERROR "JUCE buffering preparation changed; review the event-driven prefill fix")
    endif()

    # Keep the full prefill barrier, but wake when a chunk arrives instead of
    # imposing a five-millisecond polling floor on every clip.
    string(REPLACE "${original}" "${patched}" content "${content}")
    file(WRITE "${buffering_source}" "${content}")
endfunction()

function(silverdaw_patch_juce_resampling source_dir)
    set(source_file "${source_dir}/modules/juce_audio_basics/sources/juce_ResamplingAudioSource.cpp")
    set(header_file "${source_dir}/modules/juce_audio_basics/sources/juce_ResamplingAudioSource.h")
    file(READ "${source_file}" content)
    file(READ "${header_file}" header)
    string(REPLACE "\r\n" "\n" content "${content}")
    string(REPLACE "\r\n" "\n" header "${header}")

    set(original [=[    for (int m = info.numSamples; --m >= 0;)
    {
        jassert (sampsInBuffer > 0 && nextPos != endOfBufferPos);

        const float alpha = (float) subSampleOffset;

        for (int channel = 0; channel < channelsToProcess; ++channel)
            *destBuffers[channel]++ = srcBuffers[channel][bufferPos]
                                        + alpha * (srcBuffers[channel][nextPos] - srcBuffers[channel][bufferPos]);

        subSampleOffset += localRatio;

        while (subSampleOffset >= 1.0)
        {
            if (++bufferPos >= bufferSize)
                bufferPos = 0;

            --sampsInBuffer;

            nextPos = (bufferPos + 1) % bufferSize;
            subSampleOffset -= 1.0;
        }
    }]=])
    string(REPLACE "\n" "\n    " indented "${original}")
    set(indented "    ${indented}")
    set(patched [=[    if (localRatio == 1.0 && subSampleOffset == 0.0)
    {
        // Keep a + 0 * (b - a), including signed zero and non-finite propagation.
        int remaining = info.numSamples;
        while (remaining > 0)
        {
            jassert (sampsInBuffer > 0 && nextPos != endOfBufferPos);
            const int count = jmin (remaining, bufferSize - bufferPos - 1, sampsInBuffer - 1);
            if (count > 0)
            {
                for (int channel = 0; channel < channelsToProcess; ++channel)
                {
                    auto* dest = destBuffers[channel];
                    const auto* current = srcBuffers[channel] + bufferPos;
                    FloatVectorOperations::subtract (dest, current + 1, current, count);
                    FloatVectorOperations::multiply (dest, 0.0f, count);
                    FloatVectorOperations::add (dest, current, dest, count);
                    destBuffers[channel] += count;
                }
                bufferPos += count;
                sampsInBuffer -= count;
                remaining -= count;
            }
            else
            {
                for (int channel = 0; channel < channelsToProcess; ++channel)
                    *destBuffers[channel]++ = srcBuffers[channel][bufferPos]
                        + 0.0f * (srcBuffers[channel][nextPos] - srcBuffers[channel][bufferPos]);
                if (++bufferPos == bufferSize) bufferPos = 0;
                --sampsInBuffer;
                --remaining;
            }
            nextPos = (bufferPos + 1) % bufferSize;
        }
    }
    else
    {
@SCALAR@
    }]=])
    string(REPLACE "@SCALAR@" "${indented}" patched "${patched}")
    string(REPLACE "${patched}" "${original}" scalar_content "${content}")
    string(SHA256 scalar_hash "${scalar_content}")
    string(SHA256 header_hash "${header}")
    if(NOT scalar_hash STREQUAL "9f28152ebb0ae143b49f27ef16827d93015c746f4b671016925a6af4602ccafb"
       OR NOT header_hash STREQUAL "ec0ff6b6dfa045ff80e7b15f56ac18b8ad95f7ac047b86bae02161ecf9ee09dc")
        message(FATAL_ERROR "JUCE resampling changed; review the unity-rate vectorisation and scalar reference")
    endif()

    # The native tests compare the full original state machine against the patched one.
    string(REPLACE "namespace juce" "namespace silverdaw_resampling_reference" reference_source "${scalar_content}")
    string(REPLACE "namespace juce" "namespace silverdaw_resampling_reference" reference_header "${header}")
    file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/generated")
    file(CONFIGURE OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/generated/SilverdawScalarResampling.cpp"
         CONTENT "${reference_source}" @ONLY)
    file(CONFIGURE OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/generated/SilverdawScalarResampling.h"
         CONTENT "${reference_header}" @ONLY)

    string(REPLACE "${original}" "${patched}" next_content "${scalar_content}")
    if(NOT content STREQUAL next_content)
        file(WRITE "${source_file}" "${next_content}")
    endif()
endfunction()

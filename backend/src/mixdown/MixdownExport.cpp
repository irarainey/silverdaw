#include "MixdownExport.h"

#include "Log.h"

#include <juce_audio_formats/juce_audio_formats.h>

#if JUCE_WINDOWS
#include <windows.h>
#endif

namespace silverdaw::mixdown_export
{

juce::File findLameExecutable()
{
    const auto exeDir = juce::File::getSpecialLocation(
                            juce::File::currentExecutableFile)
                            .getParentDirectory();
#if JUCE_WINDOWS
    return exeDir.getChildFile("lame.exe");
#else
    return exeDir.getChildFile("lame");
#endif
}

int lameQualityIndexForCbr(int kbps)
{
    switch (kbps)
    {
        case 32:  return 10;
        case 40:  return 11;
        case 48:  return 12;
        case 56:  return 13;
        case 64:  return 14;
        case 80:  return 15;
        case 96:  return 16;
        case 112: return 17;
        case 128: return 18;
        case 160: return 19;
        case 192: return 20;
        case 224: return 21;
        case 256: return 22;
        case 320: return 23;
        default:  return 20; // 192 kbps fallback
    }
}

std::unordered_map<juce::String, juce::String>
buildMp3MetadataMap(const ExportMetadata& md)
{
    std::unordered_map<juce::String, juce::String> m;
    if (md.title.isNotEmpty())   m["id3title"]   = md.title;
    if (md.artist.isNotEmpty())  m["id3artist"]  = md.artist;
    if (md.album.isNotEmpty())   m["id3album"]   = md.album;
    if (md.year.isNotEmpty())    m["id3date"]    = md.year;
    if (md.genre.isNotEmpty())   m["id3genre"]   = md.genre;
    if (md.comment.isNotEmpty()) m["id3comment"] = md.comment;
    return m;
}

std::unordered_map<juce::String, juce::String>
buildWavMetadataMap(const ExportMetadata& md)
{
    std::unordered_map<juce::String, juce::String> m;
    if (md.title.isNotEmpty())   m[juce::WavAudioFormat::riffInfoTitle]        = md.title;
    if (md.artist.isNotEmpty())  m[juce::WavAudioFormat::riffInfoArtist]       = md.artist;
    if (md.album.isNotEmpty())   m[juce::WavAudioFormat::riffInfoProductName]  = md.album;
    if (md.year.isNotEmpty())    m[juce::WavAudioFormat::riffInfoDateCreated]  = md.year;
    if (md.genre.isNotEmpty())   m[juce::WavAudioFormat::riffInfoGenre]        = md.genre;
    if (md.comment.isNotEmpty()) m[juce::WavAudioFormat::riffInfoComment2]     = md.comment;
    return m;
}

// JUCE 8 lacks some tag hooks, so FLAC/AIFF metadata is post-processed after encode.
bool writeAiffTextChunks(const juce::File& aiffFile, const ExportMetadata& md)
{
    if (md.isEmpty())
        return true;

    juce::MemoryBlock buf;
    if (! aiffFile.loadFileAsData(buf))
    {
        silverdaw::log::warn("mixdown", "AIFF metadata: failed to read file for rewrite");
        return false;
    }

    auto* data = static_cast<const juce::uint8*>(buf.getData());
    const size_t size = buf.getSize();
    if (size < 12
        || data[0] != 'F' || data[1] != 'O' || data[2] != 'R' || data[3] != 'M'
        || data[8] != 'A' || data[9] != 'I' || data[10] != 'F' || data[11] != 'F')
    {
        silverdaw::log::warn("mixdown", "AIFF metadata: file missing FORM/AIFF header; skipping tags");
        return false;
    }

    struct TextChunk { const char fourcc[4]; const juce::String* value; };
    const TextChunk chunks[] = {
        { {'N','A','M','E'}, &md.title   },
        { {'A','U','T','H'}, &md.artist  },
        { {'(','c',')',' '}, &md.comment }, // closest standard AIFF "copyright/comment" chunk
        { {'A','N','N','O'}, &md.album   }, // ANNO is free-form annotation; used here for album
    };
    juce::String anno;
    if (md.album.isNotEmpty()) anno = md.album;
    if (md.year.isNotEmpty())
        anno = anno.isNotEmpty() ? (anno + " | Year: " + md.year)  : ("Year: "  + md.year);
    if (md.genre.isNotEmpty())
        anno = anno.isNotEmpty() ? (anno + " | Genre: " + md.genre) : ("Genre: " + md.genre);

    juce::MemoryBlock inserted;
    auto appendChunk = [&inserted](const char* fourcc, const juce::String& s)
    {
        if (s.isEmpty()) return;
        const auto utf8 = s.toRawUTF8();
        const auto len = (juce::uint32) std::strlen(utf8);
        const juce::uint8 hdr[8] = {
            (juce::uint8) fourcc[0], (juce::uint8) fourcc[1],
            (juce::uint8) fourcc[2], (juce::uint8) fourcc[3],
            (juce::uint8) ((len >> 24) & 0xFF), (juce::uint8) ((len >> 16) & 0xFF),
            (juce::uint8) ((len >> 8)  & 0xFF), (juce::uint8) ( len        & 0xFF),
        };
        inserted.append(hdr, 8);
        inserted.append(utf8, len);
        if ((len & 1u) != 0u)
        {
            const juce::uint8 pad = 0;
            inserted.append(&pad, 1);
        }
    };

    appendChunk("NAME", md.title);
    appendChunk("AUTH", md.artist);
    appendChunk("(c) ", md.comment);
    appendChunk("ANNO", anno);

    if (inserted.getSize() == 0)
        return true;

    if (inserted.getSize() > (size_t) std::numeric_limits<juce::uint32>::max() - size)
    {
        silverdaw::log::warn("mixdown", "AIFF metadata: insertion would overflow FORM size; skipping tags");
        return false;
    }

    juce::MemoryBlock out;
    out.append(data, 12);
    out.append(inserted.getData(), inserted.getSize());
    out.append(data + 12, size - 12);

    const juce::uint32 newFormSize = (juce::uint32) (out.getSize() - 8);
    auto* outBytes = static_cast<juce::uint8*>(out.getData());
    outBytes[4] = (juce::uint8) ((newFormSize >> 24) & 0xFF);
    outBytes[5] = (juce::uint8) ((newFormSize >> 16) & 0xFF);
    outBytes[6] = (juce::uint8) ((newFormSize >> 8)  & 0xFF);
    outBytes[7] = (juce::uint8) ( newFormSize        & 0xFF);

    auto tmp = aiffFile.getSiblingFile(aiffFile.getFileNameWithoutExtension() + ".tagtmp.aiff");
    if (! tmp.replaceWithData(out.getData(), out.getSize()))
    {
        silverdaw::log::warn("mixdown", "AIFF metadata: failed to write temp; tags not applied");
        return false;
    }
    if (! atomicReplace(tmp, aiffFile))
    {
        tmp.deleteFile();
        silverdaw::log::warn("mixdown", "AIFF metadata: failed to rename temp over output");
        return false;
    }
    silverdaw::log::info("mixdown", "AIFF metadata: wrote text chunks ("
                                       + juce::String((int) inserted.getSize()) + " bytes)");
    return true;
}

bool writeFlacVorbisComment(const juce::File& flacFile, const ExportMetadata& md)
{
    if (md.isEmpty())
        return true;

    juce::MemoryBlock buf;
    if (! flacFile.loadFileAsData(buf))
    {
        silverdaw::log::warn("mixdown", "FLAC metadata: failed to read file for rewrite");
        return false;
    }

    auto* data = static_cast<const juce::uint8*>(buf.getData());
    const size_t size = buf.getSize();
    if (size < 8 || data[0] != 'f' || data[1] != 'L' || data[2] != 'a' || data[3] != 'C')
    {
        silverdaw::log::warn("mixdown", "FLAC metadata: file missing fLaC magic; skipping tags");
        return false;
    }

    size_t pos = 4;
    size_t lastBlockHeaderPos = pos;
    bool sawLast = false;
    size_t existingVcStart = 0;
    size_t existingVcEnd = 0;
    bool hasExistingVc = false;
    while (pos <= size && size - pos >= 4)
    {
        const size_t headerPos = pos;
        const bool isLast = (data[pos] & 0x80) != 0;
        const juce::uint32 blockType = (juce::uint32) (data[pos] & 0x7F);
        const juce::uint32 blockLen = (juce::uint32(data[pos + 1]) << 16)
                                    | (juce::uint32(data[pos + 2]) << 8)
                                    |  juce::uint32(data[pos + 3]);
        const size_t nextPos = pos + 4 + blockLen;
        if (nextPos > size)
        {
            silverdaw::log::warn("mixdown", "FLAC metadata: block walk overran file; skipping tags");
            return false;
        }
        if (blockType == 4)
        {
            hasExistingVc = true;
            existingVcStart = headerPos;
            existingVcEnd = nextPos;
        }
        else
        {
            lastBlockHeaderPos = headerPos;
        }
        pos = nextPos;
        if (isLast) { sawLast = true; break; }
    }
    if (! sawLast)
    {
        silverdaw::log::warn("mixdown", "FLAC metadata: no last-block flag found; skipping tags");
        return false;
    }

    auto buildPayload = [&]()
    {
        juce::MemoryOutputStream mos;
        const juce::String vendor = "Silverdaw / JUCE FLAC";
        const auto vendorUtf8 = vendor.toRawUTF8();
        const auto vendorLen = (juce::uint32) std::strlen(vendorUtf8);
        mos.writeInt((int) vendorLen);                                   // u32 LE
        mos.write(vendorUtf8, vendorLen);

        struct Field { const char* key; const juce::String* value; };
        const Field fields[] = {
            { "TITLE",   &md.title   },
            { "ARTIST",  &md.artist  },
            { "ALBUM",   &md.album   },
            { "DATE",    &md.year    },
            { "GENRE",   &md.genre   },
            { "COMMENT", &md.comment },
        };
        juce::Array<juce::String> entries;
        for (const auto& f : fields)
            if (f.value->isNotEmpty())
                entries.add(juce::String(f.key) + "=" + *f.value);

        mos.writeInt((int) entries.size());                              // u32 LE
        for (const auto& e : entries)
        {
            const auto utf8 = e.toRawUTF8();
            const auto len = (juce::uint32) std::strlen(utf8);
            mos.writeInt((int) len);                                     // u32 LE
            mos.write(utf8, len);
        }

        juce::MemoryBlock out;
        mos.flush();
        out.append(mos.getData(), mos.getDataSize());
        return out;
    };

    const auto payload = buildPayload();
    if (payload.getSize() > 0x00FFFFFF)
    {
        silverdaw::log::warn("mixdown", "FLAC metadata: payload too large for one block; skipping tags");
        return false;
    }

    juce::MemoryBlock out;

    if (hasExistingVc)
    {
        out.append(data, existingVcStart);
        out.append(data + existingVcEnd, pos - existingVcEnd);
    }
    else
    {
        out.append(data, pos);
    }

    size_t lastFlagPosInOut = lastBlockHeaderPos;
    if (hasExistingVc && existingVcStart < lastBlockHeaderPos)
        lastFlagPosInOut -= (existingVcEnd - existingVcStart);
    static_cast<juce::uint8*>(out.getData())[lastFlagPosInOut] &= 0x7F;

    const juce::uint32 plen = (juce::uint32) payload.getSize();
    const juce::uint8 vcHeader[4] = {
        (juce::uint8) 0x84,
        (juce::uint8) ((plen >> 16) & 0xFF),
        (juce::uint8) ((plen >> 8)  & 0xFF),
        (juce::uint8) ( plen        & 0xFF),
    };
    out.append(vcHeader, 4);
    out.append(payload.getData(), payload.getSize());

    out.append(data + pos, size - pos);

    auto tmp = flacFile.getSiblingFile(flacFile.getFileNameWithoutExtension() + ".tagtmp.flac");
    if (! tmp.replaceWithData(out.getData(), out.getSize()))
    {
        silverdaw::log::warn("mixdown", "FLAC metadata: failed to write temp; tags not applied");
        return false;
    }
    if (! atomicReplace(tmp, flacFile))
    {
        tmp.deleteFile();
        silverdaw::log::warn("mixdown", "FLAC metadata: failed to rename temp over output");
        return false;
    }
    silverdaw::log::info("mixdown", "FLAC metadata: wrote VORBIS_COMMENT block ("
                                       + juce::String((int) payload.getSize()) + " bytes)");
    return true;
}

// Write caches to a sibling temp file so partial entries are never visible.
bool atomicReplace(const juce::File& tmp, const juce::File& target)
{
#if JUCE_WINDOWS
    const auto tmpPath = tmp.getFullPathName();
    const auto targetPath = target.getFullPathName();
    return ::MoveFileExW(tmpPath.toWideCharPointer(), targetPath.toWideCharPointer(),
                         MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
#else
    target.deleteFile();
    return tmp.moveFileTo(target);
#endif
}

std::unique_ptr<juce::AudioFormatWriter> createOutputWriter(
    MixdownOptions::Format format,
    const juce::AudioFormatWriterOptions& baseOptions,
    const juce::File& lameApp,
    const ExportMetadata& metadata,
    int bitrateKbps,
    std::unique_ptr<juce::OutputStream>& stream)
{
    if (format == MixdownOptions::Format::Wav)
    {
        juce::WavAudioFormat wav;
        auto wavOpts = baseOptions.withMetadataValues(buildWavMetadataMap(metadata));
        return wav.createWriterFor(stream, wavOpts);
    }
    if (format == MixdownOptions::Format::Flac)
    {
        juce::FlacAudioFormat flac;
        return flac.createWriterFor(stream, baseOptions);
    }
    if (format == MixdownOptions::Format::Aiff)
    {
        juce::AiffAudioFormat aiff;
        return aiff.createWriterFor(stream, baseOptions);
    }
    if (format == MixdownOptions::Format::Mp3)
    {
        juce::LAMEEncoderAudioFormat lame(lameApp);
        auto lameOpts = baseOptions
                            .withBitsPerSample(16)
                            .withSampleFormat(
                                juce::AudioFormatWriterOptions::SampleFormat::integral)
                            .withQualityOptionIndex(lameQualityIndexForCbr(bitrateKbps))
                            .withMetadataValues(buildMp3MetadataMap(metadata));
        return lame.createWriterFor(stream, lameOpts);
    }
    return nullptr;
}

} // namespace silverdaw::mixdown_export

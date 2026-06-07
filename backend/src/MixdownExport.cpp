#include "MixdownExport.h"

#include "Log.h"

#include <juce_audio_formats/juce_audio_formats.h>

#if JUCE_WINDOWS
#include <windows.h>
#endif

namespace silverdaw::mixdown_export
{

// ── MP3 / LAME helpers ──────────────────────────────────────────────
// JUCE's LAMEEncoderAudioFormat shells out to a `lame.exe` child
// process. We bundle it next to SilverdawBackend.exe via CMake; this
// helper finds it relative to the current executable.
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

// Map a CBR bitrate (kbps) to JUCE's LAMEEncoderAudioFormat quality
// option index. The wrapper's option list is 10 VBR levels (0..9)
// followed by CBR rates { 32, 40, 48, 56, 64, 80, 96, 112, 128, 160,
// 192, 224, 256, 320 } — so CBR indices start at 10.
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
    // LAME (via JUCE's LAMEEncoderAudioFormat) recognises these id3*
    // keys and writes them as ID3v2 frames. Year maps to id3date.
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
    // JUCE's WavAudioFormat writes a RIFF INFO chunk for these keys.
    // INAM/IART/IPRD/ICRD/IGNR/ICMT are the canonical RIFF INFO IDs;
    // Explorer's Details pane and foobar2000/MediaMonkey read them.
    std::unordered_map<juce::String, juce::String> m;
    if (md.title.isNotEmpty())   m[juce::WavAudioFormat::riffInfoTitle]        = md.title;
    if (md.artist.isNotEmpty())  m[juce::WavAudioFormat::riffInfoArtist]       = md.artist;
    if (md.album.isNotEmpty())   m[juce::WavAudioFormat::riffInfoProductName]  = md.album;
    if (md.year.isNotEmpty())    m[juce::WavAudioFormat::riffInfoDateCreated]  = md.year;
    if (md.genre.isNotEmpty())   m[juce::WavAudioFormat::riffInfoGenre]        = md.genre;
    // riffInfoComment2 ("ICMT") is the standard RIFF INFO comment ID; the
    // bare riffInfoComment ("CMNT") is a JUCE-specific extension that few
    // players read. Use the standard one.
    if (md.comment.isNotEmpty()) m[juce::WavAudioFormat::riffInfoComment2]     = md.comment;
    return m;
}

/**
 * Insert AIFF text metadata chunks (NAME, AUTH, (c) , ANNO) into an
 * already-written AIFF file. JUCE 8's `AiffAudioFormat` writer ignores
 * the metadata map passed via `withMetadataValues`, so we patch the
 * container after the fact.
 *
 * AIFF/FORM layout:
 *   "FORM" + u32 BE form-size + "AIFF" + sub-chunks
 *
 * Each sub-chunk: 4-byte FOURCC + u32 BE data-size + data + optional
 * 1-byte pad if data-size is odd. We insert our text chunks immediately
 * after the "AIFF" FOURCC (before COMM) and bump the outer form-size.
 *
 * Text chunks carry the raw string bytes (no length prefix, no NUL).
 */
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
    // Year + genre have no standard AIFF text chunk. We fold them into an
    // extra ANNO line so they aren't silently dropped.
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

    // Compose: bytes 0..11 (FORM + size + AIFF) + inserted chunks + remainder.
    juce::MemoryBlock out;
    out.append(data, 12);
    out.append(inserted.getData(), inserted.getSize());
    out.append(data + 12, size - 12);

    // Patch the outer FORM size (big-endian u32 at offset 4). The size
    // excludes the "FORM" FOURCC and the size field itself, so it is
    // `total file size - 8`.
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
    if (! tmp.moveFileTo(aiffFile))
    {
        tmp.deleteFile();
        silverdaw::log::warn("mixdown", "AIFF metadata: failed to rename temp over output");
        return false;
    }
    silverdaw::log::info("mixdown", "AIFF metadata: wrote text chunks ("
                                       + juce::String((int) inserted.getSize()) + " bytes)");
    return true;
}

/**
 * Insert a VORBIS_COMMENT metadata block into an already-written FLAC
 * file. JUCE 8's `FlacAudioFormat` does not expose any metadata-writing
 * hook, so we do it ourselves by rewriting the file's metadata block
 * region (the audio frames are left bit-identical).
 *
 * FLAC layout: "fLaC" magic (4 bytes) + one or more metadata blocks +
 * audio frames. Each metadata block has a 4-byte header: top bit of
 * byte 0 = "is last block", lower 7 bits = block type (4 = VORBIS_
 * COMMENT), bytes 1..3 = block length big-endian.
 *
 * Strategy: walk metadata blocks until we find the last one, clear its
 * "is last block" flag, append our VORBIS_COMMENT block (with the flag
 * set) before the audio frames, write the result atomically.
 */
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

    // Walk metadata blocks. Track:
    //   - lastBlockHeaderPos: header offset of the previous "last" block
    //     (so we can clear its top bit).
    //   - existingVcStart / existingVcEnd: byte range of any pre-existing
    //     VORBIS_COMMENT block. FLAC permits at most one (RFC 9639), so
    //     if one is present we DROP it and emit our own as the new last
    //     block. (JUCE's FlacAudioFormat never writes one, so the common
    //     case is no existing block — but be robust if this helper runs
    //     against a file that already has tags.)
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
    // `pos` now points at the first byte of audio frames.

    // Build the VORBIS_COMMENT payload: vendor_length (LE u32) +
    // vendor_string + num_comments (LE u32) + N × (length LE u32 +
    // "FIELD=value" bytes). Strings are UTF-8.
    auto buildPayload = [&]()
    {
        juce::MemoryOutputStream mos;
        const juce::String vendor = "Silverdaw / JUCE FLAC";
        const auto vendorUtf8 = vendor.toRawUTF8();
        const auto vendorLen = (juce::uint32) std::strlen(vendorUtf8);
        // VORBIS_COMMENT integer fields are LITTLE-ENDIAN per the Vorbis
        // I spec (unlike FLAC headers which are big-endian).
        // juce::MemoryOutputStream::writeInt is little-endian.
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

    // Compose the rewritten file. We append progressively; the
    // MemoryBlock grows as needed. (Do NOT call ensureSize here — that
    // sets the logical size and `append` would write *after* it,
    // leaving the file with leading garbage.)
    juce::MemoryBlock out;

    // (a) copy through the metadata region, skipping any pre-existing
    //     VORBIS_COMMENT block (we replace it with our own).
    if (hasExistingVc)
    {
        out.append(data, existingVcStart);
        out.append(data + existingVcEnd, pos - existingVcEnd);
    }
    else
    {
        out.append(data, pos);
    }

    // (b) clear the "is last block" flag on the original last
    //     non-Vorbis metadata block. After step (a), that header byte
    //     sits at the same offset in `out` as in `data`, UNLESS the
    //     skipped VORBIS_COMMENT block sat before it, in which case
    //     the offset shifts down by the VC block's length.
    size_t lastFlagPosInOut = lastBlockHeaderPos;
    if (hasExistingVc && existingVcStart < lastBlockHeaderPos)
        lastFlagPosInOut -= (existingVcEnd - existingVcStart);
    static_cast<juce::uint8*>(out.getData())[lastFlagPosInOut] &= 0x7F;

    // (c) our VORBIS_COMMENT block header: 0x84 = last-block | type 4.
    const juce::uint32 plen = (juce::uint32) payload.getSize();
    const juce::uint8 vcHeader[4] = {
        (juce::uint8) 0x84,
        (juce::uint8) ((plen >> 16) & 0xFF),
        (juce::uint8) ((plen >> 8)  & 0xFF),
        (juce::uint8) ( plen        & 0xFF),
    };
    out.append(vcHeader, 4);
    out.append(payload.getData(), payload.getSize());

    // (d) the original audio frames (everything after the metadata region).
    out.append(data + pos, size - pos);

    // Atomic-ish: write to a sibling temp then rename over the target.
    auto tmp = flacFile.getSiblingFile(flacFile.getFileNameWithoutExtension() + ".tagtmp.flac");
    if (! tmp.replaceWithData(out.getData(), out.getSize()))
    {
        silverdaw::log::warn("mixdown", "FLAC metadata: failed to write temp; tags not applied");
        return false;
    }
    if (! tmp.moveFileTo(flacFile))
    {
        tmp.deleteFile();
        silverdaw::log::warn("mixdown", "FLAC metadata: failed to rename temp over output");
        return false;
    }
    silverdaw::log::info("mixdown", "FLAC metadata: wrote VORBIS_COMMENT block ("
                                       + juce::String((int) payload.getSize()) + " bytes)");
    return true;
}

// Atomic "<file>.tmp" → "<file>" finalize. Same code as before.
bool atomicReplace(const juce::File& tmp, const juce::File& target)
{
#if JUCE_WINDOWS
    const auto tmpStr = tmp.getFullPathName().toWideCharPointer();
    const auto targetStr = target.getFullPathName().toWideCharPointer();
    return ::MoveFileExW(tmpStr, targetStr,
                         MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
#else
    target.deleteFile();
    return tmp.moveFileTo(target);
#endif
}

} // namespace silverdaw::mixdown_export

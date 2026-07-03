#include "CrashHandler.h"

#if defined(_WIN32)

#include <atomic>
#include <cstring>
#include <windows.h>

namespace silverdaw::crash
{
namespace
{
// State the fault handler reads at crash time. The path is pre-rendered at
// install time so the handler itself does no heap/CRT string work while the
// process is already in a faulted state.
char g_crashLogPath[1024] = {0};
std::atomic<const char*> g_phase{"startup"};

LONG WINAPI unhandledFilter(EXCEPTION_POINTERS* info)
{
    if (g_crashLogPath[0] == '\0')
    {
        return EXCEPTION_EXECUTE_HANDLER;
    }

    // Win32 file I/O only — avoid the CRT/heap in a crash context.
    const HANDLE file = CreateFileA(g_crashLogPath, GENERIC_WRITE, FILE_SHARE_READ, nullptr,
                                    CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file != INVALID_HANDLE_VALUE)
    {
        const EXCEPTION_RECORD* rec = info != nullptr ? info->ExceptionRecord : nullptr;
        const void* address = rec != nullptr ? rec->ExceptionAddress : nullptr;
        const DWORD code = rec != nullptr ? rec->ExceptionCode : 0;

        // Resolve the faulting module (which DLL/exe the crash address is in).
        char modulePath[MAX_PATH] = "unknown";
        HMODULE module = nullptr;
        if (address != nullptr &&
            GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                                   GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                               static_cast<LPCSTR>(address), &module) &&
            module != nullptr)
        {
            GetModuleFileNameA(module, modulePath, MAX_PATH);
        }

        const char* phase = g_phase.load(std::memory_order_relaxed);

        // wsprintfA (not the CRT) formats without touching the heap. %I64X carries
        // the 64-bit fault address; the access-violation read/write flag and target
        // address (params 0 and 1) pinpoint a null / bad-pointer dereference.
        char buffer[2048];
        const auto* params = rec != nullptr ? rec->ExceptionInformation : nullptr;
        const int length = wsprintfA(
            buffer,
            "Silverdaw backend crash\r\n"
            "phase=%s\r\n"
            "exceptionCode=0x%08X\r\n"
            "faultAddress=0x%I64X\r\n"
            "module=%s\r\n"
            "accessType=%I64u accessAddress=0x%I64X\r\n",
            phase != nullptr ? phase : "?", code,
            static_cast<unsigned __int64>(reinterpret_cast<UINT_PTR>(address)), modulePath,
            params != nullptr ? static_cast<unsigned __int64>(params[0]) : 0ULL,
            params != nullptr ? static_cast<unsigned __int64>(params[1]) : 0ULL);

        DWORD written = 0;
        WriteFile(file, buffer, static_cast<DWORD>(length), &written, nullptr);
        FlushFileBuffers(file);
        CloseHandle(file);
    }

    // We have logged what we can; let the process terminate. The backend cannot
    // function past a hard fault, and continuing risks corrupt state.
    return EXCEPTION_EXECUTE_HANDLER;
}
} // namespace

void install(const juce::String& diagDir)
{
    if (diagDir.isEmpty())
    {
        return;
    }
    juce::File dir(diagDir);
    dir.createDirectory();
    const auto stamp = juce::Time::getCurrentTime().formatted("%Y-%m-%dT%H-%M-%S");
    const auto path = dir.getChildFile("backend-crash-" + stamp + ".log").getFullPathName();
    // Copy into the static buffer so the fault handler needs no allocation.
    strncpy_s(g_crashLogPath, sizeof(g_crashLogPath), path.toRawUTF8(), _TRUNCATE);
    SetUnhandledExceptionFilter(&unhandledFilter);
}

void setPhase(const char* phase)
{
    g_phase.store(phase, std::memory_order_relaxed);
}

} // namespace silverdaw::crash

#else

namespace silverdaw::crash
{
void install(const juce::String&) {}
void setPhase(const char*) {}
} // namespace silverdaw::crash

#endif

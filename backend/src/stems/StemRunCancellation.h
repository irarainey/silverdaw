#pragma once

#include <atomic>
#include <chrono>
#include <functional>
#include <thread>

#include <onnxruntime_cxx_api.h>

#include "StemSeparator.h"

namespace silverdaw::stems
{

// Runs one ONNX inference with prompt, mid-run cancellation.
//
// `runFn(runOptions)` performs the actual `Ort::Session::Run(...)` using the
// supplied RunOptions. While it executes, a lightweight watcher thread polls
// `shouldCancel()` and, the moment it returns true, calls
// `RunOptions::SetTerminate()` — ONNX Runtime then aborts the in-flight run at
// the next op boundary (typically well under a second) instead of the caller
// having to wait for the whole ~8-11 s chunk to finish. The watcher is always
// joined before `runOptions` is destroyed.
//
// A terminate surfaces as an `Ort::Exception`; when a cancel is in effect this
// is translated to `StemSeparationError(Cancelled)` so it flows through the
// normal cancellation path rather than being reported as an inference failure.
// Any genuine ONNX error is rethrown unchanged.
template <typename RunFn>
void runCancellable(const std::function<bool()>& shouldCancel, RunFn&& runFn)
{
    Ort::RunOptions runOptions;
    std::atomic<bool> stopWatcher{false};
    std::thread watcher;

    if (shouldCancel)
    {
        watcher = std::thread(
            [&runOptions, &stopWatcher, &shouldCancel]()
            {
                while (! stopWatcher.load(std::memory_order_relaxed))
                {
                    if (shouldCancel())
                    {
                        runOptions.SetTerminate();
                        return;
                    }
                    std::this_thread::sleep_for(std::chrono::milliseconds(50));
                }
            });
    }

    // Joins the watcher on every exit path (normal return or exception) before
    // `runOptions` goes out of scope. Declared before the try so it unwinds last.
    struct WatcherJoin
    {
        std::atomic<bool>& stop;
        std::thread& thread;
        ~WatcherJoin()
        {
            stop.store(true, std::memory_order_relaxed);
            if (thread.joinable()) thread.join();
        }
    } join{stopWatcher, watcher};

    try
    {
        runFn(runOptions);
    }
    catch (const Ort::Exception&)
    {
        if (shouldCancel && shouldCancel())
            throw StemSeparationError(StemFailureCode::Cancelled, "Cancelled");
        throw;
    }
}

} // namespace silverdaw::stems

// Generic dev probe: runs a spectrogram-in / spectrogram-out ONNX model on
// Silverdaw's actual linked ONNX Runtime (CPU or DirectML EP) and compares the
// outputs against a saved reference. Used to de-risk new separation models on
// the real runtime — independent of the full pipeline — before any integration.
//
// It is model-agnostic: input/output names and tensor element counts are read
// from the session itself, and the raw float32 .bin operands are loaded to match.
//
// Usage:
//   SilverdawSpecOnnxProbe <model.onnx> <in0.bin> <in1.bin> <refOut0.bin> <refOut1.bin> [cpu|gpu]
//   (.onnx.data, onnxruntime.dll and DirectML.dll must sit beside the exe / model)

#include <onnxruntime_cxx_api.h>

#if defined(SILVERDAW_ONNXRUNTIME_DIRECTML)
#include <dml_provider_factory.h>
#endif

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <string>
#include <thread>
#include <vector>

namespace
{
std::vector<float> readBin(const std::string& path)
{
    std::ifstream f(path, std::ios::binary | std::ios::ate);
    if (!f) { std::fprintf(stderr, "cannot open %s\n", path.c_str()); std::exit(2); }
    const std::streamsize bytes = f.tellg();
    f.seekg(0);
    std::vector<float> v(static_cast<size_t>(bytes) / sizeof(float));
    f.read(reinterpret_cast<char*>(v.data()), bytes);
    return v;
}

size_t elemCount(const Ort::ConstTensorTypeAndShapeInfo& info)
{
    size_t n = 1;
    for (int64_t d : info.GetShape()) n *= static_cast<size_t>(d <= 0 ? 1 : d);
    return n;
}

std::wstring widen(const std::string& s) { return std::wstring(s.begin(), s.end()); }
} // namespace

int main(int argc, char** argv)
{
    if (argc < 6)
    {
        std::fprintf(stderr,
                     "usage: SilverdawSpecOnnxProbe <model.onnx> <in0.bin> <in1.bin> "
                     "<refOut0.bin> <refOut1.bin> [cpu|gpu]\n");
        return 1;
    }
    const std::string modelPath = argv[1];
    const std::string in0 = argv[2], in1 = argv[3], ref0 = argv[4], ref1 = argv[5];
    const bool useGpu = (argc > 6) && std::string(argv[6]) == "gpu";

    Ort::Env env{ORT_LOGGING_LEVEL_WARNING, "silverdaw-spec-probe"};
    Ort::SessionOptions opts;
    opts.SetIntraOpNumThreads(
        static_cast<int>(std::max(1u, std::thread::hardware_concurrency())));
    opts.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);

    if (useGpu)
    {
#if defined(SILVERDAW_ONNXRUNTIME_DIRECTML)
        opts.DisableMemPattern();
        opts.SetExecutionMode(ORT_SEQUENTIAL);
        opts.AddConfigEntry("ep.dml.disable_graph_fusion", "1");
        Ort::ThrowOnError(OrtSessionOptionsAppendExecutionProvider_DML(opts, 0));
        std::printf("EP: DirectML (GPU)\n");
#else
        std::printf("EP: GPU requested but this build is CPU-only ONNX Runtime; using CPU\n");
#endif
    }
    else
    {
        std::printf("EP: CPU\n");
    }

    std::unique_ptr<Ort::Session> session;
    try
    {
        session = std::make_unique<Ort::Session>(env, widen(modelPath).c_str(), opts);
    }
    catch (const std::exception& e)
    {
        std::fprintf(stderr, "session create failed: %s\n", e.what());
        return 3;
    }

    Ort::AllocatorWithDefaultOptions alloc;
    const size_t nIn = session->GetInputCount();
    const size_t nOut = session->GetOutputCount();
    std::printf("model: %zu inputs, %zu outputs\n", nIn, nOut);

    std::vector<std::string> inNames, outNames;
    std::vector<std::vector<int64_t>> inShapes, outShapes;
    std::vector<size_t> inCounts, outCounts;
    for (size_t i = 0; i < nIn; ++i)
    {
        inNames.push_back(session->GetInputNameAllocated(i, alloc).get());
        Ort::TypeInfo ti = session->GetInputTypeInfo(i);
        auto info = ti.GetTensorTypeAndShapeInfo();
        inShapes.push_back(info.GetShape());
        inCounts.push_back(elemCount(info));
    }
    for (size_t i = 0; i < nOut; ++i)
    {
        outNames.push_back(session->GetOutputNameAllocated(i, alloc).get());
        Ort::TypeInfo ti = session->GetOutputTypeInfo(i);
        auto info = ti.GetTensorTypeAndShapeInfo();
        outShapes.push_back(info.GetShape());
        outCounts.push_back(elemCount(info));
    }

    auto shapeStr = [](const std::vector<int64_t>& s) {
        std::string r = "[";
        for (size_t i = 0; i < s.size(); ++i) r += (i ? "," : "") + std::to_string(s[i]);
        return r + "]";
    };
    for (size_t i = 0; i < nIn; ++i)
        std::printf("  in  %zu: %-14s %s (%zu floats)\n", i, inNames[i].c_str(),
                    shapeStr(inShapes[i]).c_str(), inCounts[i]);
    for (size_t i = 0; i < nOut; ++i)
        std::printf("  out %zu: %-14s %s (%zu floats)\n", i, outNames[i].c_str(),
                    shapeStr(outShapes[i]).c_str(), outCounts[i]);

    std::vector<std::vector<float>> inData{readBin(in0), readBin(in1)};
    std::vector<std::vector<float>> refData{readBin(ref0), readBin(ref1)};
    for (size_t i = 0; i < 2 && i < nIn; ++i)
        if (inData[i].size() != inCounts[i])
            std::fprintf(stderr, "WARN in%zu size %zu != expected %zu\n", i, inData[i].size(),
                         inCounts[i]);

    const auto memInfo = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
    std::vector<Ort::Value> inputs;
    for (size_t i = 0; i < nIn; ++i)
        inputs.push_back(Ort::Value::CreateTensor<float>(memInfo, inData[i].data(),
                                                         inData[i].size(), inShapes[i].data(),
                                                         inShapes[i].size()));
    std::vector<const char*> inPtr, outPtr;
    for (auto& n : inNames) inPtr.push_back(n.c_str());
    for (auto& n : outNames) outPtr.push_back(n.c_str());

    // Warm-up (DML kernel compile / arena) then a timed run.
    std::vector<Ort::Value> out;
    try
    {
        out = session->Run(Ort::RunOptions{nullptr}, inPtr.data(), inputs.data(), nIn,
                           outPtr.data(), nOut);
        const auto t0 = std::chrono::steady_clock::now();
        out = session->Run(Ort::RunOptions{nullptr}, inPtr.data(), inputs.data(), nIn,
                           outPtr.data(), nOut);
        const auto t1 = std::chrono::steady_clock::now();
        std::printf("run OK in %.0f ms (one 4 s chunk)\n",
                    std::chrono::duration<double, std::milli>(t1 - t0).count());
    }
    catch (const std::exception& e)
    {
        std::fprintf(stderr, "Run() failed: %s\n", e.what());
        return 4;
    }

    bool allOk = true;
    for (size_t i = 0; i < nOut && i < 2; ++i)
    {
        const float* o = out[i].GetTensorData<float>();
        const size_t n = outCounts[i];
        double maxDiff = 0.0, sumAbs = 0.0, sumSq = 0.0, refMax = 0.0;
        size_t zeros = 0;
        for (size_t k = 0; k < n; ++k)
        {
            const double ov = o[k];
            const double rv = (k < refData[i].size()) ? refData[i][k] : 0.0;
            maxDiff = std::max(maxDiff, std::fabs(ov - rv));
            sumAbs += std::fabs(ov);
            sumSq += ov * ov;
            refMax = std::max(refMax, std::fabs(rv));
            if (ov == 0.0) ++zeros;
        }
        const double rms = std::sqrt(sumSq / static_cast<double>(n));
        const double zfrac = static_cast<double>(zeros) / static_cast<double>(n);
        std::printf("  out %zu (%s): maxDiff=%.3e  outRMS=%.4f  mean|.|=%.4f  zeros=%.1f%%  "
                    "(refMaxAbs=%.3e)\n",
                    i, outNames[i].c_str(), maxDiff, rms, sumAbs / static_cast<double>(n),
                    zfrac * 100.0, refMax);
        if (maxDiff > 5.0e-3 || zfrac > 0.99) allOk = false;
    }
    std::printf("%s\n", allOk ? "PROBE PASS (matches reference, non-zero)"
                              : "PROBE FAIL (diff too large or all-zero output)");
    return allOk ? 0 : 5;
}

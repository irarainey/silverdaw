#include "StemOnnxProvider.h"

#include "InferenceThreads.h"
#include "Log.h"

#ifdef SILVERDAW_ONNXRUNTIME_DIRECTML
#include <dml_provider_factory.h>
#include <dxgi1_4.h>
#include <wrl/client.h>
#endif

namespace silverdaw
{
namespace
{
void configureCpuOptions(Ort::SessionOptions& options)
{
    options = Ort::SessionOptions{};
    options.SetIntraOpNumThreads(stems::inferenceIntraOpThreads());
    options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
}

#ifdef SILVERDAW_ONNXRUNTIME_DIRECTML
void logSelectedAdapter(const OrtDmlApi& api, Ort::SessionOptions& options)
{
    // ORT 1.24 GetDMLDevice returns a borrowed pointer owned by the options' factory.
    IDMLDevice* dmlDevice = nullptr;
    const Ort::Status status(api.GetDMLDevice(options, &dmlDevice));
    if (!status.IsOK() || dmlDevice == nullptr)
    {
        log::warn("stems", "Could not query the selected DirectML device" +
                               (status.IsOK() ? juce::String{} : ": " + juce::String(status.GetErrorMessage())));
        return;
    }

    Microsoft::WRL::ComPtr<ID3D12Device> device;
    Microsoft::WRL::ComPtr<IDXGIFactory4> factory;
    Microsoft::WRL::ComPtr<IDXGIAdapter1> adapter;
    DXGI_ADAPTER_DESC1 description{};
    if (FAILED(dmlDevice->GetParentDevice(IID_PPV_ARGS(device.GetAddressOf()))) ||
        FAILED(CreateDXGIFactory1(IID_PPV_ARGS(factory.GetAddressOf()))) ||
        FAILED(factory->EnumAdapterByLuid(device->GetAdapterLuid(), IID_PPV_ARGS(adapter.GetAddressOf()))) ||
        FAILED(adapter->GetDesc1(&description)))
    {
        log::warn("stems", "Could not resolve the selected DirectML adapter description");
        return;
    }
    log::info("stems",
              "DirectML selected adapter: " + juce::String(description.Description) +
                  " vendorId=" + juce::String(description.VendorId) +
                  " deviceId=" + juce::String(description.DeviceId) + " dedicatedMemoryMiB=" +
                  juce::String(static_cast<juce::int64>(description.DedicatedVideoMemory / (1024ULL * 1024ULL))));
}
#endif
} // namespace

bool configureStemOnnxProvider(Ort::SessionOptions& options, bool useGpu)
{
    configureCpuOptions(options);
    if (useGpu)
    {
#ifdef SILVERDAW_ONNXRUNTIME_DIRECTML
        try
        {
            options.DisableMemPattern();
            options.SetExecutionMode(ORT_SEQUENTIAL);
            // Fusion breaks dynamic htdemucs compilation and RoFormer numerical parity.
            options.AddConfigEntry("ep.dml.disable_graph_fusion", "1");
            const OrtDmlApi* api = nullptr;
            Ort::ThrowOnError(
                Ort::GetApi().GetExecutionProviderApi("DML", ORT_API_VERSION, reinterpret_cast<const void**>(&api)));
            if (api == nullptr)
                throw Ort::Exception("DirectML provider API is unavailable", ORT_FAIL);
            OrtDmlDeviceOptions deviceOptions{OrtDmlPerformancePreference::HighPerformance, OrtDmlDeviceFilter::Gpu};
            Ort::ThrowOnError(api->SessionOptionsAppendExecutionProvider_DML2(options, &deviceOptions));
            log::info("stems",
                      "ONNX execution provider configured: DirectML; preference=high-performance graphFusion=off");
            logSelectedAdapter(*api, options);
            return true;
        }
        catch (const Ort::Exception& error)
        {
            log::warn("stems", "DirectML initialisation failed; using CPU: " + juce::String(error.what()));
            configureCpuOptions(options);
        }
#else
        log::warn("stems", "GPU requested but this build ships the CPU ONNX Runtime; using CPU.");
#endif
    }
    log::info("stems", "ONNX execution provider configured: CPU (" + juce::String(stems::inferenceIntraOpThreads()) +
                           " intra-op threads)");
    return false;
}

} // namespace silverdaw

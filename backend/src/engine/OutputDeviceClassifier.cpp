#include "OutputDeviceClassifier.h"

namespace silverdaw
{

bool busPrefersKeepAwake(OutputBus bus) noexcept
{
    switch (bus)
    {
        case OutputBus::usb:
            return true;
        case OutputBus::onboard:
        case OutputBus::bluetooth:
        case OutputBus::other:
        case OutputBus::unknown:
        default:
            return false;
    }
}

bool resolveKeepAwake(KeepAwakeMode mode, OutputBus bus) noexcept
{
    switch (mode)
    {
        case KeepAwakeMode::forceOn:
            return true;
        case KeepAwakeMode::forceOff:
            return false;
        case KeepAwakeMode::autoDetect:
        default:
            return busPrefersKeepAwake(bus);
    }
}

std::optional<KeepAwakeMode> keepAwakeModeFromString(const juce::String& value) noexcept
{
    const auto v = value.trim().toLowerCase();
    if (v == "auto") return KeepAwakeMode::autoDetect;
    if (v == "on") return KeepAwakeMode::forceOn;
    if (v == "off") return KeepAwakeMode::forceOff;
    return std::nullopt;
}

const char* toString(KeepAwakeMode mode) noexcept
{
    switch (mode)
    {
        case KeepAwakeMode::forceOn: return "on";
        case KeepAwakeMode::forceOff: return "off";
        case KeepAwakeMode::autoDetect:
        default: return "auto";
    }
}

const char* toString(OutputBus bus) noexcept
{
    switch (bus)
    {
        case OutputBus::usb: return "usb";
        case OutputBus::onboard: return "onboard";
        case OutputBus::bluetooth: return "bluetooth";
        case OutputBus::other: return "other";
        case OutputBus::unknown:
        default: return "unknown";
    }
}

} // namespace silverdaw

#if JUCE_WINDOWS

// clang-format off
#include <windows.h>
#include <mmdeviceapi.h>
#include <functiondiscoverykeys_devpkey.h>
#include <devpkey.h>
#include <cfgmgr32.h>
// clang-format on

// devpkey.h only *declares* DEVPKEY_Device_EnumeratorName; its GUID is normally emitted in a
// translation unit that defines INITGUID. Define it here (matching C linkage) so we don't pull
// INITGUID globally and risk duplicating the PKEY_* symbols already provided by uuid.lib.
extern "C" const DEVPROPKEY DEVPKEY_Device_EnumeratorName = {
    {0xa45c254e, 0xdf1c, 0x4efd, {0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0}}, 24};

namespace silverdaw
{
namespace
{

// Map a Windows bus-enumerator name (the first segment of a device instance id) to a bus.
OutputBus busFromEnumerator(const juce::String& enumeratorName) noexcept
{
    const auto e = enumeratorName.toUpperCase().trim();
    if (e.isEmpty()) return OutputBus::unknown;
    if (e.startsWith("USB")) return OutputBus::usb;
    if (e.startsWith("HDAUDIO") || e.startsWith("INTELAUDIO") || e.startsWith("PCI"))
        return OutputBus::onboard;
    if (e.startsWith("BTH")) return OutputBus::bluetooth; // BTHENUM / BTHHFENUM / BTHLE...
    return OutputBus::other;
}

// Read the "EnumeratorName" property (e.g. "USB", "HDAUDIO", "BTHENUM") of a device node.
juce::String enumeratorNameOf(DEVINST devInst) noexcept
{
    DEVPROPTYPE propType = 0;
    wchar_t buffer[256] = {};
    ULONG size = sizeof(buffer);
    if (CM_Get_DevNode_PropertyW(devInst, &DEVPKEY_Device_EnumeratorName, &propType,
                                 reinterpret_cast<PBYTE>(buffer), &size, 0) == CR_SUCCESS
        && propType == DEVPROP_TYPE_STRING)
    {
        return juce::String(buffer);
    }
    return {};
}

// Walk up the device tree from the audio endpoint (a software MMDEVAPI node) to the first real
// hardware bus enumerator, so we read USB/HDAUDIO/PCI/BTH rather than the SWD shim.
OutputBus busFromEndpointInstanceId(const juce::String& instanceId) noexcept
{
    if (instanceId.isEmpty()) return OutputBus::unknown;

    DEVINST devInst = 0;
    if (CM_Locate_DevNodeW(&devInst, const_cast<DEVINSTID_W>(instanceId.toWideCharPointer()),
                           CM_LOCATE_DEVNODE_NORMAL) != CR_SUCCESS)
    {
        return OutputBus::unknown;
    }

    for (int hops = 0; hops < 8; ++hops)
    {
        const auto bus = busFromEnumerator(enumeratorNameOf(devInst));
        if (bus == OutputBus::usb || bus == OutputBus::onboard || bus == OutputBus::bluetooth)
            return bus; // a concrete hardware bus — done

        // "SWD" (software device) / "ROOT" / unknown enumerators: keep climbing to the hardware.
        DEVINST parent = 0;
        if (CM_Get_Parent(&parent, devInst, 0) != CR_SUCCESS || parent == 0 || parent == devInst)
            break;
        devInst = parent;
    }
    return OutputBus::unknown;
}

} // namespace

OutputBus classifyOutputEndpoint(const juce::String& friendlyName)
{
    if (friendlyName.isEmpty()) return OutputBus::unknown;

    // Balance COM init: S_OK/S_FALSE -> we must CoUninitialize; RPC_E_CHANGED_MODE -> COM is
    // already up on this (message) thread in another mode, so proceed without uninitialising.
    const HRESULT hrInit = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    const bool needUninit = SUCCEEDED(hrInit);

    OutputBus result = OutputBus::unknown;
    IMMDeviceEnumerator* enumerator = nullptr;
    if (SUCCEEDED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                   __uuidof(IMMDeviceEnumerator),
                                   reinterpret_cast<void**>(&enumerator)))
        && enumerator != nullptr)
    {
        IMMDeviceCollection* collection = nullptr;
        if (SUCCEEDED(enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &collection))
            && collection != nullptr)
        {
            UINT count = 0;
            collection->GetCount(&count);
            for (UINT i = 0; i < count && result == OutputBus::unknown; ++i)
            {
                IMMDevice* device = nullptr;
                if (FAILED(collection->Item(i, &device)) || device == nullptr) continue;

                IPropertyStore* store = nullptr;
                if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, &store)) && store != nullptr)
                {
                    PROPVARIANT nameVar;
                    PropVariantInit(&nameVar);
                    bool matched = false;
                    if (SUCCEEDED(store->GetValue(PKEY_Device_FriendlyName, &nameVar))
                        && nameVar.vt == VT_LPWSTR && nameVar.pwszVal != nullptr)
                    {
                        const juce::String name(nameVar.pwszVal);
                        matched = name.equalsIgnoreCase(friendlyName)
                                  || name.containsIgnoreCase(friendlyName)
                                  || friendlyName.containsIgnoreCase(name);
                    }
                    PropVariantClear(&nameVar);

                    if (matched)
                    {
                        PROPVARIANT idVar;
                        PropVariantInit(&idVar);
                        if (SUCCEEDED(store->GetValue(PKEY_Device_InstanceId, &idVar))
                            && idVar.vt == VT_LPWSTR && idVar.pwszVal != nullptr)
                        {
                            result = busFromEndpointInstanceId(juce::String(idVar.pwszVal));
                        }
                        PropVariantClear(&idVar);
                    }
                    store->Release();
                }
                device->Release();
            }
            collection->Release();
        }
        enumerator->Release();
    }

    if (needUninit) CoUninitialize();
    return result;
}

} // namespace silverdaw

#else

namespace silverdaw
{
OutputBus classifyOutputEndpoint(const juce::String&) { return OutputBus::unknown; }
} // namespace silverdaw

#endif

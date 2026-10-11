#include <node_api.h>
#include <Windows.h>

#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "PipeDef.h"

namespace
{
using CreatePipeClientFn = BOOL(WINAPI*)(PipeSDK::IPipeClient**);
using QueryVersionFn = LPCSTR(WINAPI*)();

struct PipeEvent
{
    PipeSDK::IPC_EVENT_TYPE type;
    UINT32 messageId;
    std::string data;
};

std::mutex stateMutex;
HMODULE sdkModule = nullptr;
PipeSDK::IPipeClient* pipeClient = nullptr;
napi_threadsafe_function eventCallback = nullptr;

void ThrowLastError(napi_env env, const char* operation)
{
    const DWORD code = GetLastError();
    const std::string message = std::string(operation) + " failed with Windows error " + std::to_string(code);
    napi_throw_error(env, nullptr, message.c_str());
}

std::string ReadUtf8(napi_env env, napi_value value)
{
    size_t length = 0;
    napi_get_value_string_utf8(env, value, nullptr, 0, &length);
    std::vector<char> buffer(length + 1, '\0');
    napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length);
    return std::string(buffer.data(), length);
}

std::wstring Utf8ToWide(const std::string& value)
{
    if (value.empty())
        return {};
    const int length = MultiByteToWideChar(
        CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
    if (length <= 0)
        return {};
    std::wstring result(length, L'\0');
    MultiByteToWideChar(
        CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), length);
    return result;
}

PipeSDK::IPipeClient* RetainClient()
{
    std::lock_guard<std::mutex> lock(stateMutex);
    if (pipeClient != nullptr)
        pipeClient->AddRef();
    return pipeClient;
}

void CallJavaScript(napi_env env, napi_value callback, void*, void* rawEvent)
{
    std::unique_ptr<PipeEvent> event(static_cast<PipeEvent*>(rawEvent));
    if (env == nullptr || callback == nullptr)
        return;

    napi_value global;
    napi_get_global(env, &global);

    napi_value arguments[3];
    napi_create_int32(env, static_cast<int32_t>(event->type), &arguments[0]);
    napi_create_uint32(env, event->messageId, &arguments[1]);
    napi_create_string_utf8(env, event->data.data(), event->data.size(), &arguments[2]);

    napi_value result;
    napi_call_function(env, global, callback, 3, arguments, &result);
}

void PipeCallback(PipeSDK::IPC_EVENT_TYPE type, UINT32 messageId, const CHAR* data, UINT32 size, void*)
{
    napi_threadsafe_function callback = nullptr;
    {
        std::lock_guard<std::mutex> lock(stateMutex);
        callback = eventCallback;
        if (callback != nullptr && napi_acquire_threadsafe_function(callback) != napi_ok)
            callback = nullptr;
    }
    if (callback == nullptr)
        return;

    auto event = std::make_unique<PipeEvent>();
    event->type = type;
    event->messageId = messageId;
    if (data != nullptr && size > 0)
        event->data.assign(data, size);

    if (napi_call_threadsafe_function(callback, event.get(), napi_tsfn_nonblocking) == napi_ok)
        event.release();
    napi_release_threadsafe_function(callback, napi_tsfn_release);
}

void CloseClient()
{
    PipeSDK::IPipeClient* client = nullptr;
    napi_threadsafe_function callback = nullptr;
    HMODULE module = nullptr;
    {
        std::lock_guard<std::mutex> lock(stateMutex);
        client = pipeClient;
        pipeClient = nullptr;
        callback = eventCallback;
        eventCallback = nullptr;
        module = sdkModule;
        sdkModule = nullptr;
    }

    if (client != nullptr)
    {
        client->SetCallback(nullptr, nullptr);
        client->Close();
        client->Release();
    }
    if (callback != nullptr)
        napi_release_threadsafe_function(callback, napi_tsfn_abort);
    if (module != nullptr)
        FreeLibrary(module);
}

napi_value Start(napi_env env, napi_callback_info info)
{
    size_t argumentCount = 4;
    napi_value arguments[4];
    napi_get_cb_info(env, info, &argumentCount, arguments, nullptr, nullptr);
    if (argumentCount < 4)
    {
        napi_throw_type_error(env, nullptr, "start requires dllPath, pipeName, maxChannels and callback");
        return nullptr;
    }

    napi_valuetype callbackType;
    napi_typeof(env, arguments[3], &callbackType);
    if (callbackType != napi_function)
    {
        napi_throw_type_error(env, nullptr, "callback must be a function");
        return nullptr;
    }

    const std::wstring dllPath = Utf8ToWide(ReadUtf8(env, arguments[0]));
    const std::wstring pipeName = Utf8ToWide(ReadUtf8(env, arguments[1]));
    uint32_t maxChannels = 0;
    napi_get_value_uint32(env, arguments[2], &maxChannels);
    if (dllPath.empty() || pipeName.empty() || maxChannels == 0)
    {
        napi_throw_type_error(env, nullptr, "dllPath, pipeName and maxChannels are required");
        return nullptr;
    }

    CloseClient();

    HMODULE module = LoadLibraryW(dllPath.c_str());
    if (module == nullptr)
    {
        ThrowLastError(env, "LoadLibraryW");
        return nullptr;
    }

    auto createPipeClient = reinterpret_cast<CreatePipeClientFn>(GetProcAddress(module, "CreatePipeClient"));
    if (createPipeClient == nullptr)
    {
        FreeLibrary(module);
        ThrowLastError(env, "GetProcAddress(CreatePipeClient)");
        return nullptr;
    }

    napi_value resourceName;
    napi_create_string_utf8(env, "PipeSDKEventCallback", NAPI_AUTO_LENGTH, &resourceName);
    napi_threadsafe_function callback = nullptr;
    if (napi_create_threadsafe_function(
            env,
            arguments[3],
            nullptr,
            resourceName,
            0,
            1,
            nullptr,
            nullptr,
            nullptr,
            CallJavaScript,
            &callback) != napi_ok)
    {
        FreeLibrary(module);
        napi_throw_error(env, nullptr, "failed to create PipeSDK callback");
        return nullptr;
    }

    PipeSDK::IPipeClient* client = nullptr;
    if (!createPipeClient(&client) || client == nullptr)
    {
        napi_release_threadsafe_function(callback, napi_tsfn_abort);
        FreeLibrary(module);
        napi_throw_error(env, nullptr, "CreatePipeClient returned false");
        return nullptr;
    }

    {
        std::lock_guard<std::mutex> lock(stateMutex);
        sdkModule = module;
        pipeClient = client;
        eventCallback = callback;
    }

    client->SetCallback(PipeCallback, nullptr);
    if (!client->Open(pipeName.c_str(), maxChannels))
    {
        CloseClient();
        napi_throw_error(env, nullptr, "PipeSDK Open returned false");
        return nullptr;
    }

    std::string version;
    auto queryVersion = reinterpret_cast<QueryVersionFn>(GetProcAddress(module, "QueryVersion"));
    if (queryVersion != nullptr)
    {
        const char* rawVersion = queryVersion();
        if (rawVersion != nullptr)
            version = rawVersion;
    }

    napi_value result;
    napi_create_string_utf8(env, version.c_str(), version.size(), &result);
    return result;
}

napi_value SendMessage(napi_env env, napi_callback_info info)
{
    size_t argumentCount = 2;
    napi_value arguments[2];
    napi_get_cb_info(env, info, &argumentCount, arguments, nullptr, nullptr);
    if (argumentCount < 2)
    {
        napi_throw_type_error(env, nullptr, "sendMessage requires messageId and payload");
        return nullptr;
    }

    uint32_t messageId = 0;
    napi_get_value_uint32(env, arguments[0], &messageId);
    const std::string payload = ReadUtf8(env, arguments[1]);
    PipeSDK::IPipeClient* client = RetainClient();
    const BOOL sent = client == nullptr
        ? FALSE
        : client->SendMessage(messageId, payload.data(), static_cast<UINT32>(payload.size()));
    if (client != nullptr)
        client->Release();

    napi_value result;
    napi_get_boolean(env, sent == TRUE, &result);
    return result;
}

napi_value IsConnected(napi_env env, napi_callback_info)
{
    PipeSDK::IPipeClient* client = RetainClient();
    const BOOL connected = client == nullptr ? FALSE : client->IsConnected();
    if (client != nullptr)
        client->Release();

    napi_value result;
    napi_get_boolean(env, connected == TRUE, &result);
    return result;
}

napi_value Stop(napi_env env, napi_callback_info)
{
    CloseClient();
    napi_value result;
    napi_get_undefined(env, &result);
    return result;
}

void Cleanup(void*)
{
    CloseClient();
}

napi_value Initialize(napi_env env, napi_value exports)
{
    napi_property_descriptor properties[] = {
        {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"sendMessage", nullptr, SendMessage, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"isConnected", nullptr, IsConnected, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"stop", nullptr, Stop, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
    napi_add_env_cleanup_hook(env, Cleanup, nullptr);
    return exports;
}
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)

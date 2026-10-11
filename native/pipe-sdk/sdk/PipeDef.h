#pragma once
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <Windows.h>

namespace PipeSDK
{
#ifndef MAX_AV_PLANES
#define MAX_AV_PLANES 8
#endif
#if defined(_MS_DLL)
#if defined(API_EXPORTS)
#define MS_API __declspec(dllexport)
#else
#define MS_API __declspec(dllimport)
#endif
#else
#define MS_API
#endif

#define MS_BEGIN_C_HEADER              \
    __pragma(pack(push, 8)) extern "C" \
    {

#define MS_END_C_HEADER \
    }                   \
    __pragma(pack(pop))

#define DECLARE_IMSUNKNOW                              \
public:                                                \
    LONG AddRef() OVERRIDE;                            \
    LONG Release() OVERRIDE;                           \
    LONG QueryInterface(const GUID&, void**) OVERRIDE; \
                                                       \
private:                                               \
    volatile LONG m_cRef{0};

#define IMPLEMENT_IMSUNKNOW(_class, _interface, iid)                            \
    LONG _class::AddRef()                                                       \
    {                                                                           \
        return static_cast<ULONG>(InterlockedIncrement(&this->m_cRef));         \
    };                                                                          \
                                                                                \
    LONG _class::Release()                                                      \
    {                                                                           \
        if (InterlockedDecrement(&this->m_cRef))                                \
            return this->m_cRef;                                                \
        OnRelease();                                                            \
        delete this;                                                            \
        return NOERROR;                                                         \
    };                                                                          \
                                                                                \
    LONG _class::QueryInterface(const GUID& riid, void** ppvObject)             \
    {                                                                           \
        if (IsEqualIID(riid, iid) || IsEqualIID(riid, PipeSDK::IID_IMSUnknown)) \
        {                                                                       \
            *ppvObject = static_cast<_interface*>(this);                        \
        }                                                                       \
        else                                                                    \
        {                                                                       \
            *ppvObject = NULL;                                                  \
            return E_NOINTERFACE;                                               \
        }                                                                       \
        AddRef();                                                               \
        return NOERROR;                                                         \
    };

enum IPC_EVENT_TYPE
{
    EVENT_CONNECTED,
    EVENT_BROKEN,
    EVENT_DISCONNECTED,
    EVENT_MESSAGE,
    EVENT_CONNECTION_RESET,
    EVENT_PACKET,
};

struct IPC_RATIONAL
{
    INT32 numerator;
    INT32 denominator;
};

enum IPC_AV_TYPE : UINT32
{
    IPC_AUDIO = 1,
    IPC_VIDEO = 2
};

enum IPC_VIDEO_PIXEL_FORMAT
{
    IPC_PIXEL_FORMAT_UNKNOWN = 0,
    IPC_PIXEL_FORMAT_I420 = 1,
    IPC_PIXEL_FORMAT_YV12 = 2,
    IPC_PIXEL_FORMAT_NV12 = 3,
    IPC_PIXEL_FORMAT_NV21 = 4,
    IPC_PIXEL_FORMAT_UYVY = 5,
    IPC_PIXEL_FORMAT_YUY2 = 6,
    IPC_PIXEL_FORMAT_ARGB = 7,
    IPC_PIXEL_FORMAT_XRGB = 8,
    IPC_PIXEL_FORMAT_RGB24 = 9,
    IPC_PIXEL_FORMAT_RGBA = 10,
    IPC_PIXEL_FORMAT_BGR24 = 11,
    IPC_PIXEL_FORMAT_BGRA = 12,
    IPC_PIXEL_FORMAT_MJPEG = 13,
    IPC_PIXEL_FORMAT_I444 = 14,
    IPC_PIXEL_FORMAT_I444A = 15,
    IPC_PIXEL_FORMAT_I420A = 16,
    IPC_PIXEL_FORMAT_I422 = 17,
    IPC_PIXEL_FORMAT_I422A = 18,
    IPC_PIXEL_FORMAT_YVYU = 19,
    IPC_PIXEL_FORMAT_P010 = 20,
    IPC_PIXEL_FORMAT_P016 = 21,
    IPC_PIXEL_FORMAT_NV12_MS = 22,
    IPC_PIXEL_FORMAT_P010_MS = 23,
    IPC_PIXEL_FORMAT_P016_MS = 24,
    IPC_PIXEL_FORMAT_I010 = 25,
    IPC_PIXEL_FORMAT_V210 = 26,
    IPC_PIXEL_FORMAT_I210 = 27,
    IPC_PIXEL_FORMAT_MAX = IPC_PIXEL_FORMAT_I210,
};

// https://en.wikipedia.org/wiki/Rec._2100
// https://en.wikipedia.org/wiki/Rec._2020
enum IPC_COLOR_SPACE
{
    IPC_COLOR_SPACE_UNSPECIFIED = 0,
    IPC_COLOR_SPACE_JPEG = 1,
    IPC_COLOR_SPACE_BT709 = 2,
    IPC_COLOR_SPACE_BT601 = 3,
    IPC_COLOR_SPACE_FCC = 4,
    IPC_COLOR_SPACE_SMPTE240M = 5,
    IPC_COLOR_SPACE_BT470 = 6,
    IPC_COLOR_SPACE_BT2020 = 7, // HDR
    IPC_COLOR_SPACE_BT2100 = 8, // HDR10
    IPC_COLOR_SPACE_MAX = IPC_COLOR_SPACE_BT2100,
};

// https://en.wikipedia.org/wiki/Transfer_functions_in_imaging
enum IPC_COLOR_TRANSFER
{
    IPC_COLOR_TRANSFER_UNSPECIFIED = 0,
    IPC_COLOR_TRANSFER_LINEAR = 1,
    IPC_COLOR_TRANSFER_IEC61966_2_1 = 2, // SRGB
    IPC_COLOR_TRANSFER_GAMMA22 = 3,
    IPC_COLOR_TRANSFER_GAMMA28 = 4,
    IPC_COLOR_TRANSFER_SMPTE170M = 5,     // BT601
    IPC_COLOR_TRANSFER_SMPTE240M = 6,     // BT601
    IPC_COLOR_TRANSFER_BT709 = 7,         // BT709
    IPC_COLOR_TRANSFER_BT2020_10 = 8,     // BT2010 10BIT
    IPC_COLOR_TRANSFER_BT2020_12 = 9,     // BT2010 12BIT
    IPC_COLOR_TRANSFER_SMPTE2084 = 10,    // BT2100-PQ
    IPC_COLOR_TRANSFER_ARIB_STD_B67 = 11, // BT2100-HLG
    IPC_COLOR_TRANSFER_MAX = IPC_COLOR_TRANSFER_ARIB_STD_B67 + 1,
};

enum IPC_VIDEO_RANGE
{
    IPC_VIDEO_RANGE_UNSPECIFIED = 0,
    IPC_VIDEO_RANGE_PARTIAL = 1,
    IPC_VIDEO_RANGE_FULL = 2,
    IPC_VIDEO_RANGE_MAX = IPC_VIDEO_RANGE_FULL,
};

enum IPC_AUDIO_FORMAT
{
    IPC_AUDIO_FORMAT_UNKNOWN,
    IPC_AUDIO_FORMAT_U8BIT,
    IPC_AUDIO_FORMAT_16BIT,
    IPC_AUDIO_FORMAT_32BIT,
    IPC_AUDIO_FORMAT_FLOAT,
    IPC_AUDIO_FORMAT_U8BIT_PLANAR,
    IPC_AUDIO_FORMAT_16BIT_PLANAR,
    IPC_AUDIO_FORMAT_32BIT_PLANAR,
    IPC_AUDIO_FORMAT_FLOAT_PLANAR,
    IPC_AUDIO_FORMAT_MAX = IPC_AUDIO_FORMAT_FLOAT_PLANAR + 1,
};

enum IPC_CHANNEL_LAYOUT
{
    IPC_CHANNEL_UNKNOWN,
    IPC_CHANNEL_MONO,
    IPC_CHANNEL_STEREO,
    IPC_CHANNEL_2POINT1,
    IPC_CHANNEL_2_1,
    IPC_CHANNEL_2_2,
    IPC_CHANNEL_3POINT1,
    IPC_CHANNEL_QUAD,
    IPC_CHANNEL_4POINT0,
    IPC_CHANNEL_4POINT1,
    IPC_CHANNEL_5POINT0,
    IPC_CHANNEL_5POINT1,
    IPC_CHANNEL_5POINT0_BACK,
    IPC_CHANNEL_5POINT1_BACK,
    IPC_CHANNEL_6POINT0,
    IPC_CHANNEL_6POINT1,
    IPC_CHANNEL_7POINT0,
    IPC_CHANNEL_7POINT0_FRONT,
    IPC_CHANNEL_7POINT1,
    IPC_CHANNEL_7POINT1_WIDE,
    IPC_CHANNEL_7POINT1_WIDE_BACK,
    IPC_CHANNEL_SURROUND,
    IPC_CHANNEL_MAX = IPC_CHANNEL_SURROUND + 1,
};

typedef INT32     LogSeverity;
const LogSeverity IPC_LOG_VERBOSE = -1;
const LogSeverity IPC_LOG_INFO = 0;
const LogSeverity IPC_LOG_WARNING = 1;
const LogSeverity IPC_LOG_ERROR = 2;
const LogSeverity IPC_LOG_FATAL = 3;
const LogSeverity IPC_LOG_NUM_SEVERITIES = 4;

typedef void (*PIPE_CALLBACK)(IPC_EVENT_TYPE, UINT32, const CHAR*, UINT32, void*);
typedef BOOL (*LOG_MESSAGE_CALLBACK)(LogSeverity, LPCSTR, INT32, LPCSTR);

struct IPC_PACKET
{
    IPC_AV_TYPE type;
    INT32       channel;

    struct Video
    {
        BOOL                   bFlipH;
        BOOL                   bFlipV;
        UINT32                 cx;
        UINT32                 cy;
        INT32                  angle;
        IPC_RATIONAL           frameRate;
        IPC_VIDEO_PIXEL_FORMAT format;
        IPC_COLOR_SPACE        cs;
        IPC_COLOR_TRANSFER     ct;
        IPC_VIDEO_RANGE        range;
    };

    struct Audio
    {
        IPC_AUDIO_FORMAT   format;
        IPC_CHANNEL_LAYOUT layout;
        UINT32             sampleRate;
        UINT32             count;
        UINT32             planes;
        UINT32             blocksize;
    };

    union {
        Audio audio;
        Video video;
    };

    UINT8* data[MAX_AV_PLANES];
    UINT32 linesize[MAX_AV_PLANES];
    UINT32 size;
    INT64  timestamp;
};

// {892AE566-FFE4-47FA-88BA-14AA593544F5}
DEFINE_GUID(IID_IMSUnknown,
            0x892ae566, 0xffe4, 0x47fa, 0x88, 0xba, 0x14, 0xaa, 0x59, 0x35, 0x44, 0xf5);

// {56447627-DC77-4A12-A1F3-81E95D850438}
DEFINE_GUID(IID_IPipeClient,
            0x56447627, 0xdc77, 0x4a12, 0xa1, 0xf3, 0x81, 0xe9, 0x5d, 0x85, 0x4, 0x38);

class MS_API IMSUnknown;
class MS_API IPipeClient;

class MS_API IMSUnknown
{
public:
    virtual LONG AddRef() = 0;
    virtual LONG Release() = 0;
    virtual LONG QueryInterface(const GUID& riid, void** lpp) = 0;
};

class MS_API IPipeClient : public IMSUnknown
{
public:
    virtual BOOL IsConnected() = 0;
    virtual void SetCallback(PIPE_CALLBACK cb, void* args) = 0;
    virtual BOOL Open(LPCWSTR pszNAME, UINT32 maxChannels) = 0;
    virtual void Close() = 0;
    virtual BOOL SendMessage(UINT32 mss, const CHAR* data, UINT32 size) = 0;
    virtual BOOL WritePacket(const IPC_PACKET* apk, UINT32 timeout) = 0;
    virtual BOOL WritePacketAsync(const IPC_PACKET* apk) = 0;
};

#ifdef __cplusplus
extern "C"
{
#endif
    BOOL WINAPI   CreatePipeClient(IPipeClient**);
    UINT32 WINAPI ChannelLayoutToChannels(IPC_CHANNEL_LAYOUT layout);
    UINT32 WINAPI AudioFormatToBits(IPC_AUDIO_FORMAT format);
    UINT64 WINAPI GetTimeNS();
    LPCSTR WINAPI QueryVersion();
    void WINAPI   SetLogMessageCallback(LOG_MESSAGE_CALLBACK cb);
#ifdef __cplusplus
}
#endif

} // namespace PipeSDK

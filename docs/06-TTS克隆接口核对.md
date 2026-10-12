# 06 · TTS 克隆接口核对清单

> 状态：**已核对（火山已切 V3，V1 放弃）** · 2026-10-12
> 结论：火山「声音复刻」与合成都已迁到 V3 体系（`X-Api-Key` 鉴权），旧 V1（appId + token + cluster、
> mega_tts 一系）整体放弃。百炼复刻已实现（voice-enrollment，公网 URL 样本）。
> 以下清单按 V3 官方文档逐条给出答案（文档缓存：C:\tmp\md_2227958.md / md_1598757.md，真机联调后可删）。

## 原待核对项的 V3 答案

端点与鉴权：

- [x] 上传训练端点：V1 `mega_tts/audio/upload` 已被取代 → **`POST /api/v3/tts/voice_clone`**（VoiceService.submitVolcanoClone）
- [x] 状态查询端点：V1 `mega_tts/status` 已被取代 → **`POST /api/v3/tts/get_voice`**（VoiceService.pollOnce）
- [x] 鉴权头：`Authorization: Bearer;<token>` 是 V1 写法，已放弃 → V3 用 **`X-Api-Key` + `X-Api-Request-Id`**（新版控制台 API Key）
- [x] `Resource-Id: volc.megatts.voiceclone`：V3 复刻不需要；**合成**需要 `X-Api-Resource-Id`（= 模型名，如 seed-tts-2.0）
- [x] 复刻集群名 `volc_mega_tts`：V1 概念，V3 无 cluster

请求体（submitVolcanoClone）：

- [x] 音频直传：`audio.data`（base64）+ `audio.format`；格式支持 **wav / mp3 / ogg / m4a / aac / pcm**（pcm 仅 24k 单声道；**webm 不支持**，录音产物要先转码）；文件 ≤10MB
- [x] `source: 2`：V1 字段，V3 不存在
- [x] `speaker_id` 自定义：后付费用固定值 `speaker_id: "custom_speaker_id"` + `custom_speaker_id`（规则：长度 [8,256]、字母开头、仅数字字母 `-_`、首尾不可 `-_`）；预付费音色槽需控制台下单（不在本流程内）
- [x] 样本要求：官方建议 10-20 秒清晰人声；`extra_params` 可控降噪/音质检测等（默认即可）

响应与状态机：

- [x] `status` 语义确认：**0 NotFound / 1 Training / 2 Success / 3 Failed / 4 Active，2 与 4 都可合成**
- [x] 不需要额外「激活」调用（V3 无此步骤）
- [x] 音色标识：训练后音色 = `custom_speaker_id`，V3 合成 `req_params.speaker` 直接用它（模型 seed-icl-x）
- [x] 错误码：HTTP 非 200 时 body 带 `code`/`message`；常见：45001104 声纹未通过 / 45001109 WER 过高 / 45001122 无人声 / 45001123 次数上限（VoiceService.volcanoCloneError 已映射中文）

合成（一并核对）：

- [x] 合成端点：**`POST /api/v3/tts/unidirectional`**（HTTP Chunked，逐行 JSON：code=0 带 base64 音频、code=20000000 结束）
- [x] 请求体：`{user:{uid}, req_params:{text, speaker, model?, audio_params:{format, sample_rate, speech_rate, loudness_rate, emotion, emotion_scale}, additions}}`；`model`（standard/expressive）仅复刻 2.0 有效；pitch 走 `additions.post_process.pitch`

## 已实现但未真实联调的行为

- 训练状态轮询：5 秒一次，最多 5 分钟，超时标失败（`POLL_INTERVAL_MS` / `POLL_MAX_TRIES`）
- 401/403 一律映射为「鉴权失败或未开通声音复刻权限」
- 百炼复刻**已实现**（voice-enrollment）：`POST {workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/customization`，
  `{model:'voice-enrollment', input:{action:'create_voice', target_model, prefix, url}}`，创建即完成、音色长期有效。
  **样本必须公网可访问 URL**（无本地文件直传途径），本地文件返回中文引导；target_model 不含 cosyvoice-v1（V1 不能作为复刻目标）
- 火山后付费音色「首次合成即转正收费」，复刻后 7 天未合成自动删除——UI 应提示（下个代理）

## 核对方法（真机）

1. 设置 → 语音合成：给火山接入填新版控制台 API Key，测发音（V3 合成链路）
2. 音色库新建音色跑一遍「上传样本 → 训练 → 就绪」，观察卡片状态流转
3. 在音色库把该克隆音色「设为默认音色」（写进它所在的接入并把该接入设为默认接入），测发音验证 seed-icl-2.0 合成

## 附：实时 TTS（流式合成）· 2026-10-12 更新

### 已核实并实现：百炼 Qwen-TTS / maas 系真流式（SSE）

依据官方文档（help.aliyun.com/zh/model-studio/qwen-tts-api）实测口径：
- 端点与鉴权同非流式，**加请求头 `X-DashScope-SSE: enable`** 即进入流式
- 服务端按 SSE 返回多个 chunk：中间帧 `output.audio.data` 为 base64 音频片段；末帧 `finish_reason = "stop"`、`data` 为空
- **流式音频为 PCM 16bit 单声道**（采样率跟随模型参数 sample_rate，默认 24000）
- 文本上限 600 字符

实现：`TtsService.synthesizeBailianStream()` → `TtsStreamService`（路由的模型标了 `streaming` 才走真流式，其余回退切片）→
渲染进程 `streamPlayer`（AudioBuffer 按块采样率建buffer，WebAudio 自动重采样播放）→
直推模式另有一条 `resampleTo48k()`（线性插值）喂混音器。

### 仍待核对：火山流式接线

火山 V3 `/api/v3/tts/unidirectional` 本身就是 HTTP Chunked 流式（边收边出），当前实现**整段累积后落盘**
（预合成场景足够）。要接「边合成边播」时，把 `TtsService.synthesizeVolcano` 的逐行解析改成边收边 yield、
在 `TtsStreamService.streamChunks` 接出即可，下游（渲染进程 streamPlayer、混音器 pushTtsPcm）不用改。
注意流式格式建议用 pcm（免解码），采样率与混音器口径（48k mono s16le）不一致时要重采样。

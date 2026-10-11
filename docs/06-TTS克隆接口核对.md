# 06 · TTS 克隆接口核对清单

> 状态：**待核对** · 2026-10-11
> 背景：M8 音色库实现了火山引擎「声音复刻」调用，但实现时联网检索额度用尽，**端点/字段/状态码均按历史文档口径编写，未逐字对照当前官方文档**。
> 核对开销极小：全部假设集中在 `src/main/services/VoiceService.ts` 顶部常量与 `parseVolcanoState` / `parseVolcanoResponse` 三处。

## 待核对项（逐条打勾）

端点与鉴权（VoiceService.ts 顶部）：

- [ ] 上传训练端点：`POST https://openspeech.bytedance.com/api/v1/mega_tts/audio/upload` —— 是否已被新的大模型复刻接口取代？（可能是 `/api/v1/mega_tts/audio/upload` 的新版本或 `…/voice/clone` 一系）
- [ ] 状态查询端点：`POST https://openspeech.bytedance.com/api/v1/mega_tts/status`
- [ ] 鉴权头：`Authorization: Bearer;<access_token>`（分号分隔，历史写法）是否仍有效
- [ ] `Resource-Id: volc.megatts.voiceclone` 是否必填、取值是否正确
- [ ] 复刻集群名 `volc_mega_tts` 是否正确（与合成用的 `volcano_tts` 不同）

请求体（submitVolcanoClone）：

- [ ] `audios[].audio_bytes` 是否接受 base64 直传；`audio_format` 允许的取值
- [ ] `source: 2` 的含义与取值
- [ ] `speaker_id` 是否允许自定义（当前用本地 UUID）
- [ ] 样本要求：时长下限/上限、采样率、格式（当前只做前端提示 10-30 秒）

响应与状态机（parseVolcanoState）：

- [ ] `status` 数值语义：0 不存在 / 1 训练中 / 2 成功 / 3 失败 / 4 已激活 —— 是否正确
- [ ] 是否需要额外的「激活」调用（历史版本复刻后需激活才能合成）
- [ ] 训练成功后的音色标识字段名（当前按 `speaker_id`，合成时作为 voice_type 使用）
- [ ] `BaseResp.StatusCode` 的成功值（当前兼容 0 与 3000）

## 已实现但未真实联调的行为

- 训练状态轮询：5 秒一次，最多 5 分钟，超时标失败（`POLL_INTERVAL_MS` / `POLL_MAX_TRIES`）
- 401/403 一律映射为「鉴权失败或未开通声音复刻权限」
- 百炼 CosyVoice 复刻**未实现**：需先确认是否支持本地音频直传（若只支持公网 URL，则要加样本上传托管），当前返回明确中文提示

## 核对方法

1. 打开火山引擎语音技术控制台 → 声音复刻文档，对照上表逐条修正 VoiceService.ts
2. 用真实账号跑一次「新建音色」，观察日志与卡片状态流转
3. 成功后到「设置 → 语音合成」把默认音色设为该克隆音色，测发音验证


## 附：实时 TTS（流式合成）· 2026-10-11

### 已核实并实现：百炼 Qwen-TTS 真流式（SSE）

依据官方文档（help.aliyun.com/zh/model-studio/qwen-tts-api）实测口径：
- 端点与鉴权同非流式，**加请求头 `X-DashScope-SSE: enable`** 即进入流式
- 服务端按 SSE 返回多个 chunk：中间帧 `output.audio.data` 为 base64 音频片段；末帧 `finish_reason = "stop"`、`data` 为空
- **流式音频为 PCM 16bit 单声道 24kHz**（官方 Python/Java 示例的采样率）
- 文本上限 600 字符

实现：`TtsService.synthesizeBailianStream()` → `TtsStreamService`（百炼走真流式，其余回退切片）→
渲染进程 `streamPlayer`（AudioBuffer 按块采样率建buffer，WebAudio 自动重采样播放）→
直推模式另有一条 `resampleTo48k()`（线性插值）喂混音器。

### 仍待核对：火山流式协议

M9 实现了"边合成边播"的**完整管线**（PCM 分块 → 渲染进程 WebAudio 无缝排播 → 混音器直通），
但**取数方式仍是"整段合成后按真实速率切片"**（`TtsStreamService.streamChunks`），并非服务商真流式。
替换为真流式时需要核对：

- [ ] 火山大模型语音合成流式接口：WS 二进制协议（`wss://openspeech.bytedance.com/api/v1/tts/ws_binary`）
      的握手头、事件号（StartConnection/StartSession/TaskRequest/FinishSession）、返回 PCM 格式与采样率
- [ ] 或 HTTP 分块流式端点（若存在，优先——比 WS 二进制简单得多）
- [ ] 百炼 Qwen-TTS 的 stream 参数与 SSE 音频块格式
- [ ] 流式返回的音频采样率/声道是否与混音器口径（48k mono s16le）一致；不一致要在 `TtsStreamService` 里重采样

替换点只有一处：`TtsStreamService.streamChunks()` 的取数方式，下游（渲染进程 streamPlayer、混音器 pushTtsPcm）不用改。

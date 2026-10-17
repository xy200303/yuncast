# 段卡片统一 + 点段播放 + TTS 真人化方案

> 状态：第一批已实施并实测通过（段卡片 + 点段播放 + P0 全部 + 截图修复）；第二、三批待做
> 关联：docs/10-节目化改造方案.md（节目/单元模型）、09-模型与语音服务抽象.md（TTS 抽象层）

---

## 第一部分：段卡片统一（三种播出模式一个抽象）

### 背景

数据层的抽象早已存在：`ProgramAudioUnit`（`src/renderer/src/lib/audioUnits.ts`）就是"段 = 独立合成单位"，主进程 `programUnits.ts` 同口径划分（场景类节目每章一单元、单人讲述每段一单元、散段退化为段级单元）。问题在 UI 层把术语写死成了"章"：`第 X 章`、`章节 · N`、`上一章/下一章`、`{章节名}` 导出变量。

### 设计

**段卡片 = 合成单位的唯一 UI 形态**，三模式共用 `ContentItem`（已是槽位设计，不动结构）：

```
┌ 段卡片 ──────────────────────────────────────────┐
│ [状态图标]  段标题（仅场景命名段显示）  caption · 状态/时长  [跳播] │
│ 段内容（点击 = 播放这段，见第二部分）                │
└──────────────────────────────────────────────┘
```

**caption（段右侧描述）**：新增 `unitCaption(program, unit, index)`，只回答"这是什么位置"：

| 节目类型 | caption |
|---|---|
| reading（有声书/宣讲） | 第 N 章 |
| roleplay（多人剧） | 第 N 场 |
| conversation（对谈/播客） | 环节 N |
| solo 单段（一篇短文） | 正文 |
| solo 多段 | 第 N 段 |
| 场景类里的散段 | 散段 |

分寸：caption 只做"类型 + 序号"，不引入内容语义（"开场""高潮"这类交给 agent 写进标题，不进 caption 规则）。

**标题/正文去重**：`kind === 'utterance'` 的段，标题本来就是正文前 20 字截断 → 不渲染标题行；`kind === 'scene'` 的段标题是独立场景名 → 保留两行。

**合成进度可视化**：列表头 `章节 · 13（点就绪的章立即跳播）` → `内容 · 13 段 · 已合成 12/13（点就绪的段立即跳播）`。

### 术语统一（破坏性更新，不做旧兼容）

- NowPlayingBar：上一章/下一章 → 上一段/下一段
- ExportDialog：模板变量 `{章节名}` → `{段标题}`
- ProgramGateDialog / ProgramsPage："章节文稿" → "节目文稿"
- agent 工具描述里的"章"本轮不动，后续单独统一

### 涉及文件

`audioUnits.ts`（caption）、`PreparedPanel.tsx`、`NowPlayingBar.tsx`、`ExportDialog.tsx`、`ProgramGateDialog.tsx`、`ProgramsPage.tsx`。主进程单元划分、dedupeKey、IPC、音频文件结构全不动。

---

## 第二部分：点段播放（段卡片点击播放，全局试听条）

### 现状

- aux 槽已存在：主进程 AudioPipeline 第二播放槽（`playFile`/`stopAux`），本机出声、不打断主播播报、不进推流
- 但试听 UI 散落两处各自实现：节目页 `ProgramAudioPanel`（previewingId + preview- 前缀判结束 + 卸载停播）、场次记录页 `SessionsPage`（逐条试听又写一遍）
- aux 槽没有用户级暂停（`session.paused` 是背压控制）

### 设计

**1. 共享试听模块（渲染层 `src/renderer/src/lib/audition.ts`）**

全局唯一试听状态（当前条目 key + 标题 + 播放/暂停），对外：

- `audition.toggle({ key, title, audioPath })`：点同一条 = 暂停/继续；点别的 = 顶掉当前
- `audition.stop()`
- 内部处理：互斥顶掉、播完自动收尾（`audio:end` 的 `preview-` 前缀）、页面切换自动停

**2. 全局 `<AuditionBar />`（挂 App 级）**

呼吸点 + 段标题 + 暂停/继续 + 停止。任何页面触发试听都浮在这同一条上。节目页、场次记录删掉本地实现改为调用共享模块（行为不变，实现归一）。

**3. 主进程 aux 用户级暂停**

AudioPipeline 泵循环消费 aux 队列前查 `session.userPaused`，暂停时 aux 不消费、主槽照常——泵循环一个分支，不碰主槽。配套：`IPC.audioPauseAux` + preload `pauseAux(paused)` + 试听状态事件推渲染层。

**4. 三模式铺法**

| 模式 | 列表 | 点击行为 |
|---|---|---|
| 预制（段卡片） | PreparedPanel | 点正文 → 播该段合成音频（`rendered.audioPath`） |
| 滚动（话术池条目） | 话术池列表 | 条目已合成（有 audioPath）→ 点正文播放 |
| 即兴 | 同上 | 同上 |

规则：同时只播一段；没合成的段点了 toast"这段还没合成"；不动话术池/队列/推流；右侧 ▷ 保留跳播语义（预制模式），与试听是两个独立动作。

### 涉及文件

- 主进程：`AudioPipeline.ts`、`index.ts`、`ipc-channels.ts`、`preload/index.ts`
- 渲染层：新增 `lib/audition.ts` + `components/AuditionBar.tsx`；改造 `ProgramAudioPanel.tsx`、`SessionsPage.tsx`、`PreparedPanel.tsx`、话术池列表组件

---

## 第三部分：TTS 真人化（调研结论 + 落地）

### 现有基础

`src/shared/speechTags.ts` 已是统一演法标记层：稿子里只有三种标记（`<cot text=情绪>` 作用域演法 / `<fx>音效` 点位拟声 / `<pause>ms` 停顿），合成时按音色路由编译成厂商方言（volcano-cot / bailian-brackets / plain）。调研结论是：这层架构方向完全正确，各家厂商的真人化能力都能映射进这套抽象。

### 调研结论（2025-10，官方文档一手来源）

**阿里云百炼（已接入）**

| 手段 | 参数/语法 | 说明 |
|---|---|---|
| 自然语言风格指令 | `instruction` ≤100 字符 | Qwen-Audio 全系、cosyvoice-v3.5/v3-flash 复刻音色支持任意指令；控制情绪/语速/方言/角色 |
| 情感标签 | `[excited] [whispers] [sad]` 等 23 个控制标签 | 仅 qwen-audio-3.1-tts-flash / 3.0-plus/flash，写进 text |
| 拟声标签 | `[laughing] [sighing] [gasp] [clears throat]` 等 | 同上，富语言类 |
| 基础参数 | `rate` [0.5,2] / `pitch` [0.5,2] / `volume` [0,100] / `seed` [0,65535] | seed 可复现同一合成（话术去重可用） |
| SSML | `enable_ssml=true` + `<break time>` `<phoneme>` `<say-as>` `<sub>` | Sambert/CosyVoice 均支持；开启后只能发一次 continue-task |
| 纠音 | `hot_fix.pronunciation` / `language_hints` | 多音字、数字读法 |
| 声音复刻 | 10–20 秒干净录音（≤60s、≥16kHz、无 BGM），target_model 绑定，1000 个/账号 | 创建免费 |

**火山引擎豆包（已接入）**

| 手段 | 参数/语法 | 说明 |
|---|---|---|
| 韵律参数 | `speech_rate` [-50,100] / `pitch` [-12,12] / `loudness_rate` / `silence_duration` | **只有 V3 接口有**（V1 不支持音高调节也不支持 2.0 音色） |
| 语音指令 | `context_texts`（不计费） | seed-tts-2.0 精品音色独有："用痛心的语气说"；`[#上文内容]` 引用上文承接语境情绪；复刻音色指定 model 后不可用 |
| 情感参数 | `emotion` + `enable_emotion` + `emotion_scale` [1,5] | 仅 1.0 多情感音色（happy/sad/angry/ASMR/news 等 20+ 种） |
| SSML | `<break time>`（封顶 10s）/ `<phoneme>` / `<say-as>` | 2.0 saturn 音色不支持；双向流式不支持 |
| 复刻 2.0 | 14–30s wav 单声道低噪、`tone_fidelity=true` 还原模式、每音色可训练 15 次 | 约 8 元/万字符 |
| 播客 API | `wss://openspeech.bytedance.com/api/v3/sami/podcasttts` | 双人对话固定 2 音色；**支持自定义/复刻音色**（speaker_additions 透传 req_params）；action=3 直接喂对话文本（单轮 ≤300 字）；语气只能靠文本语气词（无 pitch/emotion 参数）；输出音频 300 元/百万 token（≈0.75 元/百秒），明显贵于普通 TTS |

**其他商用厂商**

| 厂商 | 真人感核心 | 中文情感 | 价格量级 | 接入 | 结论 |
|---|---|---|---|---|---|
| MiniMax speech-2.8 | `emotion` 枚举（7 种）+ voice_design/cloning | 强（原生） | 2–3.5 元/万字符 | 低（HTTP POST） | **第三家首选**：国内直连、便宜、接入最简单 |
| Azure Speech | SSML 全套 + DragonHD 副语言（笑声/叹气/呼吸/咳嗽）+ viseme 口型 | 强 | ~$16–30/百万字符 | 中 | 笑声/叹气/viseme 对虚拟形象有独特价值，备选 |
| ElevenLabs v3/v4 | audio tags `[laughs] [whispers]` + stability 三档 + previous/next_text 跨请求连贯 | 中（tags 需英文） | 贵 5–20 倍 | 低 | 海外版储备 |
| 讯飞 | 超拟人发音人（方言独家：川/豫/粤）+ `[p500]` 停顿 | 强 | 低–中 | 中高（WS+HMAC 签名） | 方言差异化选项 |
| OpenAI gpt-4o-mini-tts | `instructions` 自然语言 | 弱–中 | ~$0.015/分钟 | 最低 | 不支持克隆，不适合主播音色 |

**自部署开源模型（一台带显卡的机器能不能跑：能，4–8GB 显存）**

| 模型 | 中文自然度 | 克隆 | 情感/停顿 | 显存 | 流式 | 商用 License |
|---|---|---|---|---|---|---|
| **CosyVoice 2/3** | ★★★★★ | 3–10s 参考 | Instruct + 拼音 | 4–6GB | ✅ 双向流式 150ms 首包 | ✅ Apache-2.0 |
| **GPT-SoVITS** | ★★★★☆ | 5s 参考 | 弱 | 4–6GB | ✗（RTF 0.028 极快） | ✅ MIT，Windows 一键包 |
| IndexTTS2 | ★★★★★ | ✔ | 最强（8 维情感向量 + emo_alpha） | 6–8GB | ✗（vLLM） | ✅ 月活 1 亿/年营收 10 亿以上才需授权 |
| Fish Speech S2 | ★★★★★ | ✔ | 内联标签 | 10–14GB | ✔ | ⚠️ 年营收 <50 万刀且禁 SaaS |
| F5-TTS | ★★★☆ | ✔ | 弱 | 6–8GB | ✗ | ❌ 权重 CC-BY-NC **禁商用** |
| ChatTTS | ★★★★（对话） | ✗ | 笑声/停顿 token | 4GB | ✗ | ❌ CC BY-NC **禁商用** |
| MeloTTS | ★★★☆ | ✗ | 仅语速 | CPU | 准实时 | ✅ MIT（兜底可用） |
| Spark-TTS | ★★★☆ | ✔ | 仅捏音色 | 6GB | ✗ | ✅ Apache-2.0 |

合规红线：F5-TTS、ChatTTS 权重禁商用不得打包；Fish Speech 有营收上限和禁 SaaS 限制。

### 落地分级

**P0（现有接入立刻能做，不改架构）**

1. **百炼 instruction 贯通**：音色/节目层面允许配置风格指令（"年轻活泼的女性，语速较快，带货场景"），合成时带上
2. **情感标签映射表扩充**：speechTags 的 `COT_STYLE_TO_BAILIAN` 关键词表对齐百炼 23 个官方控制标签补全
3. **seed 复现**：同一文本重复合成用固定 seed，避免话术池轮播时同一段话两种读法
4. **火山迁 V3 接口**：`/api/v3/tts/unidirectional/stream`，获得 pitch/speech_rate/loudness_rate/silence_duration 全套韵律参数
5. **火山 context_texts**：2.0 精品音色用语音指令带情绪（复刻音色不可用，UI 上要有提示）
6. **复刻录音指引内置化**：音色库克隆流程里写清百炼（10–20s）和火山（14–30s wav 单声道）各自的录音要求，验收时前置检查时长/格式
7. **写稿 prompt 去 AI 味**（解决"话术太像 AI"）：
   - 禁用词清单：家人们/宝子们轰炸、排比三连、"不仅…而且…"、过度 emoji 化语气
   - 强制口语化：短句为主、允许语气词（呢/吧/啊/对吧）、每 2–3 句一个 `<pause>`、情绪起伏用 `<cot>` 标注而不是堆砌形容词
   - 数字/价格/单位写明读法（配合 `say-as`/hot_fix）
   - 参考样本：写稿 prompt 里放 2–3 段真人主播话术作为 few-shot

**P1（新增接入/能力）**

8. **MiniMax 接入**（第三家厂商）：HTTP POST 单接口、`emotion` 枚举映射进 speechTags、2–3.5 元/万字符，作为中文情感合成的性价比选项
9. **豆包播客 API 接入**：双人对话类节目（播客/FM 场景）整期生成，action=3 喂 nlp_texts、自定义/复刻音色、`only_nlp_text` 先审剧本再合成；节目类型勾选"播客对话"时走这条路
10. **截图分辨率修复**（顺手）：窗口采集时视频约束给满分辨率（`width/height: { ideal: 8192 }`），消除截图模糊

**P2（本地引擎，离线/零成本/隐私卖点）**

11. **CosyVoice 本地引擎**：Apache-2.0、双向流式 150ms、FastAPI/gRPC 现成——作为"本地 TTS 接入"类型，解决断网兜底、成本归零、话术不出本机三个痛点
12. **GPT-SoVITS 一键克隆**：5 秒样本克隆店主声音（Windows 一键包，MIT），做"克隆你的声音"卖点
13. 打包策略：不内置模型（几个 GB），走"检测本机已部署 → 填地址接入"或"引导下载一键包"

### 不做 / 不做为默认

- Azure/ElevenLabs/OpenAI/讯飞暂不接（有国内直连三家 + 本地引擎后，边际收益低）
- F5-TTS/ChatTTS 不碰（禁商用）
- 播客 API 不做实时互动（它本质是整期生成，不是逐句合成；双人直播互动仍走普通 TTS 双音色轮播）

---

## 实施顺序与验收

1. **第一批（本次）**：第一部分（段卡片抽象）+ 第二部分（点段播放）+ P0 全部 + P1 的截图修复
2. **第二批**：MiniMax 接入、播客 API
3. **第三批**：本地引擎

验收：

- 段卡片：三种模式列表 UI 一致；无标题/正文重复；caption 按节目类型正确显示；列表头显示"已合成 x/N"
- 点段播放：三模式点正文即播；试听条全局唯一；暂停/继续/停止正常；不影响播出队列与推流；节目页/场次记录试听行为不变
- TTS：百炼音色可配 instruction 并生效；固定 seed 同文本两次合成产物一致；火山 V3 参数可调；agent 写稿抽样 20 段无明显 AI 腔禁用词

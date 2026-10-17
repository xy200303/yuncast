---
name: yuncast
description: >-
  通过 YunCast（小云播客坊）操作本机 AI 直播工作台：和主播 Agent 对话、让主播开口播出、
  写稿改稿、TTS 合成出文件、节目制作与开播、订阅直播间事件流、查直播状态。
  用户要求接入 YunCast、注册 MCP、驱动主播说话或制作节目时使用。
---

# YunCast（小云播客坊）

YunCast 是本机 AI 直播工作台。外部 Agent 与窗口里的主播 Agent 用的是**同一份工具目录**：你能调的工具和主播自己调的是同一批实现。**播出类操作会真的出声并进推流，直播间观众能听到**——动手前先确认用户真的在播或真的想播。

## 接入

三种方式，按优先级：

1. **一键写入（最省事）**：让用户在 YunCast「设置 → 开放接口」里打开开关，点你所在 Agent 的「写入配置」按钮，然后重启你的程序。YunCast 要开着，关掉之后调用都会失败。
2. **命令行**：MCP 工具没有出现或调用报错时，改用 YunCast 放在本机的命令 `yuncast`（端点文件里的 `cli` 字段是它的路径）。它和 MCP 操作同一个窗口，不需要用户把令牌贴给你。窗口没开时这条命令会先启动 YunCast。
3. **手动注册**：读端点文件。Windows 是 `%APPDATA%\YunCast\mcp.json`，macOS 是 `~/Library/Application Support/YunCast/mcp.json`，Linux 是 `~/.config/YunCast/mcp.json`。文件不存在时请用户先打开一次 YunCast；`enabled` 不是 `true` 时请用户在设置里启用。把名为 `yuncast` 的这条写进你自己的用户级 MCP 配置（`url` 用文件里的 `url`，`Authorization` 是 `Bearer ` 加文件里的 `token`）。不要在回复、日志或仓库里打印令牌。

## 命令行

```text
yuncast tools
yuncast schema speak
yuncast call status
yuncast call agent_chat '{"text":"跟观众打个招呼"}'
yuncast chat "跟观众打个招呼"
yuncast tts "欢迎光临" --voice <音色id> --out D:/a.mp3
yuncast status
yuncast events --limit 20
yuncast events --follow --kinds comment.new,gift.received
```

`tools` 列工具，`schema` 看参数，`call` 用 JSON 调用。加 `--json` 输出一行 `{"ok":true,"text":"..."}`。长 JSON 用 `--json-file <路径>` 或 `--json-stdin`。

## 事件流（实时监听直播间）

外部 Agent 可以拿到和内置主播同源的事件流（评论/礼物/进场/池水位/触发器/推流状态）：

- **SSE 订阅**：`GET {url 同目录}/events?kinds=comment.new,gift.received&after=<seq>`，带同一个 Bearer 令牌。每条事件一行 JSON，含单调递增的 `seq` 游标；断线重连带 `Last-Event-ID`（或 `after` 参数）续传，游标过旧时服务端发 `gap` 事件跳段。
- **CLI**：`yuncast events --follow`（断线自动续传）。
- **一次性**：`events_recent` 工具或 `yuncast events --limit 50`。

事件驱动的典型回路：订阅 `comment.new` → 自己的 LLM 决策 → `speak` 回话。

## 工具速览（75 个，按域分组；`yuncast tools` 拿全量）

| 域 | 工具 |
| --- | --- |
| 播报 | `speak`（**真出声**，lane: queue/next/interrupt/filler，`speaker`=主播卡 id，`pauseAfterMs` 段后停顿毫秒，`delivery`/`rate`/`pitch` 逐条演法，`emotion`+`emotionScale` 火山情绪，`languageType` 百炼 qwen3-tts 语种）· `pool_status` / `pool_recent` / `pool_revise` / `pool_revoke`（撤单条）/ `pool_reorder`（调序）· `broadcast_control`（pause/resume/skip/clear） |
| 底稿 | `draft_list` / `draft_get`（全文）/ `draft_add` / `draft_write`（批量 1~4 段）/ `draft_edit` / `draft_remove` / `draft_clear`（危险）；写稿用 `speaker`=主播卡 id 逐段指定谁读 |
| 场景/剧本 | `scene_list` / `scene_advance` / `scene_goto` / `scene_create` / `scene_update` / `scene_remove` / `scene_reorder` · `script_list` / `script_get` / `script_save` / `script_delete` |
| 节目 | `program_list` / `program_get` / `program_save`（`language` 多语言播出：auto/Chinese/English/Japanese/Korean/German/French/Russian/Italian/Spanish/Portuguese）· `program_activate` / `program_preflight` / `program_launch`（**真开播**）/ `program_produce_audio` / `program_audio_progress` / `program_export` / `program_delete` / `program_clear_content` |
| 主播/音色 | `persona_list` / `persona_get` / `persona_save` / `persona_delete`（出镜由节目卡司决定，没配卡司导演逐条用 speaker 指定） · `voice_list` / `voice_get`（含引用关系）/ `voice_update`（改名/风格指令） / `voice_analyze_style`（听样本解析风格指令） / `persona_analyze_audio`（听样本写人设+音色指令） / `voice_clone_start` / `voice_delete` |
| TTS | `tts_synthesize`（出文件，`voiceId` 从 `voice_list` 的 `voiceId` 字段取，`outPath` 复制成品；`instruction` 风格指令 ≤100 字，`emotion`/`emotionScale` 火山情绪，`languageType` 百炼 qwen3-tts 语种）· `tts_connections` |
| 知识/商品 | `knowledge_search` / `knowledge_list`（全量清单）/ `knowledge_save` / `knowledge_remove` / `product_sync` / `price_check`（报价的唯一口径） |
| 观众 | `viewer_lookup` / `viewer_note` |
| 触发器 | `trigger_list` / `trigger_get` / `trigger_set` |
| 连接/网络 | `connector_list` / `connector_call` / `connector_restart`（断线重连）· `web_fetch`（给 url 发请求——method/headers/cookies/body/proxy 都能自定义；给 query 联网搜索） |
| 会话/统计 | `session_history` / `session_export`（导出当场播出音频）/ `session_delete`（危险）· `stats_query`（usage 用量 / global 播出互动 / session 单场） |
| 系统 | `status`（全景：节目+主播+话术池+推流+模型接入）· `stream_start`（推流）· `screen_record`（录屏：应用窗口+系统声音，虚拟指针，mp4 落盘）· `screen_capture`（截图：应用窗口 PNG 一帧）· `emergency_stop`（急停） |
| 导演通道 | `agent_chat`（等主播这轮说完返回回复）/ `agent_status` |
| 事件 | `events_recent`（一次性）；实时走 SSE `/events` |

查询类工具都标了 `readOnlyHint`；`danger` 级（出声/开播/删除/急停）在描述里明说了副作用。

## 操作约定

- **先探后动**：不知道有什么节目就先 `program_list`，不知道有什么音色就先 `voice_list`，不知道现在什么状态就先 `status`。id 都从列表里拿，不要自己编。
- **播出即真实**：`speak`、`program_launch`、`broadcast_control`、`stream_start` 直接影响正在播出的直播间。用户没明确要求播出时，不要主动调用。
- `agent_chat` 依赖已选节目：报「先选一个节目」时，用 `program_list` 找到节目后请用户在界面选中，或用 `program_activate` 选中。主播 `busy` 时拒绝并发，等她这轮说完。
- **写稿走底稿工具**：帮用户写剧本/稿子用 `draft_write`（批量入库，待合成）或 `draft_add`（单条急用自动合成），写完 `program_produce_audio` 统一生产。改稿前用 `draft_get` 读全文。
- `tts_synthesize` 的产物默认在应用内部缓存目录；要给用户的文件一律传 `outPath`。缓存是内容寻址的，同文本同音色重合成不重复打接口。
- `program_export` 只支持预制节目（broadcastMode=prepared）；滚动节目的音频是边播边合成的，没有整期文件可导。
- 错误信息里都写了下一步（比如「先 voice_list 拿音色 id」），照着做，不要瞎猜参数重试。

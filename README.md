# 小云播客坊 YunCast（原 Agent Anchor）

基于智能体的 AI 直播助播：AI 主播有人设、有知识、有记忆、有感知，像真人一样直播带货。

纯桌面端应用（Electron），无服务端。LLM/TTS 直连云 API。**主应用不内置任何平台 SDK**：评论/互动由独立的「平台连接器」小程序经本地 WS 事件流（NDJSON）喂进来（见 `docs/04-平台连接器架构.md`）；开发期用内置模拟器（假连接器）。

## 功能清单（M1–M7 完成）

- **话术池**：一切声音的唯一出口。车道（打断/下一条/常规/垫底）、话轮原子播出、前 5 条预合成窗口、去重/时效/限流、腹稿随时修订（revise）
- **主播 Agent**：pi-agent SDK 单脑架构，人设卡（性格/口癖/禁区/编剧模式多角色音色），评论自己决定回不回，下播自动复盘写场次摘要
- **事件触发**：EventBus + TriggerRuntime（过滤/聚合/冷却/单场预算/全局 LLM 速率帽），内建开场白/欢迎新人/送礼感谢/点赞里程碑/冷场自救/整点带节奏/价格变动提醒
- **知识库**：商品（价格护栏——主播报价只能出自 check_price）+ 资料文件（txt/md/docx/pdf 解析，图片收描述）
- **剧本场次**：场景序列剧本 + 场次绑定，advance_scene 逐场推进，进度落库断播能续
- **记忆**：老粉画像（互动/问过什么/偏好笔记）随评论注入，主播可主动 remember_viewer
- **播放链路**：TTS 双通道（火山引擎/阿里云百炼）→ WebAudio（ducking/电平/麦克风接管）→ 伴侣模式只出声
- **评论接入**：平台连接器解耦（本地 WS + NDJSON LiveEvent，断线退避重连 1s→30s）；内置模拟器作为假连接器开发用
- **推流**：FFmpeg 静态帧 + PCM 三路混音（TTS/BGM/麦克风）直推 RTMP，断流指数退避自动重推

## 合规状态

对照 `docs/03-合规清单` 自查：AI 助播定位——真人在场运营，AI 只出声不代发评论；平台数据经独立连接器（单独送审/分发），主应用不碰平台接口、数据不出本机。价格/库存有 check_price 护栏；每条话术可撤销/修订/紧急停止。

## 开发

```bash
npm install          # 装依赖（Electron 二进制慢就设 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/）
npm run dev          # 开发（窗口 1440x900，CDP 9222 供 scripts/cdp.mjs 调试）
npm run typecheck    # tsc --noEmit
npm run build        # electron-vite build
npm run dist         # 出 Windows 安装包（release/；builder 下载也吃 ELECTRON_MIRROR）
npm run icon         # 重新生成应用图标（scripts/gen-icon.mjs，纯 Node 手写 PNG）
```

## 文档

- `docs/01-总体设计.md` — 架构总案（单脑架构 + 话术池 + 事件触发）
- `docs/02-TTS选型调研.md` — 火山/百炼双通道选型
- `docs/03-合规清单.md` — 抖音直播互动工具合规要求
- `docs/04-平台连接器架构.md` — 连接器解耦（WS 事件流 + MCP 动作面，主应用不内置平台 SDK）
- `docs/05-平台接入方案与审核调研.md` — 解耦决策依据与各平台接入对比

## 技术栈

Electron 44 · electron-vite 5 · React 19 · Tailwind CSS 4 · shadcn · zustand · pi-agent（`@earendil-works/*`）· FFmpeg · node:sqlite

上一代工具版（Vue，已归档）：[sonic-anchor](https://github.com/xy200303/sonic-anchor)

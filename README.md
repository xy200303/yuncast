# Agent Anchor（智能体主播）

基于智能体的 AI 直播助播：AI 主播有人设、有知识、有记忆、有感知，像真人一样直播带货。

纯桌面端应用（Electron），无服务端。评论经抖音直播伴侣 PipeSDK 本地接入，LLM/TTS 直连云 API。

## 功能清单（M1–M7 完成）

- **话术池**：一切声音的唯一出口。车道（打断/下一条/常规/垫底）、话轮原子播出、前 5 条预合成窗口、去重/时效/限流、腹稿随时修订（revise）
- **主播 Agent**：pi-agent SDK 单脑架构，人设卡（性格/口癖/禁区/编剧模式多角色音色），评论自己决定回不回，下播自动复盘写场次摘要
- **事件触发**：EventBus + TriggerRuntime（过滤/聚合/冷却/单场预算/全局 LLM 速率帽），内建开场白/欢迎新人/送礼感谢/点赞里程碑/冷场自救/整点带节奏/价格变动提醒
- **知识库**：商品（价格护栏——主播报价只能出自 check_price）+ 资料文件（txt/md/docx/pdf 解析，图片收描述）
- **剧本场次**：场景序列剧本 + 场次绑定，advance_scene 逐场推进，进度落库断播能续
- **记忆**：老粉画像（互动/问过什么/偏好笔记）随评论注入，主播可主动 remember_viewer
- **播放链路**：TTS 双通道（火山引擎/阿里云百炼）→ WebAudio（ducking/电平/麦克风接管）→ FFmpeg 混音直推 RTMP 或伴侣模式只出声
- **评论接入**：PipeSDK 原生模块本地直连直播伴侣（互动工具入口启动自动接入），开发期有内置模拟器（评论/进场/礼物/点赞）

## 合规状态

对照 `docs/03-合规清单` 自查：

- 仅直播伴侣 EXE 互动工具形态，评论只走 PipeSDK `OPEN_LIVE_DATA`，无任何抓包/逆向/自动发评论能力
- AI 输出只有语音播报（不代主播发文字），每条话术可撤销/修订/紧急停止
- 价格/库存数字有 check_price 护栏，主播无知识库依据不得报价
- 打包提审前需在开放平台按实际能力申请「互动数据」权限

## 开发

```bash
npm install          # 装依赖（Electron 二进制慢就设 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/）
npm run dev          # 开发（窗口 1440x900，CDP 9222 供 scripts/cdp.mjs 调试）
npm run typecheck    # tsc --noEmit
npm run build        # electron-vite build
npm run dist         # 出 Windows 安装包（release/）
npm run native:build # 重编译 PipeSDK 原生模块（node-gyp，pipe_sdk.node 已预编译入库，一般不用跑）
npm run icon         # 重新生成应用图标（scripts/gen-icon.mjs，纯 Node 手写 PNG）
```

## 文档

- `docs/01-总体设计.md` — 架构总案（单脑架构 + 话术池 + 事件触发）
- `docs/02-TTS选型调研.md` — 火山/百炼双通道选型
- `docs/03-合规清单.md` — 抖音直播互动工具合规要求

## 技术栈

Electron 44 · electron-vite 5 · React 19 · Tailwind CSS 4 · shadcn · zustand · pi-agent（`@earendil-works/*`）· FFmpeg · node:sqlite

上一代工具版（Vue，已归档）：[sonic-anchor](https://github.com/xy200303/sonic-anchor)

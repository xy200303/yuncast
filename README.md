# Agent Anchor（智能体主播）

基于智能体的 AI 直播助播：AI 主播有人设、有知识、有记忆、有感知，像真人一样直播带货。

纯桌面端应用（Electron），无服务端。评论经抖音直播伴侣 PipeSDK 本地接入，LLM/TTS 直连云 API。

## 文档

- `docs/01-总体设计.md` — 架构总案（单脑架构 + 话术池 + 事件触发）
- `docs/02-TTS选型调研.md` — 火山/百炼双通道选型
- `docs/03-合规清单.md` — 抖音直播互动工具合规要求

## 技术栈

Electron 44 · electron-vite 5 · React 19 · Tailwind CSS 4 · shadcn · zustand · pi-agent（`@earendil-works/*`）· FFmpeg · node:sqlite

## 状态

M1 骨架进行中。上一代工具版（Vue，已归档）：[sonic-anchor](https://github.com/xy200303/sonic-anchor)

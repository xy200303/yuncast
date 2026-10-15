<p align="center">
  <img src="src/renderer/assets/logo.svg" width="80" height="80" alt="小云播客坊 Logo" />
</p>

<h1 align="center">小云播客坊 YunCast</h1>

<p align="center">
  <strong>你的 AI 主播，开场就能播。</strong>
</p>

<p align="center">
  为不会直播的店家和企业而生：AI 主播自己写稿、用克隆的声音播报、<br>
  看到评论自己决定怎么回——直播带货、有声书、播客节目，一个工作台全包。
</p>

<p align="center">
  <a href="https://github.com/xy200303/yuncast/releases/latest">📦 下载</a> •
  <a href="https://yuncast.xyun.dev/">📖 使用文档</a> •
  <a href="https://github.com/xy200303/yuncast/issues">💬 反馈</a>
</p>

<p align="center">
  <a href="https://github.com/xy200303/yuncast/releases/latest"><img src="https://img.shields.io/github/v/release/xy200303/yuncast?style=for-the-badge" alt="Release" /></a>
  <img src="https://img.shields.io/badge/Electron-44-47848F?style=for-the-badge&logo=electron&logoColor=white" alt="Electron 44" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React 19" />
  <img src="https://img.shields.io/badge/TypeScript-7-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript 7" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="MIT" />
</p>

---

## ✨ 特性

|     | 功能 | 说明 |
| --- | ---- | ---- |
| 🎙️ | **智能主播 Agent** | 人设卡 + 编剧模式，主播自己写稿自己播；评论回不回、怎么回，它像真人一样自己判断 |
| 📻 | **四种节目形态** | 一个人讲 / 多人聊天 / 照着稿子读 / 分角色表演——直播带货、有声书、播客、FM 全覆盖 |
| 🔀 | **三种播出方式** | 现场发挥（无稿纯互动）/ 边播边准备（滚动合成）/ 全部做好再播（预制门禁，音频不齐不开播） |
| 🗣️ | **声音管线** | 火山引擎 / 阿里云百炼 / 播客专用大模型多 TTS 适配；克隆店家声音；多角色各配音色 |
| 💬 | **评论互动** | 平台连接器经本地事件流喂评论；收件箱去重聚合、自适应限速，高频不刷屏、低频不掉线 |
| 🎚️ | **播出控制** | 话术池车道（打断 / 插队 / 常规 / 垫底）、BGM ducking、麦克风真人接管、一键急停 |
| 📤 | **音频导出** | 节目整体导出 MP3/WAV，分章或合并、响度归一，可直接上传喜马拉雅 / 小宇宙 |
| 📊 | **用量看板** | LLM tokens 与 TTS 字符按节目归组，30 天趋势可视化，花多少心里有数 |
| 🤖 | **Agent 全权运营** | 主播可增删查改剧本、音色、节目、主播团；破坏性操作先弹窗请示导演再动手 |

---

## 📸 界面预览

<p align="center">
  <img src="website/guide/screenshots/live.png" alt="直播台" />
  <br><em>直播台：话术池队列 + 评论流 + 事件流，右侧直接和主播对话</em>
</p>

<table>
  <tr>
    <td><img src="website/guide/screenshots/programs.png" alt="节目" /></td>
    <td><img src="website/guide/screenshots/anchors.png" alt="主播团" /></td>
  </tr>
  <tr>
    <td align="center"><em>节目：形态 × 播出方式 × 播完策略</em></td>
    <td align="center"><em>主播团：人设卡点击弹窗配置</em></td>
  </tr>
  <tr>
    <td><img src="website/guide/screenshots/voices.png" alt="音色库" /></td>
    <td><img src="website/guide/screenshots/stats.png" alt="数据" /></td>
  </tr>
  <tr>
    <td align="center"><em>音色库：云端音色 + 声音克隆</em></td>
    <td align="center"><em>数据：画像 · 摘要 · 用量看板</em></td>
  </tr>
</table>

---

## 💡 技术亮点

### 话术池：一切声音的唯一出口

主播临场说的一句、底稿预合成的一段、导演人工播报的一条，全部进同一个话术池：车道定优先级、话轮原子播出、前五条预合成窗口、去重时效限流。播出引擎只跟池子打交道，谁生产的声音不关心——这是互动、剧本、触发器能自由混搭的前提。

### 事件收件箱：像真人一样看评论

评论、进场、礼物先进收件箱而不是直接打断主播：去重、按人归组、5–30 秒自适应聚合、每分钟速率帽、超期自动作废。评论洪峰时主播一次看一批，冷清时一条也能及时到——成本与体验两头都顾住。

### 冻结快照与预制门禁

底稿合成后冻结成音频快照（RenderedAudioRef），稿子一改指纹即失效；「全部做好再播」的节目在开播前过门禁，哪些章节缺音频、哪些已过期一屏列清，不修齐不开播——绝不会播到一半发现是旧稿的声音。

---

## 🚀 快速开始

### 1. 下载安装

前往 [Releases](https://github.com/xy200303/yuncast/releases/latest) 下载（未做代码签名）：

| 平台 | 文件 |
| ---- | ---- |
| Windows x64 | `小云播客坊 Setup <版本号>.exe` |

> ⚠️ **Windows**：SmartScreen 提示「未知发布者」时，点「更多信息」→「仍要运行」。

### 2. 配两把钥匙

设置页填入：LLM 服务商（DeepSeek / 豆包 / OpenAI 兼容 / Anthropic 均可）的 API Key，和 TTS 服务商（火山引擎 / 阿里云百炼）的 API Key。要克隆店家声音，在音色库里传一段 10 秒以上的干净录音。

### 3. 四步开播

**建主播**（人设卡 + 音色）→ **建节目**（选形态与播出方式）→ **让主播写稿**（对话框里说一句「给这场写稿」）→ **启动节目**。评论接入由平台连接器负责（独立小程序，本地事件流对接，主应用不含任何平台 SDK）。

详细图文教程见 [使用文档](https://yuncast.xyun.dev/)。

---

## 🛠️ 本地开发

```bash
npm install
npm run dev          # 开发模式
npm run typecheck    # 类型检查
npm run build        # 构建
npm run dist:win     # 打包 Windows 安装包
```

推送到 `main` 会跑类型检查和构建；打上与 `package.json` 版本一致的 tag（如 `v0.1.0`）后，CI 打包 Windows 安装包并发布 Release。

## 📁 项目结构

```
├── src/main/             # 主进程：窗口、数据库、播出引擎
│   └── services/         # Agent、话术池、TTS、事件收件箱、导出、推流
├── src/preload/          # 渲染进程 IPC 桥
├── src/renderer/         # React 界面（直播台、节目、主播团、数据看板）
│   └── assets/           # 品牌图形（logo.svg，图标也由它生成）
├── src/shared/           # 主/渲染共享类型、IPC 通道、品牌常量
├── scripts/              # 图标生成、协议自检
├── docs/                 # 设计文档（方案定稿）
├── website/              # VitePress 官网（GitHub Pages）
└── .github/              # CI 构建与 Release 发布
```

---

## 💬 反馈

问题与建议欢迎提 [Issue](https://github.com/xy200303/yuncast/issues)。

## 📄 协议

[MIT](LICENSE)

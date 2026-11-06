<p align="center">
  <img src="src/renderer/assets/logo.svg" width="80" height="80" alt="小云播客坊 Logo" />
</p>

<h1 align="center">小云播客坊 YunCast</h1>

<p align="center">
  <strong>不会直播，也能自己开一场。</strong>
</p>

<p align="center">
  一个项目就是一个目录：写稿、合成、播出、评论互动都在一个窗口里完成，<br>
  稿子、音频、对话、场次记录全都存在这个目录里，拷走就是完整备份。
</p>

<p align="center">
  <a href="https://yuncast.xyun.dev/">官网</a> •
  <a href="https://yuncast.xyun.dev/guide/quickstart.html">使用文档</a> •
  <a href="https://github.com/xy200303/yuncast/releases/latest">下载</a> •
  <a href="https://github.com/xy200303/yuncast/issues">反馈</a>
</p>

<p align="center">
  <a href="https://github.com/xy200303/yuncast/releases/latest"><img src="https://img.shields.io/github/v/release/xy200303/yuncast?style=for-the-badge" alt="Release" /></a>
  <img src="https://img.shields.io/badge/Electron-44-47848F?style=for-the-badge&logo=electron&logoColor=white" alt="Electron 44" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React 19" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="MIT" />
</p>

---

## 它是什么

把你手上的资料交给导演，它会按项目里定好的场次写一整版底稿；你逐条看、改、试听，满意就合成，然后开播。
直播中它按稿子顺序播，遇到评论可以按你开的自动响应回一句，你也可以随时叫它改稿、插话、跳过。

- **项目制**：一个项目 = 一个目录 = 一个库。切换项目就是切换一整套场次、稿子、对话与音频
- **单窗口工作台**：一条卡片流看全部内容，一根播放条管进度，评论流/事件流是常驻标签
- **三步开播**：写稿 → 合成 → 播放，配置都在同一个弹窗里，来回改随时可以退回去
- **声音可控**：本场一个默认音色，个别段落可以单独覆盖；也可以克隆自己的声音
- **不会串台**：「语言 / 预设」在播出中锁定，互动开关随时可调

## 三步开播

1. **写稿**：说清商品/卖点/受众，导演按场次逐段写进底稿库；写的过程你能插话，拿不准它会先问你
2. **合成**：选本场音色与合成时机——预合成（开播前全部做好）/ 边播边合（播一段备几段）/ 实时（边说边合成）
3. **播放**：确认收尾方式后开播——一遍播完 / 循环返场 / 一直播（播完接着写新内容），然后就是听和控场

## 特性

| 功能 | 说明 |
| --- | --- |
| **项目即目录** | 场次、底稿、对话、音频都在项目目录里；项目菜单可**导入/导出 ZIP**，换台电脑直接打开 |
| **导演写稿** | 按项目的场次结构逐段写，查资料核对价格口径；语言、形态、风格随每轮任务书传给导演 |
| **多语言** | 写稿参数里选语言，正文按该语言写、中文对照放译文栏；写稿工具会按语言校验，串语言直接拒收 |
| **声音** | 火山引擎 / 阿里云百炼；克隆店家嗓音（10–30 秒干净人声）后整场使用，段落可单独覆盖 |
| **播放顺序** | 顺序只认稿子：循环从头再来、上一段复用同一段、现场插话不参与复播 |
| **评论互动** | 评论经独立连接器接入；顶栏「自动响应」决定哪些动态派给主播，播出中改完立刻生效 |
| **虚拟声卡** | 输出可切到 VB-CABLE / VoiceMeeter，推流软件麦克风选 `CABLE Output`，系统声音进不来；支持一键安装 |
| **推流** | 伴侣模式（只出声）或 FFmpeg 直推 RTMP |
| **场次与用量** | 每场留档逐条内容、评论与事件；用量按项目归组看 LLM tokens 与 TTS 字符趋势 |
| **开放接口** | 本机 MCP / 命令行，可把能力开给你常用的 AI Agent |

---

## 0.4 更新要点

> ⚠️ 破坏性更新：旧的卡司/剧本资产/迁移历史全部删除，不兼容旧数据结构。

- **项目制**：项目 = 目录 = 数据库；欢迎页直接进最近项目，项目可导入导出（ZIP，包内相对路径）
- **单窗口直播台**：卡片流 + 带水位的播放条，评论流/事件流常驻；场次大纲、章节点播不再重复一份
- **开播配置三步可回退**：写稿/合成/播放可来回点，合成按钮按合成时机切换
- **一直播**：收尾新增第三档，播完接着写新桥段继续播，不再和「循环返场」同义
- **播放顺序只认稿子**：池条目新增 `queue_seq`；循环回卷复用同一批音频，不复制话术库
- **写稿参数随轮次下发**：语言/形态/风格/收尾不再写死在 system prompt；写稿工具做语言校验
- **虚拟声卡**：输出设备可选、可自动路由，支持一键安装 VB-CABLE
- **工程清理**：删除 20 个数据库迁移与历史兼容层，结构只保留当前形态

---

## 快速开始

### 1. 下载安装

前往 [Releases](https://github.com/xy200303/yuncast/releases/latest) 下载（安装包未做代码签名）：

| 平台 | 文件 |
| ---- | ---- |
| Windows x64 | `YunCast.Setup.<版本号>.exe` |

> [!WARNING]
> SmartScreen 提示「未知发布者」时，点「更多信息」→「仍要运行」。
> 目前只提供 Windows 构建；macOS / Linux 需自行从源码打包。

### 2. 配两把钥匙

打开「设置」：

- **语言模型**：一条接入 = 服务商 + 凭据 + 一组模型。支持 OpenAI 兼容（DeepSeek / 通义千问 / 豆包 / Kimi / 智谱）、OpenAI Responses、Anthropic，也能自定义地址
- **语音合成**：火山引擎（豆包语音）、阿里云百炼

要克隆自己的声音，去「音色库」传一段 10–30 秒干净人声。

### 3. 建项目、写稿、开播

1. 欢迎页「新建项目」——项目就是一个目录，之后所有内容都归它
2. 点「启动直播」进开播配置，先在「写稿」里填商品/卖点/受众，点「开始写稿」
3. 稿子满意后到「合成」选音色与合成时机，再「下一步：开播设置」选收尾方式，确认开播

评论接入由独立的平台连接器负责：装好连接器小软件，把它「设置 → 智能体接口」里的端口与令牌填进「设置 → 连接器」。

更细的说明见官网：[快速上手](https://yuncast.xyun.dev/guide/quickstart.html) · [核心概念](https://yuncast.xyun.dev/guide/concepts.html) · [界面一览](https://yuncast.xyun.dev/guide/interface.html) · [费用与选型](https://yuncast.xyun.dev/guide/cost.html) · [运行要求与排错](https://yuncast.xyun.dev/guide/troubleshooting.html)

---

## 本地开发

```bash
npm install
npm run dev          # 开发模式（Vite + Electron）
npm run typecheck    # 类型检查
npm run build        # 构建到 out/
npm run dist:win     # 打包 Windows 安装包（产物在 release/）
```

打上与 `package.json` 版本一致的 tag（如 `v0.4.0`）后发布 Release。

> 打包时如果 Electron 下载超时，可设 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` 走镜像。

## 项目结构

```
├── src/main/             # 主进程：窗口、SQLite、播出引擎、音频调度
│   └── services/         # 导演 Agent、话术池、TTS、播放循环、推流、项目导入导出
├── src/preload/          # 渲染进程 IPC 桥
├── src/renderer/         # React 界面（直播台、音色库、场次记录、统计）
├── src/shared/           # 主/渲染共享类型与 IPC 通道
├── scripts/              # 图标生成、CLI 构建、播客协议自检
├── docs/                 # 设计文档
└── website/              # VitePress 官网
```

## 数据在哪

- **项目**：默认在「文档 / YunCast Projects / <项目名>」，整个目录拷走就是备份
- **应用配置**：Windows `%APPDATA%\YunCast`（含 API Key 的加密密文与 `secret.key`，备份时一起带走）

---

## 反馈

问题与建议欢迎提 [Issue](https://github.com/xy200303/yuncast/issues)。

## 协议

[MIT](LICENSE)

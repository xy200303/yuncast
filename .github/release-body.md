## 0.3.0

这一版把"同一件事有三个名字"的历史包袱清掉（剧本 / 知识文件 / presenter），并补上克隆验收、播完自动暂停与内置录屏。

### 编排进节目（破坏性重构，自动迁移）

- 场景序列从独立的「剧本」表搬进节目本身：`programs.plan`，`script_id` 与 `scripts` 表退役
- 删掉 `script_*` 五个工具；`scene_*` 直接作用于节目编排（可显式传 `programId`）
- 删节目时编排随之删除；升级时无人引用的历史剧本导出到 `userData/legacy-scenes/*.json` 后清理（本机 8 本里 6 本是孤儿）
- 知识库页面去掉「剧本」栏；节目卡片新增「编排」按钮，就地编辑场次

### 素材统一

- `products` → `materials`，`knowledge_files` → `material_files`；`knowledge_scope` 的 `{products, files}` 收敛成 `{materials}`
- 条目支持**正文**（`content`）、**附件**（上传文件）与**链接**（URL 附件）
- 节目只绑条目；附件随条目走，不再单独配"可用资料文件"
- 新工具 `material_read`：按 id 或名称读正文 + 要点 + FAQ + 全部附件（文件文本截断 2000 字）
- 检索语料纳入正文与附件

### 播出

- **播完自动暂停**：池子见底且没有在途内容（无合成中/无未播存货）时自动进入暂停态，并在对话里留一条旁白；新内容进池自动恢复。用户手动暂停不会被自动续播顶掉
- 池见底判定同时挂在 `pool.empty` 事件与每次池快照上，启动即空、播完没人补货也能覆盖

### 声音

- `voice_calibrate` 升级为**克隆 AB 验收**：先转写目标样本，用样本原话合成探针，再做 6 维 DSP 对比（音高中心/语速/气声/音高范围/起伏/停顿），输出 0–100 相似分、逐维差异与处置建议；自动迭代 rate（≤2 轮，8% 容差），撞到 0.85~1.3 边界会如实说明并给出 `<pause>` 补偿建议
- 修正评分曲线：容差内维度不再被线性压到低分（同一组数据 27 → 91）
- 新增 `voice_transcribe`：逐字转写 + 分句演法标注 + 整体听感
- 修复 `voice_analyze_style` 字数/语速恒为 0（提示词改回 JSON 并带 transcript/rate/pitch）

### 上下文压缩

- 摘要模板改成结构化「交接笔记」六节（会话与节目现状 / 已查证事实 / 承诺 / 刚做完的事 / 待确认问题 / 待办）
- 压缩后自动附「最近动作」清单（代码生成最近 6 次工具调用），避免模型醒来把自己刚做的成果撤掉

### 录屏与演示

- 应用自带录屏/截图：`screen_record`（start/stop/status）、`screen_capture`，落 `userData/recordings` 与 `screenshots`
- 官网新增 1 段功能演示（旁白由应用合成）+ 3 段节目实录（有声书 / 带货 / 跨境英文）

### 其他

- 主播卡 id 前缀 `anchor-*` → `persona-*`；blob 引用类型改新实体名；场次快照列 `cast` → `personas`
- `presenter_*` → `persona_*`；`main` 侧 IPC/工具参数统一为 `personaId` / `personaIds`
- 清理死代码与重复实现：删 `TtsRealtimeService`（恒不可用）、`script_*` 工具、9 条死 IPC 通道、5 个未使用 UI 组件、约 30 处未使用导入；收停播/开播/暂停收敛为单一实现（`endProgram` / `launchAndAnnounce` / `applyPlaybackPause`）
- 日志前缀统一 `[YunCast]`；`npm run typecheck` 与 `--noUnusedLocals` 均为 0 错误

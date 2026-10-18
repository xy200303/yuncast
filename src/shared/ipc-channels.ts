/** IPC 通道常量，main / preload / renderer 共用 */
export const IPC = {
  appInfo: 'app:info',
  configGet: 'config:get',
  configSet: 'config:set',

  // 应用更新（设置 → 关于）
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  /** main → renderer：更新状态变化（检查中/有新版本/下载进度/已就绪/出错） */
  updateStatusEvent: 'update:status-event',

  // 话术池
  poolSay: 'pool:say',
  poolInsertNext: 'pool:insert-next',
  poolRevoke: 'pool:revoke',
  poolRecentPlayed: 'pool:recent-played',
  /** renderer → main：取第一个 ready 条目开始播放（主进程置 playing） */
  /** renderer → main：播报完成回报 */
  /** renderer → main：播放中断（暂停/急停）把这条退回 ready，等恢复重播 */
  poolSnapshot: 'pool:snapshot',
  /** main → renderer：池快照广播 */
  poolSnapshotEvent: 'pool:snapshot-event',

  // TTS
  ttsTest: 'tts:test',
  /** 用表单里还没保存的值测合成（新建接入不必先保存）：入参是完整表单，主进程不查库 */
  ttsTestInput: 'tts:test-input',
  /** 语音合成的供应商接入（设置 → 语音合成）：一家可多条，合成时按音色路由到接入 + 模型 */
  ttsConnectionList: 'tts:connection-list',
  ttsConnectionSave: 'tts:connection-save',
  ttsConnectionRemove: 'tts:connection-remove',

  // 语言模型（供应商接入 + 服务商注册表）
  modelList: 'model:list',
  modelSave: 'model:save',
  modelRemove: 'model:remove',
  /** 连通性测试：不传模型就用该接入模型列表的第一个发最小请求 */
  modelTest: 'model:test',
  /** 用表单里还没保存的值测连通（新建接入不必先保存）：入参是完整表单，主进程不查库 */
  modelTestInput: 'model:test-input',
  /** 服务商能力与配置字段清单（设置页据此动态渲染表单） */
  providersLlmList: 'providers:llm-list',
  /** 语音合成服务商清单（能力位 + 配置字段，设置页与音色选择都用它） */
  providersTtsList: 'providers:tts-list',
  /** 某服务商真实可用的模型 id（设置页的模型列表据此给下拉建议） */
  providersModels: 'providers:models',

  // 主播 Agent
  agentStop: 'agent:stop',
  agentAbort: 'agent:abort',
  agentRestart: 'agent:restart',
  agentStatus: 'agent:status',
  /** 写稿：跳到直播台，派导演给该节目写底稿（过程走对话时间线） */
  agentDraftStart: 'agent:draft-start',
  /** main → renderer：Agent 状态 + 生成中预览 */
  agentStatusEvent: 'agent:status-event',
  /** renderer → main：拉直播间动态收件箱快照（直播台「事件流」） */
  agentInbox: 'agent:inbox',
  /** main → renderer：收件箱变更（携带最新快照，250ms 节流） */
  agentInboxEvent: 'agent:inbox-event',

  // 导演对话
  directorSend: 'director:send',
  /** 导演大脑（全局一份）：读取 / 保存 name + modelConnectionId + model */
  directorGet: 'director:get',
  directorSave: 'director:save',
  /** main → renderer：对话时间线条目（文本流式 / 工具调用 / 请示卡片，按 entry.id upsert；也承载 reset 整体替换） */
  directorTimeline: 'director:timeline',
  /** renderer → main：拉某节目持久化的对话时间线（切节目/刷新/重启后恢复） */
  directorTimelineList: 'director:timeline-list',
  /** 提示词模板（导演手册）：列表 / 保存 / 恢复默认 */
  promptTemplatesList: 'prompt-templates:list',
  promptTemplatesSave: 'prompt-templates:save',
  promptTemplatesReset: 'prompt-templates:reset',
  /** renderer → main：播报控制（暂停时连主播产出一起停） */
  playbackSetPaused: 'playback:set-paused',
  /** main → renderer：播报控制（主播工具 pause_broadcast/resume_broadcast/skip_current 触发） */
  playbackControlEvent: 'playback:control',

  // 人设卡
  personaList: 'persona:list',
  personaChanged: 'persona:changed',
  /** 统一数据变更（personas/voices/knowledge/drafts/triggers/sessions）：界面按 scope 重拉对应数据 */
  dataChanged: 'data:changed',
  personaSave: 'persona:save',
  personaRemove: 'persona:remove',

  // 实时 TTS 流式合成（主进程内部：AudioPipeline 的 PCM 生产者，不再直接对渲染层开口）
  /** 主进程 → 渲染层：音频 PCM 片（唯一的出声数据流） */
  audioPcm: 'audio:pcm',
  /** 主进程 → 渲染层：电平（RMS） */
  audioLevel: 'audio:level',
  /** 主进程 → 渲染层：一段播放结束 */
  audioEnd: 'audio:end',
  /** 渲染层 → 主进程：本机监听主音量（不影响推流那一路的电平） */
  audioSetMasterVolume: 'audio:set-master-volume',
  /** 渲染层 → 主进程：紧急静音（AI 两路一起哑；麦克风人声不受影响） */
  audioSetMuted: 'audio:set-muted',
  /** 渲染层 → 主进程：BGM（选文件 / 播放 / 停止 / 音量）；推流侧由混音器自己循环 */
  /** 渲染层 → 主进程：停掉当前 AI 播报（跳过这条 / 紧急停止；BGM 与推流不断） */
  audioStopAll: 'audio:stop-all',
  /** 渲染层 → 主进程：aux 槽播放指定音频文件（试听用；dev 下渲染层读不了 file://，统一走主进程出声） */
  audioPlayFile: 'audio:play-file',
  /** 渲染层 → 主进程：停掉 aux 槽（停止试听；不动主槽播报） */
  audioStopAux: 'audio:stop-aux',
  /** 渲染层 → 主进程：aux 槽用户级暂停/继续（试听条；与解码背压是两码事） */
  audioPauseAux: 'audio:pause-aux',
  /** 渲染层 → 主进程：主槽章内 seek（预制节目长音频；ffmpeg 以 -ss 重启解码） */
  audioSeekMain: 'audio:seek-main',
  /** 主进程 → 渲染层：主槽播放进度（预制节目进度条用） */
  audioProgressEvent: 'audio:progress',

  // 音色库（M8 声音克隆）
  voiceList: 'voice:list',
  voiceClone: 'voice:clone',
  voiceRemove: 'voice:remove',
  voiceUploadSample: 'voice:upload-sample',
  /** 把本地样本传到临时文件站换公网直链（百炼复刻只收 URL） */
  voiceUploadTemp: 'voice:upload-temp',
  /** 用该音色合成一句固定文案试听（用该音色自己那家的接入，那条接入没配就返回中文错误） */
  voicePreview: 'voice:preview',
  /** 编辑音色：改名 / 风格指令（平台侧的复刻音色标识不动） */
  voiceUpdate: 'voice:update',
  /** 谁在用它：人设卡 / 节目 / 话术库条目（删除前提示占用） */
  voiceUsage: 'voice:usage',
  /** main → renderer：音色列表变化（训练状态更新） */
  voiceChanged: 'voice:changed',

  /** main → renderer：评论事件（toast 展示用） */
  commentEvent: 'comment:event',

  // 知识库
  knowledgeProductList: 'knowledge:product-list',
  knowledgeProductSave: 'knowledge:product-save',
  knowledgeProductDelete: 'knowledge:product-delete',
  /** 从连接器同步商品（抖音商城绑定商品 → 知识条目，按 externalId 去重更新） */
  knowledgeProductSync: 'knowledge:product-sync',
  materialFileList: 'knowledge:file-list',
  /** 选文件 → 解析 → 入库，一步完成 */
  materialAttachUrl: 'material:attach-url',
  knowledgeFileUpload: 'knowledge:file-upload',
  materialFileDelete: 'knowledge:file-delete',

  // 触发器
  triggerList: 'trigger:list',
  triggerSave: 'trigger:save',
  triggerDelete: 'trigger:delete',
  triggerToggle: 'trigger:toggle',

  // 用量看板（数据页）：合计 + 趋势 + 按节目分布 + 明细记录
  statsUsageDashboard: 'stats:usage-dashboard',
  statsUsageRecords: 'stats:usage-records',
  statsTtsRecords: 'stats:tts-records',
  /** 统计页全局图表（场次/互动/热词），支持时间范围 + 节目筛选 */
  statsGlobal: 'stats:global',
  /** 单场可视化（场次详情「图表」tab） */
  statsSession: 'stats:session',

  // 剧本
  scriptList: 'script:list',
  scriptSave: 'script:save',
  scriptDelete: 'script:delete',

  // 节目
  programList: 'program:list',
  programSave: 'program:save',
  programDelete: 'program:delete',
  programSetActive: 'program:set-active',
  programChanged: 'program:changed',
  /** 开播前预检（docs/07 §8.5）：返回检查项清单，UI 弹确认 */
  programPreflight: 'program:preflight',
  /** 启动节目：加载配置 + 应用人设/音色 + 装载话术库 + 启动主播 */
  programLaunch: 'program:launch',
  /** 切场景：跳剧本场景 + 装载新场景话术库 */
  /** 统一音频生产入口（docs/10 §7.5）：rolling=提前合成全部（后台）；prepared=生成节目音频（同步跑完返回汇总） */
  programProduceAudio: 'program:produce-audio',
  /** 生产前的合成计划摘要（声音选择弹窗用）：段数、就绪/待合成计数、声音描述、粗估时长 */
  programProducePlan: 'program:produce-plan',
  /** 预制节目正式播放门禁（docs/10 §7.8）：结构化结果，未通过不静默跳过 */
  programPlayGate: 'program:play-gate',
  /** 节目的编排（场景序列）：读/存都按节目走，不再有独立剧本 */
  programScenesGet: 'program:scenes-get',
  /** 全部节目的编排视图（沿用 Script 形状，渲染层算音频单元用） */
  programPlans: 'program:plans',
  /** 让界面切到指定页（演示/录屏用：外部调用把直播台推到前台） */
  uiNavigate: 'ui:navigate',
  programScenesSave: 'program:scenes-save',
  /** 节目音频进度（单元总数/ready/synthesizing/failed/stale/pending） */
  programAudioProgress: 'program:audio-progress',
  /** 导入外部音频（§7.4）：主进程弹文件选择框，挂到指定 Scene/DraftUnit 的 rendered */
  programImportAudio: 'program:import-audio',
  /** 预制节目按段跳播（docs/10 §11.5 上一段/下一段/段点播）：装池提到队首并打断当前条目 */
  programPlayUnit: 'program:play-unit',
  /** main → renderer：预制音频资产变化（Scene/DraftUnit 的 rendered 更新，渲染层刷新进度） */
  programAudioEvent: 'program:audio-event',
  /** 节目音频导出（docs/10 §8.3）：分章/合并、MP3/WAV、响度归一，逐单元进度走 programExportEvent */
  programExport: 'program:export',
  /** 取消进行中的导出（杀 ffmpeg、清临时文件，已产出的成品文件保留） */
  programExportCancel: 'program:export-cancel',
  /** 选导出输出目录（系统目录选择框） */
  programExportPickDir: 'program:export-pick-dir',
  /** 用系统文件管理器打开导出输出目录 */
  programExportOpenDir: 'program:export-open-dir',
  /** main → renderer：导出进度（当前第几个/共几个/当前段标题/终态） */
  programExportEvent: 'program:export-event',

  // 场记（场次记录）
  /** 场次列表（可按节目筛选，新场在前） */
  sessionList: 'session:list',
  /** 场次详情：场次行 + 播出话术条目 + 评论/事件时间线 */
  sessionDetail: 'session:detail',
  /** 删场次：连带删播出条目（解 blob 引用）与事件镜像 */
  sessionDelete: 'session:delete',
  /** 场次音频导出：实际播出的有音频条目按播放顺序导出（进度复用 programExportEvent） */
  sessionExport: 'session:export',

  // 话术库（节目底稿）
  draftUnitList: 'draft-unit:list',
  draftUnitSave: 'draft-unit:save',
  draftUnitDelete: 'draft-unit:delete',
  draftUnitClear: 'draft-unit:clear',
  /** 只清已合成音频（文稿保留，回到待合成可重蒸） */
  draftUnitClearAudio: 'draft-unit:clear-audio',
  /** 批量预合成（异步，进度走 draftUnitEvent） */
  /** main → renderer：单条话术状态变化（预合成进度） */
  draftUnitEvent: 'draft-unit:event',

  // 系统对话框
  dialogPickFile: 'dialog:pick-file',

  // 推流
  streamStart: 'stream:start',
  streamStop: 'stream:stop',
  streamStats: 'stream:stats',
  /** main → renderer：推流状态/码率 */
  streamStatsEvent: 'stream:stats-event',
  /** 直推混音器：麦克风 PCM 帧（TTS/BGM 由主进程 AudioPipeline 直连混音器，不再经渲染层转手） */
  streamMicPcm: 'stream:mic-pcm',

  // 平台连接器
  connectorStatus: 'connector:status',
  connectorRestart: 'connector:restart',
  /** main → renderer：连接器状态 */
  connectorStatusEvent: 'connector:status-event',
  /** 出站动作口：调连接器工具（CompanionBridge 并入） */

  // 开放接口（MCP / CLI，设置 → 开放接口）
  mcpGet: 'mcp:get',
  /** 保存开放接口配置（enabled/port，regenerateToken=true 换新令牌）并重启服务 */
  mcpSave: 'mcp:save',
  mcpState: 'mcp:state',
  /** main → renderer：MCP 服务运行状态（运行中/端口被占/会话数） */
  mcpStateEvent: 'mcp:state-event',

  // 通用录屏：主进程发起/停止 + 状态查询，渲染层采集（getDisplayMedia + MediaRecorder）分块回传落盘
  recordStart: 'record:start',
  recordStop: 'record:stop',
  recordState: 'record:state',
  /** renderer → main：分块数据 / 采集就绪 / 启动失败 / 收尾完成 */
  recordChunk: 'record:chunk',
  recordReady: 'record:ready',
  recordFail: 'record:fail',
  recordDone: 'record:done',
  /** main → renderer：录制命令（start/stop）与状态广播 */
  recordCmdEvent: 'record:cmd-event',
  recordStateEvent: 'record:state-event'
} as const

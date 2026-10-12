/** IPC 通道常量，main / preload / renderer 共用 */
export const IPC = {
  appInfo: 'app:info',
  configGet: 'config:get',
  configSet: 'config:set',

  // 话术池
  poolSay: 'pool:say',
  poolInsertNext: 'pool:insert-next',
  poolRevise: 'pool:revise',
  poolRevoke: 'pool:revoke',
  poolReorder: 'pool:reorder',
  poolClearLane: 'pool:clear-lane',
  poolStatus: 'pool:status',
  poolRecentPlayed: 'pool:recent-played',
  /** renderer → main：取第一个 ready 条目开始播放（主进程置 playing） */
  poolNext: 'pool:next',
  /** renderer → main：播报完成回报 */
  poolMarkDone: 'pool:mark-done',
  /** renderer → main：播放中断（暂停/急停）把这条退回 ready，等恢复重播 */
  poolRequeue: 'pool:requeue',
  poolSnapshot: 'pool:snapshot',
  /** main → renderer：池快照广播 */
  poolSnapshotEvent: 'pool:snapshot-event',

  // TTS
  ttsTest: 'tts:test',
  /** 语音合成的供应商接入（设置 → 语音合成）：一家一条，音色按归属路由到对应接入 */
  ttsConnectionList: 'tts:connection-list',
  ttsConnectionSave: 'tts:connection-save',
  ttsConnectionRemove: 'tts:connection-remove',

  // 语言模型（供应商接入 + 服务商注册表）
  modelList: 'model:list',
  modelSave: 'model:save',
  modelRemove: 'model:remove',
  /** 连通性测试：用该接入的默认模型发一个最小请求 */
  modelTest: 'model:test',
  /** 服务商能力与配置字段清单（设置页据此动态渲染表单） */
  providersLlmList: 'providers:llm-list',
  /** 语音合成服务商清单（能力位 + 配置字段，设置页与音色选择都用它） */
  providersTtsList: 'providers:tts-list',
  /** 某服务商真实可用的模型 id（设置页的模型列表据此给下拉建议） */
  providersModels: 'providers:models',

  // 主播 Agent
  agentStart: 'agent:start',
  agentStop: 'agent:stop',
  agentRestart: 'agent:restart',
  agentStatus: 'agent:status',
  /** main → renderer：Agent 状态 + 生成中预览 */
  agentStatusEvent: 'agent:status-event',

  // 导演对话
  directorSend: 'director:send',
  /** main → renderer：主播汇报/请示消息 */
  directorEvent: 'director:event',
  /** renderer → main：播报控制（暂停时连主播产出一起停） */
  playbackSetPaused: 'playback:set-paused',
  /** main → renderer：播报控制（主播工具 pause_broadcast/resume_broadcast/skip_current 触发） */
  playbackControlEvent: 'playback:control',

  // 人设卡
  personaGet: 'persona:get',
  personaList: 'persona:list',
  personaSave: 'persona:save',
  personaSetActive: 'persona:set-active',
  personaRemove: 'persona:remove',

  // 实时 TTS 流式合成
  ttsStreamStart: 'tts:stream-start',
  ttsStreamStop: 'tts:stream-stop',
  /** main → renderer：流式 PCM 块 */
  ttsStreamChunk: 'tts:stream-chunk',
  /** main → renderer：流式结束/出错 */
  ttsStreamEnd: 'tts:stream-end',

  // 音色库（M8 声音克隆）
  voiceList: 'voice:list',
  voiceClone: 'voice:clone',
  voiceRemove: 'voice:remove',
  voiceSetDefault: 'voice:set-default',
  voiceUploadSample: 'voice:upload-sample',
  /** 用该音色合成一句固定文案试听（用该音色自己那家的接入，那条接入没配就返回中文错误） */
  voicePreview: 'voice:preview',
  /** 重命名音色 */
  voiceRename: 'voice:rename',
  /** 谁在用它：人设卡 / 场次 / 话术库条目（删除前提示占用） */
  voiceUsage: 'voice:usage',
  /** main → renderer：音色列表变化（训练状态更新） */
  voiceChanged: 'voice:changed',

  /** main → renderer：评论事件（toast 展示用） */
  commentEvent: 'comment:event',

  // 知识库
  knowledgeProductList: 'knowledge:product-list',
  knowledgeProductSave: 'knowledge:product-save',
  knowledgeProductDelete: 'knowledge:product-delete',
  knowledgeFileList: 'knowledge:file-list',
  /** 选文件 → 解析 → 入库，一步完成 */
  knowledgeFileUpload: 'knowledge:file-upload',
  knowledgeFileDelete: 'knowledge:file-delete',

  // 记忆
  memoryViewers: 'memory:viewers',
  memoryEpisodes: 'memory:episodes',

  // 触发器
  triggerList: 'trigger:list',
  triggerSave: 'trigger:save',
  triggerDelete: 'trigger:delete',
  triggerToggle: 'trigger:toggle',

  // 事件时间线
  eventRecent: 'event:recent',

  // 剧本
  scriptList: 'script:list',
  scriptSave: 'script:save',
  scriptDelete: 'script:delete',

  // 场次
  planList: 'plan:list',
  planSave: 'plan:save',
  planDelete: 'plan:delete',
  planSetActive: 'plan:set-active',
  /** 开播前预检（docs/07 §8.5）：返回检查项清单，UI 弹确认 */
  planPreflight: 'plan:preflight',
  /** 启动场次：加载配置 + 应用人设/音色 + 装载话术库 + 启动主播 */
  planLaunch: 'plan:launch',
  /** 切场景：跳剧本场景 + 装载新场景话术库 */
  planGotoScene: 'plan:goto-scene',

  // 话术库（场次底稿）
  utteranceList: 'utterance:list',
  utteranceSave: 'utterance:save',
  utteranceDelete: 'utterance:delete',
  utteranceClear: 'utterance:clear',
  /** 批量预合成（异步，进度走 utteranceEvent） */
  utterancePresynth: 'utterance:presynth',
  /** main → renderer：单条话术状态变化（预合成进度） */
  utteranceEvent: 'utterance:event',

  // 话术库生成 Agent
  generationStart: 'generation:start',
  generationCancel: 'generation:cancel',
  /** main → renderer：生成进度（逐场景） */
  generationEvent: 'generation:event',

  // 系统对话框
  dialogPickFile: 'dialog:pick-file',

  // 推流
  streamStart: 'stream:start',
  streamStop: 'stream:stop',
  streamStats: 'stream:stats',
  /** main → renderer：推流状态/码率 */
  streamStatsEvent: 'stream:stats-event',
  /** 直推混音器：TTS 音频入队 / BGM 控制 / 麦克风 PCM 帧 */
  streamPushTts: 'stream:push-tts',
  streamSetBgm: 'stream:set-bgm',
  streamMicPcm: 'stream:mic-pcm',

  // 平台连接器
  connectorStatus: 'connector:status',
  connectorRestart: 'connector:restart',
  /** main → renderer：连接器状态 */
  connectorStatusEvent: 'connector:status-event',
  /** 出站动作口：调连接器工具（CompanionBridge 并入） */
  connectorCallTool: 'connector:call-tool'
} as const

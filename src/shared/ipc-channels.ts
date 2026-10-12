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
  poolSnapshot: 'pool:snapshot',
  /** main → renderer：池快照广播 */
  poolSnapshotEvent: 'pool:snapshot-event',

  // TTS
  ttsTest: 'tts:test',

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

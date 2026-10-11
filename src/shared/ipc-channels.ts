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

  // 人设卡
  personaGet: 'persona:get',
  personaSave: 'persona:save',

  // 评论模拟器
  simStart: 'sim:start',
  simStop: 'sim:stop',
  simStatus: 'sim:status',
  /** main → renderer：模拟评论事件（toast 展示用） */
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

  // 评论网关
  commentGatewayStart: 'comment-gateway:start',
  commentGatewayStop: 'comment-gateway:stop',
  commentGatewayStatus: 'comment-gateway:status'
} as const

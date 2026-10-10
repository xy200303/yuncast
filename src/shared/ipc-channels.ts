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
  ttsTest: 'tts:test'
} as const

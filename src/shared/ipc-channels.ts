/** IPC 通道常量，main / preload / renderer 共用 */
export const IPC = {
  appInfo: 'app:info',
  configGet: 'config:get',
  configSet: 'config:set'
} as const

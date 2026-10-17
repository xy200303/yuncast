import { useEffect, useRef } from 'react'

/** 统一数据变更的 scope（与主进程 DataChangeScope 对齐） */
export type DataScope =
  | 'personas'
  | 'voices'
  | 'programs'
  | 'drafts'
  | 'knowledge'
  | 'triggers'
  | 'sessions'
  | 'settings'

/**
 * 订阅主进程的统一数据变更广播：agent/MCP/其它窗口改了数据，当前页面按 scope 自动重拉。
 * cb 通过 ref 镜像最新实现，不会因为页面重渲染反复解绑重订阅。
 */
export function useDataRefresh(
  scopes: DataScope[],
  cb: (scope: DataScope, detail?: string) => void
): void {
  const cbRef = useRef(cb)
  cbRef.current = cb
  const key = scopes.join(',')

  useEffect(() => {
    if (!('api' in window)) return
    const wanted = new Set(key.split(','))
    return window.api.data.onChanged((payload) => {
      if (!wanted.has(payload.scope)) return
      cbRef.current(payload.scope as DataScope, payload.detail)
    })
  }, [key])
}

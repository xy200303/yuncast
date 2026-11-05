import { create } from 'zustand'
import type { ProjectRecord } from '../../../shared/types'
import { useAppStore } from './useAppStore'

/**
 * 项目状态（一个项目 = 一个目录 = 一个 project.db）。
 * 应用启动时不自动打开上一次的项目：先落在项目中心，由用户选择进入哪个项目。
 */
interface ProjectState {
  projects: ProjectRecord[]
  current: ProjectRecord | null
  loading: boolean
  refresh: () => Promise<void>
  create: (name: string, dir?: string) => Promise<ProjectRecord | null>
  open: (id: string) => Promise<ProjectRecord | null>
  openAt: (dir: string) => Promise<ProjectRecord | null>
  close: () => Promise<void>
  remove: (id: string) => Promise<void>
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  current: null,
  loading: false,

  refresh: async () => {
    set({ loading: true })
    try {
      set({ projects: await window.api.project.list() })
    } finally {
      set({ loading: false })
    }
  },

  create: async (name, dir) => {
    const result = await window.api.project.create({ name, dir })
    if (!result.ok) throw new Error(result.error)
    await get().refresh()
    return get().open(result.item.id)
  },

  open: async (id) => {
    const result = await window.api.project.open(id)
    if (!result.ok) throw new Error(result.error)
    set({ current: result.item })
    await get().refresh()
    await enterWorkspace()
    return result.item
  },

  openAt: async (dir) => {
    const result = await window.api.project.openAt(dir)
    if (!result.ok) throw new Error(result.error)
    set({ current: result.item })
    await get().refresh()
    await enterWorkspace()
    return result.item
  },

  close: async () => {
    await window.api.project.close()
    set({ current: null })
    await get().refresh()
  },

  remove: async (id) => {
    const result = await window.api.project.remove(id)
    if (!result.ok) throw new Error(result.error)
    if (get().current?.id === id) set({ current: null })
    await get().refresh()
  }
}))

/** 进入工作区：配置里的「当前节目」跟着项目走，直播台一进来就是它；页面回到直播台 */
async function enterWorkspace(): Promise<void> {
  // 导演面板挂的是上一个项目的节目：切项目就摘掉，别让旧项目的标题/上下文带过来
  useAppStore.getState().setAgentPanelContext(null)
  await useAppStore.getState().loadConfig()
  useAppStore.getState().setPage('live')
}

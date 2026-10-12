import {
  TTS_PROVIDER_SHORT,
  type TtsConnectionSafe,
  type TtsModelSpec,
  type TtsProvider,
  type VoiceRecord
} from '../../../shared/types'

// ---------- 模型目录（manifest 驱动：音色严格绑定模型，选音色即隐含选模型） ----------

/** manifest 里的一家服务商（渲染层只用到这几个字段，结构化声明避免依赖主进程类型） */
export interface ManifestLike {
  id: TtsProvider
  label: string
  icon: string
  models: TtsModelSpec[]
}

export interface CatalogModel {
  provider: TtsProvider
  providerLabel: string
  providerIcon: string
  model: TtsModelSpec
}

/** 扁平模型目录：跳过硬实时模型（那是「实时语音」栏的事，不进合成选择器） */
export function flattenModelCatalog(manifests: ManifestLike[]): CatalogModel[] {
  const list: CatalogModel[] = []
  for (const manifest of manifests) {
    for (const model of manifest.models) {
      if (model.kind === 'realtime') continue
      list.push({
        provider: manifest.id,
        providerLabel: manifest.label,
        providerIcon: manifest.icon,
        model
      })
    }
  }
  return list
}

/**
 * 某模型在哪些接入里现在真的能用（usableModels 由主进程逐模型判定：
 * 缺业务空间 ID 的 maas 系模型不会算进来，同一接入里能用的 qwen3 照常用）。
 */
export function connectionsWithModel(
  connections: TtsConnectionSafe[],
  provider: TtsProvider,
  modelId: string
): TtsConnectionSafe[] {
  return connections.filter(
    (connection) => connection.providerId === provider && connection.usableModels.includes(modelId)
  )
}

/** 目录里哪个模型的音色列表含这个音色 id（同名音色可能属于多个模型，如 longanyang） */
export function voiceInCatalog(catalog: CatalogModel[], voiceId: string): CatalogModel[] {
  const id = voiceId.trim()
  if (!id) return []
  return catalog.filter((entry) => entry.model.voices.some((group) => group.voices.some((voice) => voice.id === id)))
}

/** 目录里某音色的显示名（选择器/卡片上用；查不到返回原 id） */
export function catalogVoiceName(catalog: CatalogModel[], voiceId: string): string {
  for (const entry of voiceInCatalog(catalog, voiceId)) {
    for (const group of entry.model.voices) {
      const hit = group.voices.find((voice) => voice.id === voiceId)
      if (hit) return hit.name
    }
  }
  return voiceId
}

/**
 * 系统音色能不能用：得有一条启用了它所属模型的可用接入（合成时就近取最早建的那条）。
 * 目录外的手动音色（`接入::模型::音色` 复合串）不看这里——它的接入与模型写在串里。
 */
export function systemVoiceUsable(
  catalog: CatalogModel[],
  connections: TtsConnectionSafe[],
  voiceId: string
): { usable: boolean; hint?: string } {
  const owners = voiceInCatalog(catalog, voiceId)
  if (owners.length === 0) return { usable: true }
  const hit = owners.find((entry) => connectionsWithModel(connections, entry.provider, entry.model.id).length > 0)
  if (hit) return { usable: true }
  const entry = owners[0]
  return {
    usable: false,
    hint: `没有启用模型「${entry.model.label}」的可用${TTS_PROVIDER_SHORT[entry.provider]}接入：到设置 → 语音合成启用它`
  }
}

// ---------- 克隆音色的归属（按 接入 · 模型 分组） ----------

export interface CloneVoiceGroup {
  key: string
  provider: TtsProvider
  connectionLabel: string
  model: string
  modelLabel: string
  ready: boolean
  voices: VoiceRecord[]
}

/** 克隆音色按「接入 · 模型」分组：克隆音色只吃它自己那条接入和那个模型 */
export function groupCloneVoices(
  voices: VoiceRecord[],
  connections: TtsConnectionSafe[],
  catalog: CatalogModel[]
): CloneVoiceGroup[] {
  const groups = new Map<string, CloneVoiceGroup>()
  for (const voice of voices) {
    const connection = connections.find((item) => item.id === voice.connectionId)
    const key = `${voice.connectionId || voice.provider}::${voice.model}`
    if (!groups.has(key)) {
      const spec = catalog.find((entry) => entry.provider === voice.provider && entry.model.id === voice.model)
      groups.set(key, {
        key,
        provider: voice.provider,
        connectionLabel: connection?.name ?? `${TTS_PROVIDER_SHORT[voice.provider]}（原接入已删除）`,
        model: voice.model,
        modelLabel: spec?.model.label ?? voice.model,
        ready: Boolean(connection?.ready),
        voices: []
      })
    }
    groups.get(key)?.voices.push(voice)
  }
  return [...groups.values()]
}

/**
 * 克隆音色的可用性提示。克隆音色只吃「克隆时那条接入 + 那个模型」，绑定不跨接入、也不跨模型：
 * 没有回退（没有默认接入可回退），接入没了就是合不出声，得把接入加回来或用现有接入重新克隆。
 */
export function cloneVoiceHint(
  voice: VoiceRecord,
  connections: TtsConnectionSafe[]
): { ok: boolean; hint: string } {
  const mine = connections.find((item) => item.id === voice.connectionId)
  const providerLabel = TTS_PROVIDER_SHORT[voice.provider]
  if (!mine) {
    return {
      ok: false,
      hint: `克隆时用的${providerLabel}接入已删除：到设置 → 语音合成把这条接入加回来，或用现有接入重新克隆一个`
    }
  }
  if (mine.usableModels.includes(voice.model)) return { ok: true, hint: '' }
  const enabled = mine.models.some((model) => model.id === voice.model)
  return {
    ok: false,
    hint: enabled
      ? `接入「${mine.name}」的这个模型现在用不了（多半缺业务空间 ID）：到设置 → 语音合成看看`
      : `接入「${mine.name}」没启用模型「${voice.model}」：到设置 → 语音合成勾上它`
  }
}

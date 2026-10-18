import {
  TTS_PROVIDER_SHORT,
  type TtsConnectionSafe,
  type TtsModelSpec,
  type TtsProvider,
  type VoiceRecord
} from '../../../shared/types'
import { parseManualVoice } from '../../../shared/voiceProvider'

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

/** 扁平模型目录：跳过纯实时模型（它们不进合成选择器，通道由接入的实时合成开关决定） */
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
 * 任何地方显示音色的统一反查（docs/REDESIGN 4.4a）：
 * 音色库克隆音色 → 人读名字；手动复合串（`接入::模型::音色`）→ 「手动 ID · 截断」（平台已知，可溯源）；
 * 系统目录音色 → 目录显示名；都查不到（旧数据裸 id）→ 原样返回。
 */
export function voiceDisplayName(
  voices: VoiceRecord[],
  manifests: ManifestLike[],
  voiceId: string
): string {
  const id = voiceId.trim()
  if (!id) return ''
  const clone = voices.find((voice) => voice.voiceType === id)
  if (clone) return clone.name
  const manual = parseManualVoice(id)
  if (manual) return `手动 ID · ${manual.voice.length > 12 ? `${manual.voice.slice(0, 12)}…` : manual.voice}`
  return catalogVoiceName(flattenModelCatalog(manifests), id)
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

// ---------- 音色路由摘要（状态栏：这个嗓音现在走哪家、通不通） ----------

export interface VoiceRouteSummary {
  /** 嗓音显示名（反查规则同 voiceDisplayName） */
  voiceName: string
  /** 实际会去合成的服务商短名（查不到为空串） */
  providerShort: string
  /** 非空 = 这条路由现在合不出声（接入被删/模型没启用等），内容是给小白看的修复指引 */
  broken: string | null
  /** 这把嗓子实际挂在哪个模型上（能干什么看它：局部演绎/语气指令/流式…）；查不到为 null */
  modelSpec: TtsModelSpec | null
}

/**
 * 这个音色现在实际走哪家服务商、通不通（路由思路同主进程 TtsService.routeForVoice：
 * 克隆音色 → 它自己的接入；手动复合串 → 前缀里的接入；系统音色 → 目录反查 + 可用接入）。
 * 渲染层能拿到的数据就这么多，不为显示发明新状态。
 */
export function voiceRouteSummary(
  voices: VoiceRecord[],
  manifests: ManifestLike[],
  connections: TtsConnectionSafe[],
  voiceId: string
): VoiceRouteSummary {
  const id = voiceId.trim()
  const specOf = (provider: TtsProvider, modelId: string): TtsModelSpec | null =>
    manifests.find((item) => item.id === provider)?.models.find((model) => model.id === modelId) ?? null
  if (!id) {
    return { voiceName: '', providerShort: '', broken: '还没选音色：到主播团给这张主播卡选一个', modelSpec: null }
  }
  const clone = voices.find((voice) => voice.voiceType === id)
  if (clone) {
    const hint = cloneVoiceHint(clone, connections)
    return {
      voiceName: clone.name,
      providerShort: TTS_PROVIDER_SHORT[clone.provider],
      broken: hint.ok ? null : hint.hint,
      modelSpec: specOf(clone.provider, clone.model)
    }
  }
  const manual = parseManualVoice(id)
  if (manual) {
    const connection = connections.find((item) => item.id === manual.connectionId)
    const short = manual.voice.length > 12 ? `${manual.voice.slice(0, 12)}…` : manual.voice
    if (!connection) {
      return {
        voiceName: `手动 ID · ${short}`,
        providerShort: '',
        broken: '这个音色挂的语音接入已经删除了：到主播团重选一次音色',
        modelSpec: null
      }
    }
    return {
      voiceName: `手动 ID · ${short}`,
      providerShort: TTS_PROVIDER_SHORT[connection.providerId],
      broken: connection.usableModels.includes(manual.modelId)
        ? null
        : `接入「${connection.name}」没启用这个模型（或缺业务空间 ID）：到设置 → 语音合成处理`,
      modelSpec: specOf(connection.providerId, manual.modelId)
    }
  }
  const catalog = flattenModelCatalog(manifests)
  const owners = voiceInCatalog(catalog, id)
  if (owners.length === 0) {
    return {
      voiceName: id,
      providerShort: '',
      broken: '这个音色系统里查不到（多半是旧数据里手输的）：到主播团重选一次音色',
      modelSpec: null
    }
  }
  const usable = systemVoiceUsable(catalog, connections, id)
  return {
    voiceName: catalogVoiceName(catalog, id),
    providerShort: TTS_PROVIDER_SHORT[owners[0].provider],
    broken: usable.usable ? null : (usable.hint ?? null),
    modelSpec: owners[0].model
  }
}

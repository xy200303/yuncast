import { listTtsProviders } from './providers/registry'
import type { StorageService } from './StorageService'

/**
 * 把「主播名称（音色名）/ 音色记录 id / voiceType」统一解析成可路由的 voiceType。
 * 认不出就原样返回（手动复合串、系统音色原始 id 都能直接走路由）。
 *
 * 为什么按名字：界面上让人记住的是「小满」「心理FM主播」这种名字，不是
 * `cosyvoice-v3.5-flash-anchor86-…` 这种 id。名称是入口，id 是落地。
 */
export function resolveVoiceRef(storage: StorageService, input: string | null | undefined): string | undefined {
  const raw = String(input ?? '').trim()
  if (!raw) return undefined
  const voices = storage.listVoices()
  const hit =
    voices.find((voice) => voice.voiceType === raw) ??
    voices.find((voice) => voice.id === raw) ??
    voices.find((voice) => voice.name === raw) ??
    voices.find((voice) => voice.name.trim().toLowerCase() === raw.toLowerCase())
  if (hit) return hit.voiceType

  // 系统音色目录也认名字（如「芊悦」→ Cherry）
  for (const provider of listTtsProviders()) {
    for (const model of provider.models) {
      for (const group of model.voices ?? []) {
        const found = group.voices.find((voice) => voice.id === raw || voice.name === raw)
        if (found) return found.id
      }
    }
  }
  return raw
}

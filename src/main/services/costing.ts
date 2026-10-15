import type { LlmModelPrice, TtsConnection } from '../../shared/types'

/**
 * 成本换算（写入记录时算好落库，单价改了不追溯历史）：
 * - LLM：cost（元）=（输入 tokens × 输入单价 + 输出 tokens × 输出单价）÷ 1,000,000；
 *   单价条目整体没配（两个价都空）返回 null——只记用量不算钱
 * - TTS：cost（元）= 字符数 ÷ 10,000 × 接入单价（params.pricePer10kChars，元/万字符）；没配返回 null
 */
export function llmUsageCost(
  price: LlmModelPrice | undefined,
  inputTokens: number,
  outputTokens: number
): number | null {
  if (!price || (price.input === undefined && price.output === undefined)) return null
  return (inputTokens * (price.input ?? 0) + outputTokens * (price.output ?? 0)) / 1_000_000
}

export function ttsCharsCost(connection: Pick<TtsConnection, 'params'>, chars: number): number | null {
  const price = Number(connection.params.pricePer10kChars)
  if (!Number.isFinite(price) || price <= 0) return null
  return (chars / 10_000) * price
}

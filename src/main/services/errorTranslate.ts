/**
 * 错误翻译层（docs/REDESIGN 4.10，主进程统一）：技术错误 → 「出了什么事 + 去哪修」。
 *
 * 主进程往外抛的错误大多本来就是人话（如「这条话术没有音色：到主播团给人设卡选一个音色」），
 * 翻译层只接漏网的技术原文（HTTP 状态码 / fetch 异常 / FFmpeg stderr 这类），
 * 匹配不到规则就原样返回——绝不能把人话越翻越技术化。
 */
export interface TranslatedError {
  /** 给用户看的人话：出了什么事 + 去哪修 */
  friendly: string
  /** 技术原文（界面上有「技术细节」折叠的地方用） */
  detail: string
}

interface ErrorRule {
  test: RegExp
  friendly: string
}

/**
 * 规则表：从上往下第一条命中的生效，顺序即优先级。
 * TTS 的规则排在通用 401/403 前面（「火山 TTS 请求失败 401」要翻成语音合成，不是语言模型）。
 */
const RULES: ErrorRule[] = [
  // 麦克风权限（getUserMedia 被系统/用户拒绝）
  {
    test: /notallowederror|permission denied|getusermedia/i,
    friendly: '没拿到麦克风权限：到系统设置里允许 YunCast 使用麦克风，再回来重试'
  },
  // TTS 限流（429：请求太密/配额到顶）——临时错误，系统会自动退避重试
  {
    test: /429|throttl|rate.?quota/i,
    friendly: '语音合成被服务商限流了（请求太密或配额到顶）：系统会自动退避重试；反复出现就到 设置 → 语音合成 换一条接入'
  },
  // TTS 鉴权失败 / 欠费
  {
    test: /(tts|语音|合成)[^\n]{0,60}?(401|403|unauthorized|forbidden)|(401|403|unauthorized|forbidden)[^\n]{0,60}?(tts|语音|合成)/i,
    friendly: '语音合成的密钥不对或账号欠费了：到 设置 → 语音合成 检查接入的密钥和余额'
  },
  // TTS 连不上 / 超时
  {
    test: /(tts|语音|合成)[\s\S]{0,80}?(fetch failed|econnrefused|enotfound|etimedout|eai_again|socket hang up|network|超时|timed?\s*out)/i,
    friendly: '连不上语音合成服务：检查网络，或稍后再试（也可能是服务商在维护）'
  },
  // 推流（FFmpeg / RTMP / 断流重推）
  {
    test: /ffmpeg|断流|rtmp|推流进程/i,
    friendly: '推流断了：到 设置 → 推流 检查推流地址和密钥，再确认网络正常'
  },
  // 模型名不对（服务商 404）
  {
    test: /model not found|404[\s\S]{0,80}?(model|模型)|(model|模型)[\s\S]{0,80}?404/i,
    friendly: '模型名不对（服务商那边查不到这个模型）：到 设置 → 语言模型 重新选一个模型'
  },
  // 语言模型鉴权失败（通用 401/403，TTS 的已在上面拦截）
  {
    test: /401|403|unauthorized|forbidden|invalid[_ ]api[_ ]key|incorrect api key/i,
    friendly: '语言模型的密钥不对或没开通这个模型：到 设置 → 语言模型 检查接入的密钥'
  },
  // 语言模型连不上（fetch 异常 / 拒连 / 域名解析失败）
  {
    test: /fetch failed|econnrefused|enotfound|etimedout|eai_again|socket hang up/i,
    friendly: '连不上模型服务：检查网络，或到 设置 → 语言模型 核对服务地址（本地模型确认服务已启动）'
  },
  // 剩下的超时
  {
    test: /超时|timed?\s*out/i,
    friendly: '服务响应超时：检查网络后重试；用的是本地模型的话，确认本地服务已启动'
  }
]

/** 技术错误 → 人话 + 原文。匹配不到规则时 friendly 就是原文（人话原样放行） */
export function translateError(raw: string): TranslatedError {
  const detail = String(raw ?? '')
  for (const rule of RULES) {
    if (rule.test.test(detail)) return { friendly: rule.friendly, detail }
  }
  return { friendly: detail, detail }
}

/** unknown → 翻译后的 friendly（guard / catch 统一走它） */
export function friendlyError(error: unknown): string {
  return translateError(error instanceof Error ? error.message : String(error)).friendly
}

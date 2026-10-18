import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const CLI = './cli/dist/win-x64/yuncast.exe'
const call = (tool, args) => execFileSync(CLI, ['call', tool, JSON.stringify(args)], { encoding: 'utf8' })

/** 与渲染进程的 CDP 会话（只用于演示录制/回归） */
export async function openUi(port = 9222) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('没有找到应用页面（应用没开或 CDP 端口没开）')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    const job = pending.get(msg.id)
    if (!job) return
    pending.delete(msg.id)
    msg.error ? job.reject(new Error(JSON.stringify(msg.error))) : job.resolve(msg.result)
  })
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return result.result?.value
  }

  /** 等某个文字出现（默认 5s），失败就抛错——绝不让脚本静默跑空 */
  const waitText = async (text, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await evaluate(`(document.body.innerText || '').includes(${JSON.stringify(text)})`)) return true
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error(`等不到界面出现「${text}」（${timeoutMs}ms）`)
  }

  /** 切页：只点左侧栏（x < 260）的同名按钮，点完断言页面文字 */
  const nav = async (label, expect) => {
    const hit = await evaluate(`(() => {
      const buttons = [...document.querySelectorAll('button')]
      const target = buttons.find((el) => {
        const rect = el.getBoundingClientRect()
        return (el.textContent || '').trim() === ${JSON.stringify(label)} && rect.x < 260 && rect.width > 40
      })
      if (!target) return false
      target.click()
      return true
    })()`)
    if (!hit) throw new Error(`左侧栏找不到「${label}」`)
    if (expect) await waitText(expect)
  }

  /**
   * 面板是否真的“看得见”：收起时 aside 只是 visibility:hidden，
   * 里面的 textarea 仍然占着布局尺寸——所以绝不能拿 textarea 的 rect 当可见判据。
   */
  const panelOpen = () =>
    evaluate(`(() => {
      const aside = document.querySelector('aside')
      if (!aside) return false
      if (getComputedStyle(aside).visibility !== 'visible') return false
      const rect = aside.getBoundingClientRect()
      return rect.width > 200 && rect.height > 200
    })()`)

  /** 断言导演输入框真的露在面板里、而且没被别的层盖住 */
  const assertConsoleInput = async () => {
    const verdict = await evaluate(`(() => {
      const ta = document.querySelector('textarea')
      if (!ta) return '没有 textarea'
      if (getComputedStyle(ta).visibility === 'hidden') return 'textarea 仍然隐藏'
      const r = ta.getBoundingClientRect()
      if (r.width < 40 || r.x < 700) return 'textarea 不在右侧面板里 ' + JSON.stringify({ x: Math.round(r.x), w: Math.round(r.width) })
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      if (!hit) return 'textarea 中心点没有命中元素'
      if (hit !== ta && !ta.contains(hit) && !(hit.closest && hit.closest('textarea') === ta)) return 'textarea 被盖住：' + (hit.className || hit.tagName)
      return 'ok'
    })()`)
    if (verdict !== 'ok') throw new Error(`导演输入框不可用：${verdict}`)
    return true
  }

  /** 确保导演面板展开（浮球点开 + 断言可见）；已展开就不动，避免把面板按关掉 */
  const ensurePanel = async () => {
    if (!(await panelOpen())) {
      const clicked = await evaluate(`(() => {
        const ball = document.querySelector('button[title="打开导演"]')
        if (!ball) return false
        ball.click()
        return true
      })()`)
      if (!clicked) throw new Error('找不到导演面板的浮起按钮（button[title="打开导演"]）')
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        if (await panelOpen()) break
        await sleep(150)
      }
      if (!(await panelOpen())) throw new Error('点了浮球，导演面板 5s 内没展开')
    }
    await assertConsoleInput()
    return true
  }

  const close = () => ws.close()
  return { send, evaluate, waitText, nav, ensurePanel, close }
}

/** 录屏开关（走应用自带录屏） */
export function startRecord(name) {
  const out = call('screen_record', { action: 'start', name })
  if (!out.includes('已开始录制')) throw new Error(`开录失败：${out.trim()}`)
  return out.trim()
}

export function stopRecord() {
  const out = call('screen_record', { action: 'stop' })
  const hit = out.match(/成品文件：(.*)/)
  if (!hit) throw new Error(`停止录制失败：${out.trim()}`)
  return hit[1].trim()
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export function saveSegments(paths, file = '.tmp-segs.json') {
  writeFileSync(file, JSON.stringify(paths, null, 2))
}

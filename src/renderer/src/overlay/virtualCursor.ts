/**
 * 画出来的虚拟鼠标：录屏时不再采集系统真鼠标（getDisplayMedia 固定 cursor:'never'），
 * 改由这个覆盖层在窗口里画一个指针 + 点击波纹，视频里的光标和用户的真实鼠标完全脱钩。
 *
 * 两种驱动方式：
 * 1. 真实交互：window 上的 mousemove/mousedown 直接跟手（用户自己操作软件录制时用）；
 * 2. 自动化编排：window.__vc.moveTo/click（CDP/测试脚本用，平滑滑过去再点，演示视频效果）。
 *
 * 只在录屏进行中且 showCursor=true 时可见；平时不存在于画面里。
 */

interface VcApi {
  /** 平滑移动虚拟指针到 (x, y)（CSS 像素，视口坐标） */
  moveTo: (x: number, y: number, durationMs?: number) => Promise<void>
  /** 滑过去 → 波纹 → 对落点元素派发完整指针/鼠标事件序列（等同真实点击） */
  click: (x: number, y: number, durationMs?: number) => Promise<boolean>
}

declare global {
  interface Window {
    __vc?: VcApi
  }
}

const CURSOR_SVG = encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24">' +
    '<path d="M4 2 L4 19 L8.6 15.2 L11.2 21 L13.6 19.8 L11 13.6 L17.5 13.6 Z" ' +
    'fill="#ffffff" stroke="#111111" stroke-width="1.4" stroke-linejoin="round"/></svg>'
)

const STYLE_CSS = `
  .vc-cursor {
    position: fixed; left: 0; top: 0; z-index: 99999; pointer-events: none;
    width: 22px; height: 22px;
    background-image: url("data:image/svg+xml,${CURSOR_SVG}");
    background-size: contain; background-repeat: no-repeat;
    filter: drop-shadow(0 1px 2px rgba(0,0,0,.35));
    will-change: transform;
  }
  .vc-ripple {
    position: fixed; z-index: 99998; pointer-events: none;
    width: 28px; height: 28px; margin: -14px 0 0 -14px;
    border-radius: 9999px; border: 2px solid rgba(59,130,246,.85);
    animation: vc-ripple .45s ease-out forwards;
  }
  @keyframes vc-ripple {
    from { transform: scale(.35); opacity: 1; }
    to { transform: scale(1.6); opacity: 0; }
  }
`

let cursorEl: HTMLDivElement | null = null
let styleEl: HTMLStyleElement | null = null
let visible = false
let curX = window.innerWidth / 2
let curY = window.innerHeight / 2
/** 跟手模式（真实 mousemove）进行时，自动化滑动让位，避免两套位置打架 */
let followUntil = 0

function place(x: number, y: number): void {
  curX = x
  curY = y
  if (cursorEl) cursorEl.style.transform = `translate(${x}px, ${y}px)`
}

function ripple(x: number, y: number): void {
  if (!visible) return
  const el = document.createElement('div')
  el.className = 'vc-ripple'
  el.style.left = `${x}px`
  el.style.top = `${y}px`
  document.body.appendChild(el)
  el.addEventListener('animationend', () => el.remove())
}

function dispatchClick(x: number, y: number): boolean {
  const target = document.elementFromPoint(x, y)
  if (!target) return false
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y })
    )
  }
  return true
}

function animateTo(x: number, y: number, durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    const fromX = curX
    const fromY = curY
    const start = performance.now()
    const step = (now: number) => {
      // 真实鼠标刚动过：用户接管，动画立刻收尾
      if (performance.now() < followUntil) {
        resolve()
        return
      }
      const t = durationMs <= 0 ? 1 : Math.min(1, (now - start) / durationMs)
      const eased = 1 - (1 - t) ** 3
      place(fromX + (x - fromX) * eased, fromY + (y - fromY) * eased)
      if (t < 1) requestAnimationFrame(step)
      else resolve()
    }
    requestAnimationFrame(step)
  })
}

function ensureDom(): void {
  if (cursorEl) return
  styleEl = document.createElement('style')
  styleEl.textContent = STYLE_CSS
  document.head.appendChild(styleEl)
  cursorEl = document.createElement('div')
  cursorEl.className = 'vc-cursor'
  cursorEl.style.display = 'none'
  document.body.appendChild(cursorEl)
  place(curX, curY)
}

export function showVirtualCursor(): void {
  ensureDom()
  visible = true
  if (cursorEl) cursorEl.style.display = ''
}

export function hideVirtualCursor(): void {
  visible = false
  if (cursorEl) cursorEl.style.display = 'none'
}

let inited = false
/** 幂等初始化：挂真实输入监听 + window.__vc 自动化 API。App 启动时调一次 */
export function initVirtualCursor(): void {
  if (inited) return
  inited = true

  window.addEventListener(
    'mousemove',
    (e) => {
      followUntil = performance.now() + 800
      if (visible) place(e.clientX, e.clientY)
    },
    { passive: true }
  )
  window.addEventListener(
    'mousedown',
    (e) => {
      if (visible) ripple(e.clientX, e.clientY)
    },
    { passive: true }
  )

  window.__vc = {
    moveTo: (x, y, durationMs = 600) => animateTo(x, y, durationMs),
    click: async (x, y, durationMs = 600) => {
      await animateTo(x, y, durationMs)
      ripple(x, y)
      await new Promise((r) => setTimeout(r, 120))
      return dispatchClick(x, y)
    }
  }
}

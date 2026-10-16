/* ===========================================================================
   交互指令：按钮与卡片的"手感"层
   用动效引擎的弹簧而不是 CSS transition——回弹带真实过冲，是按下去"有质感"的来源。
   注意：v-press 只用于按钮/链接（动 scale），v-lift 只用于卡片（动 y），
   不要挂在同一个元素上，避免两条动画各自重写 transform 互相覆盖。
   =========================================================================== */
import type { Directive } from 'vue'
import { loadMotion, prefersReduced } from './engine'

type Controls = { stop: () => void } | null
const teardowns = new WeakMap<HTMLElement, () => void>()

/** v-press：按下缩到 0.972，松开/移出用弹簧弹回 */
export const vPress: Directive<HTMLElement> = {
  mounted(el) {
    if (prefersReduced()) return
    let ctrl: Controls = null
    let alive = true
    const to = async (scale: number, stiffness: number, damping: number) => {
      const { animate } = await loadMotion()
      if (!alive) return
      ctrl?.stop()
      ctrl = animate(el, { scale }, { type: 'spring', stiffness, damping })
    }
    const down = () => to(0.972, 720, 34)
    const up = () => to(1, 420, 24)
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    el.addEventListener('pointerleave', up)
    teardowns.set(el, () => {
      alive = false
      ctrl?.stop()
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      el.removeEventListener('pointerleave', up)
    })
  },
  unmounted(el) {
    teardowns.get(el)?.()
    teardowns.delete(el)
  }
}

/** v-lift：指针进入时弹簧抬起，离开落回（阴影交给 CSS :hover，互不打架） */
export const vLift: Directive<HTMLElement, number | undefined> = {
  mounted(el, binding) {
    if (prefersReduced()) return
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return
    const dist = typeof binding.value === 'number' ? binding.value : 4
    let ctrl: Controls = null
    let alive = true
    const to = async (y: number, stiffness: number, damping: number) => {
      const { animate } = await loadMotion()
      if (!alive) return
      ctrl?.stop()
      ctrl = animate(el, { y }, { type: 'spring', stiffness, damping })
    }
    const enter = () => to(-dist, 300, 26)
    const leave = () => to(0, 260, 24)
    el.addEventListener('pointerenter', enter)
    el.addEventListener('pointerleave', leave)
    teardowns.set(el, () => {
      alive = false
      ctrl?.stop()
      el.removeEventListener('pointerenter', enter)
      el.removeEventListener('pointerleave', leave)
    })
  },
  unmounted(el) {
    teardowns.get(el)?.()
    teardowns.delete(el)
  }
}

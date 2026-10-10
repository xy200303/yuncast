import { randomUUID } from 'node:crypto'
import type { LiveComment, SimulatorStatus } from '../../shared/types'

/** 模拟评论语料：问询/优惠/快递/起哄/闲聊都有，覆盖主播常见的评论类型 */
const CORPUS: { author: string; content: string }[] = [
  { author: '爱吃桃的猫', content: '这个多少钱呀' },
  { author: '装修小白', content: '材质是什么的？会不会有味道' },
  { author: '老粉阿珍', content: '上次买的很好用，回购！' },
  { author: '路人甲', content: '能便宜点不' },
  { author: '纠结症患者', content: '有小一号的吗' },
  { author: '快递观察员', content: '几天能发货？发什么快递' },
  { author: '宝妈丽丽', content: '小孩能用吗这个' },
  { author: '等等党', content: '双十一还会更便宜吗' },
  { author: '阳光少年', content: '主播声音好好听' },
  { author: '挑剔大王', content: '看着一般般啊' },
  { author: '省钱小能手', content: '有优惠券吗' },
  { author: '细节控', content: '尺寸具体是多少，能放多大的锅' },
  { author: '路过看看', content: '包邮不' },
  { author: '回头客周周', content: '我家那个用了半年了还很新' },
  { author: '急性子', content: '直接说最低价，别绕弯子' },
  { author: '好奇宝宝', content: '这个怎么用呀，复杂吗' },
  { author: '沉默的大多数', content: '已拍，期待发货' },
  { author: '比较党', content: '和隔壁家比哪个好' },
  { author: '夜猫子', content: '这么晚还在播，辛苦了' },
  { author: '实用主义者', content: '坏了包换吗，售后怎么样' },
  { author: '新进直播间', content: '主播在卖啥呀' },
  { author: '老铁666', content: '6666666' },
  { author: '理性消费', content: '家里已经有两个了，忍住了' },
  { author: '礼物侠', content: '送了个小心心，主播加油' }
]

/**
 * 评论模拟器（PipeSDK 真接入前的评论来源）。
 * 开启后按 3-8 秒随机间隔从语料里抽评论，喂给主播 Agent 并广播给渲染进程。
 */
export class CommentSimulator {
  private timer: ReturnType<typeof setTimeout> | null = null
  private count = 0
  private lastIndex = -1

  constructor(private readonly onComment: (comment: LiveComment) => void) {}

  get running(): boolean {
    return this.timer !== null
  }

  status(): SimulatorStatus {
    return { running: this.running, count: this.count }
  }

  start(): void {
    if (this.timer) return
    this.scheduleNext()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** 手动注入一条（测试用） */
  inject(content: string, author = '测试观众'): void {
    this.emit(author, content)
  }

  private scheduleNext(): void {
    const delay = 3000 + Math.random() * 5000
    this.timer = setTimeout(() => {
      this.emitRandom()
      this.scheduleNext()
    }, delay)
  }

  private emitRandom(): void {
    // 不连续重复同一条
    let index = Math.floor(Math.random() * CORPUS.length)
    if (index === this.lastIndex) index = (index + 1) % CORPUS.length
    this.lastIndex = index
    this.emit(CORPUS[index].author, CORPUS[index].content)
  }

  private emit(author: string, content: string): void {
    this.count += 1
    this.onComment({
      id: `cm-${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      author,
      content,
      ts: Date.now()
    })
  }
}

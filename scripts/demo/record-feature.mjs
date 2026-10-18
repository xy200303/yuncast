/**
 * 功能演示录制（方案 A：分段录再拼）。
 * 每段：切到目标页 → 开录 → 触发一个真实动作 → 等动作结果出现（断言）→ 停录。
 * 动作结果用界面文字断言，失败直接抛错，不会再出现"静默录了个空镜"。
 *
 * 用法：node scripts/demo/record-feature.mjs
 * 产物：.tmp-segs.json（五段视频路径，按播放顺序）
 */
import { execFileSync } from 'node:child_process'
import { openUi, startRecord, stopRecord, sleep, saveSegments } from './ui.mjs'

const CLI = './cli/dist/win-x64/yuncast.exe'
const run = (tool, args) => execFileSync(CLI, ['call', tool, JSON.stringify(args)], { encoding: 'utf8' })

// 万一上一次脚本崩在中途，先把残留录制停掉
try { run('screen_record', { action: 'stop' }) } catch { /* 没在录就算了 */ }
const ui = await openUi()
run('broadcast_control', { action: 'resume' })
const segments = []

try {
  // 清掉上一轮的演示资产，让它们在镜头前重新生成
  for (let round = 0; round < 3; round++) {
    const programs = JSON.parse(run('program_list', {}))
    const demo = programs.filter((p) => p.name === '演示·新品发布场')
    if (demo.length === 0) break
    for (const program of demo) run('program_delete', { programId: program.id, confirmed: true })
  }
  if (JSON.parse(run('program_list', {})).some((p) => p.name === '演示·新品发布场')) {
    throw new Error('清不掉上一轮的「演示·新品发布场」')
  }
  const materials = JSON.parse(run('knowledge_list', {}))
  for (const item of materials['条目'] ?? []) {
    if (item['名称'] === '演示·冻干咖啡') run('knowledge_remove', { knowledgeId: item.id })
  }

  // 段 1：直播台 + 导演面板对话
  // 先把现场收拾干净：切到带货节目（不然导演老想着夜读场景），再 /clear 清掉上一轮的对话，
  // 镜头里就是一段干净的「问一句 → 它自己写稿」。
  run('program_activate', { programId: 'prog-fe1cc09f75' })
  await ui.nav('直播台', '接下来')
  await ui.ensurePanel()
  const cleared = await ui.evaluate(`(async () => {
    const r = await window.api.director.send('/clear')
    return JSON.stringify(r)
  })()`)
  if (!String(cleared).includes('"ok":true')) throw new Error(`清空导演会话失败：${cleared}`)
  await sleep(1500)

  /** 本轮是否已经出现「导演正文」条目（tool/thinking 不算，必须是有字的 text） */
  const hasDirectorText = (since) => {
    const out = execFileSync('node', ['-e', `
      const { DatabaseSync } = require('node:sqlite')
      const db = new DatabaseSync(process.env.APPDATA + '/YunCast/yuncast.db', { readOnly: true })
      const rows = db.prepare("select payload from director_timeline where program_id = 'director' and ts > ?").all(${since})
      let best = 0
      for (const r of rows) {
        const p = JSON.parse(r.payload)
        if (p.type === 'text' && (p.text || '').length > 60) best = Math.max(best, p.text.length)
      }
      console.log(best)
    `], { encoding: 'utf8' })
    return Number(out.trim())
  }

  startRecord('demo-seg1')
  await sleep(1200)
  const askAt = Date.now()
  // 真在面板里打字：镜头里要看见「用户说了什么」，光有导演那边在刷工具看不出是对话
  await ui.evaluate(`(() => { document.querySelector('textarea').focus(); return true })()`)
  for (const ch of '给保温杯写个开场') {
    await ui.send('Input.insertText', { text: ch })
    await sleep(70)
  }
  const typed = await ui.evaluate(`document.querySelector('textarea').value`)
  if (typed !== '给保温杯写个开场') throw new Error(`输入框没吃进文字：${JSON.stringify(typed)}`)
  await sleep(200)
  await ui.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await ui.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await sleep(400)
  const leftover = await ui.evaluate(`document.querySelector('textarea').value`)
  if (leftover) throw new Error(`回车没发出去，输入框还剩：${JSON.stringify(leftover)}`)
  // 断言：导演真的写出了正文（不是只调了个工具就停）
  const deadline = Date.now() + 60000
  let chars = 0
  while (Date.now() < deadline) {
    chars = hasDirectorText(askAt - 2000)
    if (chars > 60) break
    await sleep(600)
  }
  if (chars <= 60) throw new Error('导演没有写出正文：60s 内时间线没有 text 条目')
  await sleep(8000) // 留够读稿时间：正文刚写完就被切走，观众来不及看它写了什么
  segments.push(stopRecord())
  console.log('seg1', segments.at(-1))

  // 段 2：节目页 + 一句话建节目（12s）
  await ui.nav('节目', '新建节目')
  await sleep(800)
  startRecord('demo-seg2')
  await sleep(1500)
  const created = run('program_save', {
    name: '演示·新品发布场',
    theme: '新品发布：冻干咖啡，一句话建节目的演示用场次',
    contentType: 'solo',
    broadcastMode: 'rolling',
    finishMode: 'loop',
    allowLiveEvents: true,
    personaIds: ['persona-mvdhii0a'],
    instruction: '语气轻快，像新品发布会',
    language: 'Chinese',
    knowledgeScope: { materials: '*' }
  })
  if (!created.includes('已新建')) throw new Error(`建节目失败：${created.trim()}`)
  await ui.waitText('演示·新品发布场', 10000) // 卡片真的出现在列表上
  await sleep(8500)
  segments.push(stopRecord())
  console.log('seg2', segments.at(-1))

  // 段 3：素材页 + 新建带正文的条目（12s）
  await ui.nav('素材', '新建条目')
  await sleep(800)
  startRecord('demo-seg3')
  await sleep(1500)
  run('knowledge_save', {
    name: '演示·冻干咖啡',
    kind: 'product',
    price: 39.9,
    content: '冻干工艺，冷水三秒速溶，一条 2g 约等于一杯手冲。',
    sellingPoints: '冷水速溶;零糖零脂;一条 2g;常温保存 18 个月'
  })
  await ui.waitText('演示·冻干咖啡', 8000)
  await sleep(8500)
  segments.push(stopRecord())
  console.log('seg3', segments.at(-1))

  // 段 4：音色库（10s，展示克隆音色与指令）
  await ui.nav('音色库', '新建音色')
  await sleep(800)
  startRecord('demo-seg4')
  await sleep(9000)
  segments.push(stopRecord())
  console.log('seg4', segments.at(-1))

  // 段 5：回直播台（9s）
  await ui.nav('直播台', '接下来')
  await ui.ensurePanel()
  await sleep(800)
  startRecord('demo-seg5')
  await sleep(8000)
  segments.push(stopRecord())
  console.log('seg5', segments.at(-1))
} finally {
  ui.close()
}

saveSegments(segments)
console.log('段落清单 → .tmp-segs.json')

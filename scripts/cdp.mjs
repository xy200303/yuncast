// CDP 工具：shot=截图 | eval=执行 JS | nav=侧边栏点指定页面
import { writeFile } from 'node:fs/promises'
const [action, arg] = [process.argv[2], process.argv[3]]
const list = await (await fetch('http://localhost:9222/json')).json()
const page = list.find((x) => x.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const send = (method, params) =>
  new Promise((resolve) => {
    const mid = ++id
    pending.set(mid, resolve)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result)
    pending.delete(msg.id)
  }
}
ws.onopen = async () => {
  if (action === 'shot') {
    const res = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(arg, Buffer.from(res.data, 'base64'))
    console.log('saved')
  } else if (action === 'eval') {
    const res = await send('Runtime.evaluate', { expression: arg, returnByValue: true, awaitPromise: true })
    console.log(JSON.stringify(res.result?.value ?? res, null, 2))
  } else if (action === 'nav') {
    // 点侧边栏指定文本的导航按钮
    const res = await send('Runtime.evaluate', {
      expression: `(() => {
        const btn = [...document.querySelectorAll('nav button')].find((b) => b.textContent.includes('${arg}'))
        if (!btn) return 'not found'
        btn.click()
        return 'clicked ${arg}'
      })()`,
      returnByValue: true
    })
    console.log(res.result.value)
  }
  process.exit(0)
}
setTimeout(() => {
  console.error('timeout')
  process.exit(1)
}, 10000)

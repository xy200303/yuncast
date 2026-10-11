/**
 * 修订链路回归测试（M9 补充）：
 *   1. 预合成条目 revise → 回 pending 并重新合成出新文本的音频
 *   2. 合成期间 revise（竞态）→ 旧音频作废，最终 ready 的音频对应新文本
 *   3. 流式条目 revise → 直接 ready，文本即声音，不触发合成
 * 运行：node scripts/test-revise.mjs
 */
import { build } from 'esbuild'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const work = mkdtempSync(join(tmpdir(), 'anchor-revise-'))

// electron 桩：app.getPath 指向临时目录，safeStorage 明文透传
const electronStub = `
export const app = { getPath: () => ${JSON.stringify(work)}, isPackaged: false, getVersion: () => '0.0.0-test' }
export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() }
export const BrowserWindow = { getAllWindows: () => [] }
`
writeFileSync(join(work, 'electron-stub.mjs'), electronStub, 'utf8')

await build({
  entryPoints: [join(root, 'scripts/test-revise-entry.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['node:sqlite', 'node:fs', 'node:path', 'node:crypto', 'node:events', 'node:stream'],
  alias: { electron: join(work, 'electron-stub.mjs') },
  outfile: join(work, 'bundle.mjs'),
  logLevel: 'silent'
})

const mod = await import(pathToFileURL(join(work, 'bundle.mjs')).href)
const { run } = mod
const results = await run(work)
let failed = 0
for (const r of results) {
  const mark = r.ok ? 'PASS' : 'FAIL'
  if (!r.ok) failed++
  console.log(`${mark}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`)
}
console.log(`\n${results.length - failed}/${results.length} 通过`)
process.exit(failed === 0 ? 0 : 1)

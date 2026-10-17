#!/usr/bin/env node
/**
 * 跨平台编译 YunCast CLI（Go，零依赖）：产物在 cli/dist/<os>-<arch>/yuncast[.exe]。
 * 目录名用 electron-builder 的 ${os}-${arch} 宏口径（amd64 → x64），打包时按当前平台挑目录进 resources/bin/。
 * 用法：node scripts/build-cli.mjs [os-arch ...]   不带参数 = 全平台
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const ALL = [
  ['windows', 'amd64'],
  ['windows', 'arm64'],
  ['darwin', 'amd64'],
  ['darwin', 'arm64'],
  ['linux', 'amd64'],
  ['linux', 'arm64']
]

// electron-builder ${os}-${arch} 宏口径：win/mac/linux + x64/arm64
function distDir(os, arch) {
  const ebOs = os === 'windows' ? 'win' : os === 'darwin' ? 'mac' : 'linux'
  const ebArch = arch === 'amd64' ? 'x64' : arch
  return `${ebOs}-${ebArch}`
}

const root = join(import.meta.dirname, '..')
const cliDir = join(root, 'cli')
const picked = process.argv.slice(2).length
  ? ALL.filter(([os, arch]) => process.argv.slice(2).includes(`${os}-${arch}`))
  : ALL

if (!picked.length) {
  console.error('没有匹配的目标，可选：' + ALL.map(([o, a]) => `${o}-${a}`).join(' '))
  process.exit(1)
}

for (const [os, arch] of picked) {
  const dir = join(cliDir, 'dist', distDir(os, arch))
  mkdirSync(dir, { recursive: true })
  const out = join(dir, os === 'windows' ? 'yuncast.exe' : 'yuncast')
  execFileSync('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', out, '.'], {
    cwd: cliDir,
    env: { ...process.env, GOOS: os, GOARCH: arch, CGO_ENABLED: '0' },
    stdio: 'inherit'
  })
  console.log(`✓ ${os}-${arch} → ${out}`)
}


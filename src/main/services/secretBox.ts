import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 应用自管的凭据加密（替代 Electron safeStorage / 系统钥匙串）。
 *
 * 为什么不用系统机制：safeStorage 把密钥托管给操作系统（Windows DPAPI / macOS 钥匙串 /
 * Linux libsecret），系统侧密钥一轮换（密码被重置、配置文件损坏、换机器），已存凭据全部
 * 解不开，而且三平台行为不一致。对"装在店家自己电脑上"的产品，可靠性和可预期性更重要。
 *
 * 方案：首次启动生成随机 256 位密钥存 userData/secret.key（仅当前用户可读，尽力 chmod 600），
 * 凭据用 AES-256-GCM 加密落库。密文格式 `v2:` + base64(nonce 12B | tag 16B | ciphertext)。
 * 威胁模型说明：同机同用户的恶意进程两个文件都拿得到，这一点与 DPAPI 持平；
 * 换来的是行为跨平台一致、不怕系统密钥轮换、整个 profile 目录拷走即可用。
 */

const PREFIX = 'v2:'
const KEY_FILE = 'secret.key'

let key: Buffer | null = null

/** 启动时装载（或首次生成）密钥；必须在任何加解密之前调用 */
export function initSecretBox(userDataDir: string): void {
  const file = join(userDataDir, KEY_FILE)
  if (existsSync(file)) {
    const buf = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64')
    if (buf.length === 32) {
      key = buf
      return
    }
    // keyfile 损坏只能重新生成：旧密文解不开，会按"凭据缺失"提示用户重填
    console.warn('[凭据] secret.key 损坏，重新生成（旧凭据需重填一次）')
  }
  const fresh = randomBytes(32)
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(file, fresh.toString('base64'), { mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows 上 chmod 语义有限，尽力即可
  }
  key = fresh
}

export function isV2Sealed(value: string): boolean {
  return value.startsWith(PREFIX)
}

/** 加密：plain → v2:base64(nonce|tag|ct) */
export function seal(plain: string): string {
  if (!key) throw new Error('secretBox 未初始化')
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return PREFIX + Buffer.concat([nonce, cipher.getAuthTag(), ct]).toString('base64')
}

/** 解密；非 v2 或校验失败抛错（调用方按"凭据缺失"处理） */
export function open(sealed: string): string {
  if (!key) throw new Error('secretBox 未初始化')
  if (!isV2Sealed(sealed)) throw new Error('不是 v2 密文')
  const raw = Buffer.from(sealed.slice(PREFIX.length), 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
}

import { Umzug } from 'umzug'
import type { DatabaseSync } from 'node:sqlite'
import { migrations } from './migrations'

/**
 * 结构迁移的执行器（umzug）：
 * - 一条迁移一个文件，见 ./migrations；这里只管"哪些还没跑、按顺序跑、失败整体回滚"
 * - 执行记录落 `_migrations` 表（名字 + 时间），同时回写 `PRAGMA user_version` 便于排查
 * - 老库（有数据但还没有 `_migrations` 表）按 user_version 做基线：登记历史迁移为已执行，
 *   只补跑比它新的，不会把已经长好的表再动一遍
 */

const TABLE = '_migrations'

export type MigrationReport = {
  /** 这次真正执行的迁移名（空数组 = 已经是最新结构） */
  applied: string[]
  /** 迁移后的结构版本 */
  version: number
}

/** 名字前缀就是版本号：0001-xxx → 1 */
function versionOf(name: string): number {
  const hit = /^(\d{4})-/.exec(name)
  return hit ? Number(hit[1]) : 0
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined
  return Number(row?.user_version ?? 0)
}

function createStorage(db: DatabaseSync) {
  return {
    async executed(): Promise<string[]> {
      const rows = db.prepare(`SELECT name FROM ${TABLE} ORDER BY name`).all() as { name: string }[]
      return rows.map((row) => row.name)
    },
    async logMigration({ name }: { name: string }): Promise<void> {
      db.prepare(`INSERT OR REPLACE INTO ${TABLE} (name, executed_at) VALUES (?, ?)`).run(name, Date.now())
    },
    async unlogMigration({ name }: { name: string }): Promise<void> {
      db.prepare(`DELETE FROM ${TABLE} WHERE name = ?`).run(name)
    }
  }
}

/**
 * 老库基线：以前只靠 `PRAGMA user_version` 记版本，没有执行明细表。
 * 首次跑新迁移器时把它当成"到该版本为止都已执行"，避免在已经长好的库上重放建表/改名。
 */
function seedBaseline(db: DatabaseSync): number {
  const count = Number((db.prepare(`SELECT COUNT(*) AS c FROM ${TABLE}`).get() as { c: number }).c)
  const version = readUserVersion(db)
  if (count > 0 || version <= 0) return version
  const insert = db.prepare(`INSERT OR IGNORE INTO ${TABLE} (name, executed_at) VALUES (?, ?)`)
  let seeded = 0
  for (const item of migrations) {
    if (item.version > version) continue
    insert.run(item.name, Date.now())
    seeded++
  }
  console.log(`[YunCast] 迁移基线：老库 user_version=${version}，登记 ${seeded} 条历史迁移，只补跑之后的`)
  return version
}

export async function runMigrations(db: DatabaseSync): Promise<MigrationReport> {
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (name TEXT PRIMARY KEY, executed_at INTEGER NOT NULL)`)
  const storage = createStorage(db)
  let baselineVersion = 0

  // 整批迁移一个事务：任何一条抛错都整体回滚，不留半新半旧的库
  db.exec('BEGIN')
  try {
    baselineVersion = seedBaseline(db)
    const umzug = new Umzug({
      migrations: migrations.map((item) => ({
        name: item.name,
        up: async () => {
          console.log(`[YunCast] 迁移 ${item.name}`)
          item.up(db)
        }
      })),
      storage,
      logger: {
        info: () => {},
        warn: (message) => console.warn('[YunCast] 迁移警告:', message),
        error: (message) => console.error('[YunCast] 迁移失败:', message),
        debug: () => {}
      }
    })
    const applied = await umzug.up()
    const executed = await storage.executed()
    const version = executed.reduce((max, name) => Math.max(max, versionOf(name)), baselineVersion)
    db.exec(`PRAGMA user_version = ${version}`)
    db.exec('COMMIT')
    return { applied: applied.map((item) => item.name), version }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

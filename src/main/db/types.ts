import type { DatabaseSync } from 'node:sqlite'

/**
 * 一条迁移 = 一个编号 + 一次结构/数据抬升。
 * 约定：
 * - 文件名 `NNNN-短名.ts`，NNNN 就是历史 `PRAGMA user_version`（中间跳过 8/9/13，编号照旧留白）
 * - up 必须可重复执行而不报错（每个分支先 hasTable/columnsOf 再动手），但只在没记录过时会被调用
 * - 不准起事务：整批迁移由迁移器包在一个事务里，失败即整体回滚
 */
export type Migration = {
  /** 与文件名一致，迁移器的执行记录也用它 */
  name: string
  /** 顺序号：对应老的 user_version，迁移器用它回写 PRAGMA user_version */
  version: number
  up: (db: DatabaseSync) => void
}

import type { Migration } from '../types'
import { ensureColumn, hasTable } from '../helpers'

/**
 * v2 · 预制音频资产列（RenderedAudioRef JSON）。
 * 全新库此时表还没建，由建表后的 ensureColumn 兜底。
 */
export const migration: Migration = {
  name: '0002-rendered-audio',
  version: 2,
  up: (db) => {
    if (hasTable(db, 'utterances')) ensureColumn(db, 'utterances', 'rendered', 'TEXT')
  }
}

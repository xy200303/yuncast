import type { Migration } from '../types'
import { migration as programize } from './0001-programize'
import { migration as renderedAudio } from './0002-rendered-audio'
import { migration as usageTables } from './0003-usage-tables'
import { migration as renameTables } from './0004-rename-tables'
import { migration as personaColumns } from './0005-persona-columns'
import { migration as dropModelProfile } from './0006-drop-model-profile'
import { migration as programInstruction } from './0007-program-instruction'
import { migration as naming } from './0010-naming'
import { migration as personaIdPrefix } from './0011-persona-id-prefix'
import { migration as materials } from './0012-materials'
import { migration as planIntoPrograms } from './0014-plan-into-programs'
import { migration as materialContent } from './0015-material-content'

/**
 * 迁移清单（按 version 升序执行）。
 * 编号就是历史上 PRAGMA user_version 的号：8 / 9 / 13 当年直接跳过，留空不复用。
 * 新增迁移就往后加一个文件 + 这里补一行，不要改已有文件（老库已经执行过它了）。
 */
export const migrations: Migration[] = [
  programize,
  renderedAudio,
  usageTables,
  renameTables,
  personaColumns,
  dropModelProfile,
  programInstruction,
  naming,
  personaIdPrefix,
  materials,
  planIntoPrograms,
  materialContent
]

/** 最新结构版本：等于清单里最大的 version */
export const LATEST_VERSION = migrations.reduce((max, item) => Math.max(max, item.version), 0)

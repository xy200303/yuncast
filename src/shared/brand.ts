/**
 * 品牌常量：全部从 package.json 派生，单一数据源，改名只动 package.json。
 *   中文名 = build.productName
 *   英文名 = build.executableName
 */
import pkg from '../../package.json'

export const BRAND_NAME_ZH: string = pkg.build.productName
export const BRAND_NAME_EN: string = pkg.build.executableName
/** 窗口标题、关于信息等展示用全名 */
export const BRAND_DISPLAY = `${BRAND_NAME_ZH} ${BRAND_NAME_EN}`

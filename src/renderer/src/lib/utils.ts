export { cn } from 'cn'

/** 展示用：Windows 路径统一成正斜杠，同一个列表里不至于两种斜杠混着 */
export function slashPath(path: string): string {
  return path.replace(/\\/g, '/')
}

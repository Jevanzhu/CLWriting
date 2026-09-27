/** 读文件容错单源：文件缺席 / 读失败一律回空串，调用方把空串当「无此内容」处理。
 *
 *  draft-pipeline（离线草稿链）与 outline（大纲端点）两处逐字节同体——同属「读不到就当
 *  没有」这一语义，故收敛到本模块（先例 = `atomic.ts` / `text-canonical.ts` 的跨域单源）。
 *  两处调用方都已 import 本目录模块，故不新增层级边。
 *
 *  不抛不记：缺席是常态（大纲/材料为可选文件），读失败（权限、半截写）由调用方的下游
 *  判空兜住——把 IO 错误吞成空串是**有意**的，换来调用点零 try/catch。 */
import { existsSync, readFileSync } from 'node:fs'

export function readSafe(fp: string): string {
  if (!existsSync(fp)) return ''
  try {
    return readFileSync(fp, 'utf8')
  } catch {
    return ''
  }
}

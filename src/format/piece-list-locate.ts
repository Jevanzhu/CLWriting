/**
 * 章纲文件定位三口径单源。
 *
 * 同一语义此前两处实现已分叉：check/runner.ts 走三口径（同名 basename → fm 章号 →
 * 文件名数字前缀），metrics/short-index.ts 只走同名 basename——正文 4 位补零重命名 /
 * 存量 3 位章纲不同名 / 无 fm 章号的裸文件等书形下，机检清单形式检与短篇集指标对同一
 * 章可一方命中一方 miss（红点与画像口径分裂且无从察觉）。收敛到本模块，两域共用。
 *
 * 三口径：
 *  ① 同名 basename（沿用 `大纲/章纲/<与正文同名>`）；
 *  ② 目录内按 fm 章号匹配（正文改名后章纲仍按章号可寻）；
 *  ③ 文件名数字前缀匹配（无 fm 章号的裸文件兜底，覆盖 0005-标题 vs 005-标题 补零差异）。
 * 三口径都空 → missing（调用方按各自口径提示，如机检的黄项）。
 *
 * 返回 'found' 的 path 经最终 existsSync 复验（三口径的取值都可能撞 TOCTOU 瞬删；
 * 消失按 missing 如实上报，不冒险走读失败分支）。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { readChapterDir } from './chapters.js'
import { isMdFileName } from './filename.js'

export type OutlineLocate =
  | { kind: 'found'; path: string }
  /** 目录缺失或三口径皆空——调用方按「无章纲」处理。 */
  | { kind: 'missing' }
  /** 目录在盘但 readdir 失败（瞬时占用/权限/被文件占位等）——调用方自行择重：留痕后按
   *  无章纲降级，或原样上抛让失败可见（error 为原始异常）。 */
  | { kind: 'dir-unreadable'; code: string; error: unknown }

export function locateChapterOutline(bookRoot: string, chapterPath: string, chapterNo: number): OutlineLocate {
  const outlineDir = join(bookRoot, '大纲', '章纲')
  const sameName = join(outlineDir, basename(chapterPath))
  if (existsSync(sameName)) return { kind: 'found', path: sameName }
  if (!existsSync(outlineDir)) return { kind: 'missing' }

  // ② 命中即定夺（不再落 ③）——fm 命中的路径若已瞬删，按 missing 上报而非改走前缀口径
  const byFm = readChapterDir(outlineDir).chapters.find((o) => o.章号 === chapterNo && o._path)
  if (byFm?._path) {
    return existsSync(byFm._path) ? { kind: 'found', path: byFm._path } : { kind: 'missing' }
  }

  const prefixMatch = (f: string): boolean => {
    const m = /^(\d+)[^\d]/.exec(f)
    return isMdFileName(f) && m !== null && Number(m[1]) === chapterNo // .MD 章纲不漏配
  }
  let byName: string | undefined
  try {
    byName = readdirSync(outlineDir).find(prefixMatch)
  } catch (e) {
    return { kind: 'dir-unreadable', code: (e as NodeJS.ErrnoException).code ?? 'UNKNOWN', error: e }
  }
  if (!byName) return { kind: 'missing' }
  const path = join(outlineDir, byName)
  return existsSync(path) ? { kind: 'found', path } : { kind: 'missing' }
}

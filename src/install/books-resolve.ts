/**
 * 工作目录定位 + 书仓库判定 —— 依据 M5 #32（第 4 节）。
 *
 * R0916-5e（2026-09-16，⑤④产品拆分波1）：自 install/books.ts 缝 B 纯移动拆出——
 * findWorkDir / isBookRepo 原样随迁（注释随代码走，零行为变化）；books.ts 逐名
 * re-export 桥接，既有消费方 import 面不动。残核（books.jsonl 登记读写 + 锁 +
 * 活动书指针）留在 books.ts。
 */

import { existsSync, statSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { CLWRITING_DIR } from './books.js'

// ── 工作目录定位（向上找 .clwriting/）──────────────

/**
 * 向上查找最近的含 .clwriting/ 的目录（工作目录定位）。
 * 找不到返回 null（当前在书仓库内或裸目录）。
 */
export function findWorkDir(startDir: string): string | null {
  let dir = resolve(startDir)
  for (;;) {
    // R71-16（总七十一轮）：existsSync 与 statSync 之间存在窗口——同步盘/并发操作下
    // .clwriting 恰在两次调用之间被移走时 statSync 裸抛 ENOENT 炸穿整个上溯（对齐
    // init.ts R62-39 同型口径）；按不存在继续上溯
    if (existsSync(join(dir, CLWRITING_DIR))) {
      try {
        if (statSync(join(dir, CLWRITING_DIR)).isDirectory()) {
          return dir
        }
      } catch {
        // 竞态消失/EACCES 等 stat 失败：视为此处没有 .clwriting，继续上溯
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null // 到根了
    dir = parent
  }
}

// ── 书仓库判定 ────────────────────────────────────

/** cwd 是书仓库：有 book.yaml（去 git：不再要求 .git——书库身份由 book.yaml 唯一判定）。 */
export function isBookRepo(dir: string): boolean {
  return existsSync(join(dir, 'book.yaml'))
}

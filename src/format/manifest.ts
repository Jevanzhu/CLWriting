/**
 * 单篇清单（清单.md）读写 —— 依据 M8 #27 第 4 节。
 *
 * 短篇账本降级为单篇清单：反转线索表（核心反转 + ≥3 铺垫点）+ 伏笔回收。
 * 范围限单篇、写完即归档；复用账本格式骨架的 ## 段标题逐行解析范式（leads.ts parseHistory）。
 * 落点：篇/<篇号>-<标题>/清单.md。
 *
 * 解析/回写纯函数在 piece-list-core.ts（零 Node 依赖，浏览器端共用）；
 * 本文件只负责文件 IO（readFileSync/atomicWriteFile）。
 *
 * 容错（对齐 #3 第 8 节）：缺段/缺字段不崩，未知段进 _raw。
 */

import { readFileSync } from 'node:fs'
import { atomicWriteFile } from '../fs/atomic.js'
import {
  parsePieceListBody,
  stringifyPieceList,
} from './piece-list-core.js'
import type { PieceList, ParseError } from './types.js'

export { emptyPieceList, parsePieceListBody, stringifyPieceList } from './piece-list-core.js'

/** 读取清单.md → PieceList（容错：文件不存在/空 → 默认空清单） */
export function readPieceList(
  filePath: string,
): { ok: true; list: PieceList } | { ok: false; error: ParseError } {
  let content: string
  try {
    // 清单.md 无 front matter，全文即正文
    content = readFileSync(filePath, 'utf-8')
  } catch {
    return { ok: false, error: { file: filePath, line: 0, message: '无法读取清单文件' } }
  }
  const list = parsePieceListBody(content)
  list._path = filePath
  return { ok: true, list }
}

/** 写入清单.md */
export function writePieceList(filePath: string, list: PieceList): void {
  atomicWriteFile(filePath, stringifyPieceList(list))
}

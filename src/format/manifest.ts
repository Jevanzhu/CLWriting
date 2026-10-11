/**
 * 单章章纲（章纲.md）读写 —— 依据 #27 第 4 节。
 *
 * 短篇账本降级为单章章纲：反转线索表（核心反转 + ≥3 铺垫点）+ 伏笔回收。
 * 范围限单章、写完即归档；复用账本格式骨架的 ## 段标题逐行解析范式（leads.ts parseHistory）。
 * 落点：大纲/章纲/<章号>-<标题>.md。
 *
 * 解析/回写纯函数在 piece-list-core.ts（零 Node 依赖，浏览器端共用）；
 * 本文件只负责读取（readFileSync）——写路径（全量重生成）未接线，见 writePieceList。
 *
 * 注意：与 document/manifest.ts **同名不同物**（新人易误判重复）——那是
 *  `项目/文档清单.jsonl`（文档清单：id/path/定稿基线条目）的读写主人；本文件管
 *  单章章纲.md（章纲清单）的内容，无清单条目概念。两模块勿合并、勿互引。
 *
 * 容错（对齐 #3 第 8 节）：缺段/缺字段不崩，未知段进 _raw。
 */

import { readFileSync } from 'node:fs'
import { parsePieceListBody } from './piece-list-core.js'
import type { PieceList, ParseError } from './types.js'

export { emptyPieceList, parsePieceListBody, stringifyPieceList } from './piece-list-core.js'

/** 读取章纲.md → PieceList（容错：文件不存在/空 → 默认空章纲） */
export function readPieceList(filePath: string): { ok: true; list: PieceList } | { ok: false; error: ParseError } {
  let content: string
  try {
    // 章纲.md 无 front matter，全文即正文
    content = readFileSync(filePath, 'utf-8')
  } catch {
    return { ok: false, error: { file: filePath, line: 0, message: '无法读取章纲文件' } }
  }
  const list = parsePieceListBody(content)
  list._path = filePath
  return { ok: true, list }
}

/** 写入章纲.md —— 抛错占位（未接线）。
 * 约束：本函数是全量重生成写路径（stringifyPieceList）——只保三段结构，作者手写的
 *  补遗段/注释会被静默清掉（piece-list-core 头注的「未知段保形由上层文本级补丁路径
 *  负责」尚未落地）。保留签名但拒绝执行，防新链路误接：接线前须先落地补丁式写路径
 *  （保注释保未知段，如 config/migrate-defaults 的补丁式写回），否则一次保存即吞作者
 *  手写内容。测试造盘请用 test/helpers/piece-list.ts 的夹具入口。 */
export function writePieceList(_filePath: string, _list: PieceList): void {
  throw new Error(
    'writePieceList 未接线（章纲全量重生成写路径）：该实现不保未知段——作者手写补遗/注释会被静默清掉，' +
      '接线前须先落地补丁式写路径（保注释保未知段）',
  )
}

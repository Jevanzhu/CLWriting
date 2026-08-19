/**
 * 大内容外置 spill 低配（批次 B3 / DSH-2 直抄思想；介质拍板：工作区目录 + 事件只记 locator）。
 *
 * 语义（dsh spill-policy）：
 * - 超阈值的纯文本落盘（工作区/spills/<内容哈希16>.md，幂等——同内容同名），
 *   模型侧换「头尾预算内预览 + 通知行（省略量 + locator + 取回指引）」；
 * - 预算预留：通知行先计价，超预算先砍头段再砍尾段，保证预览绝不超 maxInlineChars；
 * - best-effort：存盘失败保留原文（绝不把成功调用变失败/变空）；
 * - read 防环：本模块只用于 prompt 上下文组装（buildChatContext），不套在 read_chapter
 *   工具结果上——模型取回的全文不再二次外置，read→spill→read 环不存在。
 *
 * 事件侧（spill/ref locator 记账）属 F1-P2/P3 事件族收敛，此处只做 fs 层。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
import { isWithinRoot } from '../fs/safe-path.js'

export interface SpillThresholds {
  /** 超过该 code point 数才外置（≤ 则原文透传） */
  maxInlineChars: number
  /** 头部保留 code point 数（预算内） */
  headChars: number
  /** 尾部保留 code point 数（预算内） */
  tailChars: number
}

export interface SpillOutcome {
  /** 模型侧看到的内容（原文 或 头尾预览+通知行） */
  preview: string
  /** 全文落盘位置（书库内相对路径；未触发/落盘失败时缺省） */
  locator?: string
}

/** 落盘回调：返回 locator（相对路径）；失败返回 null（best-effort） */
export type SpillWriter = (fullText: string) => string | null

/** 落盘到 工作区/spills/<sha256 前 16>.md（内容寻址幂等；目录不存在自动建） */
export function writeSpillFile(bookRoot: string, text: string): string | null {
  try {
    const hash = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
    const dir = join(bookRoot, '工作区', 'spills')
    // kk-P2-5：原子写（临时文件 + rename）——中断不留半截 spill 文件，取回侧读不到截断内容
    atomicWriteFile(join(dir, `${hash}.md`), text)
    return `工作区/spills/${hash}.md`
  } catch {
    return null
  }
}

/** spill locator 白名单：内容寻址命名（16 位 hex）——严于通用路径校验，路径穿越/任意读天然拒 */
const SPILL_LOCATOR_RE = /^工作区\/spills\/[0-9a-f]{16}\.md$/

/**
 * GG-P2-2 读侧：按 locator 取回 spill 全文（apply_spill 落盘通道共用）。
 * locator 必须严格匹配内容寻址命名（writeSpillFile 的产物形态）+ isWithinRoot 双保险；
 * 文件不存在/校验不过/读盘失败 → null（调用方按「spill 不存在」语义回应）。
 */
export function readSpillFile(bookRoot: string, locator: string): string | null {
  if (!SPILL_LOCATOR_RE.test(locator)) return null
  const abs = join(bookRoot, locator)
  if (!isWithinRoot(bookRoot, abs)) return null
  try {
    if (!existsSync(abs)) return null
    return readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

/** 通知行（省略量 + locator + 取回指引；readTool 名由调用方给，如 read_chapter） */
function makeNote(omitted: number, locator: string, readTool: string): string {
  return `\n\n（约 ${omitted} 字已省略。全文已存储：${locator}。需要完整内容时调用 ${readTool} 工具取回。）\n\n`
}

/**
 * 超阈值则外置并返回头尾预览；否则原文透传。
 * 预算纪律：头 + 通知行 + 尾 ≤ maxInlineChars（超预算先砍头再砍尾；砍到 0 仍不
 * 满足说明 maxInlineChars 连通知行都装不下——配置错误，best-effort 回退原文）。
 */
export function spillIfLarge(
  text: string,
  thresholds: SpillThresholds,
  writeSpill: SpillWriter,
  readTool = 'read_chapter',
): SpillOutcome {
  const chars = Array.from(text)
  const total = chars.length
  if (total <= thresholds.maxInlineChars) return { preview: text }

  const locator = writeSpill(text)
  if (locator === null) return { preview: text }

  let head = Math.min(thresholds.headChars, total)
  let tail = Math.min(thresholds.tailChars, Math.max(0, total - head))
  let note = makeNote(total - head - tail, locator, readTool)
  // 预算预留循环：通知行随省略量微变，砍头砍尾后重定价直到装得下（floor 保证收敛）
  while (head + tail + Array.from(note).length > thresholds.maxInlineChars) {
    if (head > 0) head = Math.floor(head * 0.8)
    else if (tail > 0) tail = Math.floor(tail * 0.8)
    else return { preview: text } // 连通知行都装不下：配置错误，回退原文
    note = makeNote(total - head - tail, locator, readTool)
  }
  return {
    preview: chars.slice(0, head).join('') + note + chars.slice(total - tail).join(''),
    locator,
  }
}

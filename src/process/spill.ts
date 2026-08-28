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
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
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

/** 落盘到 工作区/spills/<sha256 前 16>.md（内容寻址幂等；目录不存在自动建）。
 *  M-3（第十轮）：meta 随写随落同名 sidecar（<hash>.meta.json）——apply 侧凭它校验
 *  spill 归属章号与基线新鲜度，防「转述错章号整章覆写」与「改写后被编辑仍静默覆盖」。
 *  正文文件保持纯文本不变（内容寻址与模型直读语义不动）；sidecar 写失败随整次写入
 *  失败返回 null（无 meta 的 spill 在 apply 侧一律拒绝，不留半保障状态）。 */
export interface SpillMeta {
  /** 产出语义（当前仅 rewrite 改写稿；chat 上下文 spill 不带 meta） */
  kind: 'rewrite'
  /** 改写目标章号 */
  chapter: number
  /** 改写时章正文 sha256（hex）——apply 前校验正文未被编辑（新鲜度） */
  baseSha: string
}

export function writeSpillFile(bookRoot: string, text: string, meta?: SpillMeta): string | null {
  try {
    // A6（五十九轮）：locator 哈希并入 meta（章号+基线 sha）——改写 spill 原纯内容寻址，
    // 两次改写产出相同正文（如同一基线重复改写命中缓存/模型复读）时第二次会顶替同名
    // sidecar meta，先前确认通道凭空失效（apply_spill fail-closed 拒绝，形成无效工具往返）。
    // 并入章号+基线后不同基线的同文 spill 各得独立 locator，meta 不再互覆；读侧
    // （readSpillFile/readSpillMeta）按 locator 直读文件与 sidecar，不重算哈希，天然兼容。
    // 无 meta（chat 上下文外置）保持纯内容寻址口径不变
    const hash = createHash('sha256').update(text, 'utf8')
    if (meta) hash.update(`\n---spill-meta---\n${meta.chapter}\n${meta.baseSha}`, 'utf8')
    const digest = hash.digest('hex').slice(0, 16)
    const dir = join(bookRoot, '工作区', 'spills')
    // kk-P2-5：原子写（临时文件 + rename）——中断不留半截 spill 文件，取回侧读不到截断内容
    atomicWriteFile(join(dir, `${digest}.md`), text)
    if (meta) atomicWriteFile(join(dir, `${digest}.meta.json`), JSON.stringify(meta))
    // L-P8（第八轮）：顺带清理 30 天前的旧 spill——内容寻址幂等但此前无 GC，长跑书库
    // 无限增长；清理失败不影响本次写入（best-effort）
    pruneOldSpills(dir)
    return `工作区/spills/${digest}.md`
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

/** M-3（第十轮）：读 spill 溯源 sidecar。locator 同款白名单；不存在/形状不符 → null
 *  （apply 侧按「无溯源」拒绝，chat 上下文 spill 与手写文件天然走不进确认通道）。 */
export function readSpillMeta(bookRoot: string, locator: string): SpillMeta | null {
  if (!SPILL_LOCATOR_RE.test(locator)) return null
  const abs = join(bookRoot, locator.replace(/\.md$/, '.meta.json'))
  if (!isWithinRoot(bookRoot, abs)) return null
  try {
    const obj = JSON.parse(readFileSync(abs, 'utf-8')) as Record<string, unknown>
    if (obj.kind !== 'rewrite') return null
    const chapter = Number(obj.chapter)
    const baseSha = String(obj.baseSha ?? '')
    if (!Number.isInteger(chapter) || chapter < 1 || !/^[0-9a-f]{64}$/.test(baseSha)) return null
    return { kind: 'rewrite', chapter, baseSha }
  } catch {
    return null
  }
}

/** 通知行（省略量 + locator + 取回指引；readTool 名由调用方给，如 read_chapter） */
function makeNote(omitted: number, locator: string, readTool: string): string {
  return `\n\n（约 ${omitted} 字已省略。全文已存储：${locator}。需要完整内容时调用 ${readTool} 工具取回。）\n\n`
}

/** R73-43（二十一轮）：正文预览最小预算（code points）——低于它继续砍头砍尾只会产出
 *  「只剩通知行」的 preview（模型侧失去任何正文线索，工具取回指引失去上下文）。生产
 *  配置（chat 上下文 2000/1200/400）下头尾合计远高于此值，不触发。 */
const MIN_BODY_PREVIEW_CHARS = 200

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
    // R73-43：正文保底——头尾合计已被砍到最小正文预算（且原文比它长）时不再砍，
    // 按「配置错误」同型兜底回退原文，绝不产出只剩通知行的 preview
    if (head + tail <= Math.min(total, MIN_BODY_PREVIEW_CHARS)) return { preview: text }
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

/** L-P8（第八轮）：删除超过 30 天未再写入的 spill 产物（best-effort，失败静默）。
 *  R62-38：判据用 mtime（最后写入时间），注释如实——atime 语义在只读/备份/
 *  缓存读场景不可靠，不漏清正在取回的 spill；apply 链另有 baseSha 兜底防误删。
 *  M-3：.meta.json sidecar 同 TTL 一并清（含孤儿 sidecar）。 */
const SPILL_TTL_MS = 30 * 24 * 60 * 60 * 1000
function pruneOldSpills(dir: string): void {
  try {
    const now = Date.now()
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md') && !name.endsWith('.meta.json')) continue
      const fp = join(dir, name)
      try {
        if (now - statSync(fp).mtimeMs > SPILL_TTL_MS) rmSync(fp, { force: true })
      } catch {
        /* 单个失败跳过 */
      }
    }
  } catch {
    /* 目录不存在/不可读 → 无可清理 */
  }
}

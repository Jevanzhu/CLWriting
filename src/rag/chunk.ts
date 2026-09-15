/**
 * RAG 分块（缝 A）—— R0916-5f（2026-09-16，⑤④产品拆分波2）自 rag/index.ts 纯移动
 * 拆出：TextChunk / MAX_CHUNK_CHARS / SENTENCE_ENDERS / chunkBody / pushSegmentChunks /
 * subdivideSegment / isHighSurrogate 原样随迁（零行为变化，历史注释原样随代码迁移）。
 * 纯函数零依赖；RAG 域总述头注与召回残核在 rag/index.ts（残核 re-export 本文件
 * chunkBody/TextChunk，消费方 import 面零改动）。
 */

/** 一个分块（文本 + 在该章正文的偏移） */
export interface TextChunk {
  text: string
  start: number
  end: number
}

/**
 * 单块长度上限（字符，按 trim 后文本计）。
 * 量级对齐现有段落粒度（网文段落常见数十~数百字，正常段落永不触发），只拦
 * 病理超长段（整章无空行连续长文）：不设上限时单块可达数万字，一次撑爆
 * embedding 输入 token 限制、召回粒度也失去意义。取 1000：约 1k~1.5k token，
 * 对 8k token 级模型（如 text-embedding-3-small）留足余量。
 */
const MAX_CHUNK_CHARS = 1000

/** 句读切点：超长段行内再分时优先在句末断开（标点留在句尾） */
const SENTENCE_ENDERS = new Set(['。', '！', '？', '；', '…', '」', '』'])

/**
 * 按段落/双空行分块，记偏移（#37 第 4 节，粒度默认值待 beta 校准）。
 * 超过 MAX_CHUNK_CHARS 的段在现有切分逻辑内再细分（行边界 → 句读 → 硬切），
 * 子块偏移仍指原文，对外类型不变。
 */
export function chunkBody(body: string): TextChunk[] {
  const chunks: TextChunk[] = []
  // 按双空行（段落/场景）分割，保留偏移
  const re = /\n\s*\n+/g
  let lastEnd = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    pushSegmentChunks(body, lastEnd, m.index, chunks)
    lastEnd = re.lastIndex
  }
  // 末尾段
  pushSegmentChunks(body, lastEnd, body.length, chunks)
  return chunks
}

/** 一个段（双空行之间）入块：不超上限整段一块，超上限细分（子块同走 ≥20 过滤）。 */
function pushSegmentChunks(body: string, segStart: number, segEnd: number, out: TextChunk[]): void {
  const seg = body.slice(segStart, segEnd)
  if (seg.trim().length < 20) return
  if (seg.trim().length <= MAX_CHUNK_CHARS) {
    // A4（五十九轮）：offset 按 trim 后文本重定位——text 是 trim 后文本而 start/end 原先
    // 指向未 trim 区间，召回→精准读取契约两头不对齐（首尾空白计入 offset 精度损耗）
    const lead = seg.length - seg.trimStart().length
    const trail = seg.length - seg.trimEnd().length
    out.push({ text: seg.trim(), start: segStart + lead, end: segEnd - trail })
    return
  }
  for (const [s, e] of subdivideSegment(seg, MAX_CHUNK_CHARS)) {
    const piece = seg.slice(s, e)
    const text = piece.trim()
    if (text.length >= 20) {
      // A4（五十九轮）：子块同口径——start/end 收缩到 trim 后文本的实际区间
      const lead = piece.length - piece.trimStart().length
      const trail = piece.length - piece.trimEnd().length
      out.push({ text, start: segStart + s + lead, end: segStart + e - trail })
    }
  }
}

/**
 * 超长段细分：贪心收集子段使每段 ≤ max 字符。切点优先级——换行/句读（取窗口内
 * 最后一个，标点留在句尾）→ 硬切（窗口内无任何边界时）。返回子段在段内的 [start, end)。
 */
function subdivideSegment(seg: string, max: number): Array<[number, number]> {
  const pieces: Array<[number, number]> = []
  let pieceStart = 0
  while (pieceStart < seg.length) {
    // 剩余整段已 ≤ max → 直接收尾
    if (seg.length - pieceStart <= max) {
      pieces.push([pieceStart, seg.length])
      break
    }
    // 窗口 (pieceStart, pieceStart+max] 内找最大切点（前一字符是换行或句读）
    let boundary = -1
    for (let i = pieceStart + 1; i <= pieceStart + max; i++) {
      const prev = seg[i - 1]!
      if (prev === '\n' || SENTENCE_ENDERS.has(prev)) boundary = i
    }
    let cut = boundary > pieceStart ? boundary : pieceStart + max
    // 硬切防劈开代理对（emoji 等增补平面字符占 2 个 UTF-16 码元）
    if (isHighSurrogate(seg.charCodeAt(cut - 1))) cut--
    if (cut <= pieceStart) cut = pieceStart + 1 // 极小 max 兜底，防死循环
    pieces.push([pieceStart, cut])
    pieceStart = cut
  }
  return pieces
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

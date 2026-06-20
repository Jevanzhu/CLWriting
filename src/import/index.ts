/**
 * 轻量导入 —— 依据 M7 #36 spec。
 *
 * 把 v0.2 正文导入 v1 书仓库：复用 scaffold 建书 + 落定稿正文。
 * 统一导入入口 + length-routing 分流（长篇走本模块，短篇走 M8）。
 *
 * 复用边界（#36 第 3.2/5 节）：
 * - 建书复用 scaffoldBookRepo（M5 #30 同款 6.2 目录 + git + 文风铁律 + AGENTS.md）
 * - 落正文复用 writeChapter
 * - 登记复用 appendBook/writeActive
 *
 * 红线：短篇分流 M8；v0.2 无 v1 机检元数据 → 钩子/情绪填占位默认 + 诚实标注，不伪装。
 */

import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { writeChapter } from '../format/chapters.js'
import { writePiece } from '../format/pieces.js'
import { writePieceList, emptyPieceList } from '../format/manifest.js'
import { scaffoldBookRepo } from '../install/scaffold.js'
import { appendBook, writeActive, readBooks } from '../install/books.js'
import { addCommit } from '../git/exec.js'
import type { ChapterMeta, PieceMeta } from '../format/types.js'

export interface ImportOptions {
  /** v0.2 正文路径（文件） */
  sourcePath: string
  /** 工作目录（必填，由 CLI 层传入，逻辑层不碰 process.cwd） */
  workDir: string
  /** 书名（可选，从文件名推导） */
  name?: string
  /** 长短篇（可选，由 length-routing 判定） */
  kind?: 'long' | 'short'
  /** 题材（可选，驱动 leads） */
  genre?: string
}

export interface ImportResult {
  ok: boolean
  bookRoot?: string
  bookName?: string
  chapterCount?: number
  kind?: 'long' | 'short'
  error?: string
}

/** v0.2 章节解析结果 */
interface V02Chapter {
  章号: number
  标题: string
  body: string
}

/** length-routing 判定（#36 第 3.1 节 + #29 第 2 节冲突回退）。
 *  优先级：--kind 声明 > 章节数≥5（长）> 字数≥30000（长）。
 *  冲突回退（#29 优先级 3）：章节数<5 倾向短、但字数≥30000 倾向长 → 信号矛盾，请作者 --kind 拍板。
 *  （注：「章节数≥5 但字数少」不算冲突——章节数≥5 已明确判长篇。） */
function determineKindWithConflict(
  chapters: V02Chapter[],
  declared?: 'long' | 'short',
): { kind: 'long' | 'short'; conflict: boolean; totalWords: number } {
  const totalWords = chapters.reduce((sum, ch) => sum + ch.body.length, 0)
  if (declared) return { kind: declared, conflict: false, totalWords }

  // 章节数≥5 → 明确长篇（不论字数）
  if (chapters.length >= 5) return { kind: 'long', conflict: false, totalWords }

  // 章节数<5：字数≥30000 倾向长、<30000 倾向短
  // 冲突仅在「章节<5 且 字数≥30000」时发生（章节信号短、字数信号长）
  if (totalWords >= 30000) {
    return { kind: 'short', conflict: true, totalWords }
  }
  return { kind: 'short', conflict: false, totalWords }
}

/**
 * 解析 v0.2 正文为章列表。
 *
 * 支持两种常见分隔：
 * 1. 「第N章：标题」/「第N章 标题」标记（N 为阿拉伯数字）
 * 2. 退化为按多空行/分隔符切块（无章节标记时）
 *
 * v0.2 是自有项目，格式已知；若实际格式有差异需在此调整。
 */
function parseV02Content(content: string): V02Chapter[] {
  const chapters: V02Chapter[] = []

  // 尝试按「第N章」标记分隔（兼容 ：空格：无分隔符）
  const pattern = /第(\d+)章\s*[：:、]?\s*(.*)/g
  const matches = [...content.matchAll(pattern)]

  if (matches.length > 0) {
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i]!
      const 章号 = Number(m[1])
      const 标题 = (m[2] ?? '').trim() || `第${章号}章`
      const start = m.index! + m[0].length
      const end = i < matches.length - 1 ? matches[i + 1]!.index : content.length
      const body = content.slice(start, end).trim()
      if (body.length > 0) chapters.push({ 章号, 标题, body })
    }
    return chapters
  }

  // 退化为按分隔符切块
  const parts = content.split(/\n---+\n|\n{3,}/)
  parts.forEach((part, idx) => {
    const trimmed = part.trim()
    if (trimmed.length > 50) {
      const firstLine = trimmed.split('\n')[0]!.trim()
      chapters.push({
        章号: idx + 1,
        标题: firstLine.slice(0, 20),
        body: trimmed,
      })
    }
  })
  return chapters
}

/**
 * 导入 v0.2 正文主流程。
 */
export function importV02Book(options: ImportOptions): ImportResult {
  const { sourcePath, workDir, kind: declaredKind, genre, name: nameOpt } = options

  // 1. 读取源文件
  if (!existsSync(sourcePath)) {
    return { ok: false, error: `文件不存在：${sourcePath}` }
  }
  let content: string
  try {
    content = readFileSync(sourcePath, 'utf-8')
  } catch (e) {
    return { ok: false, error: `读取失败：${e instanceof Error ? e.message : String(e)}` }
  }

  // 2. 解析章节
  const chapters = parseV02Content(content)
  if (chapters.length === 0) {
    return { ok: false, error: '未解析到有效章节（请检查 v0.2 格式）' }
  }

  // 3. length-routing 判定（含冲突回退）
  const routing = determineKindWithConflict(chapters, declaredKind)
  if (routing.conflict) {
    return {
      ok: false,
      error: `长短信号冲突：解析出 ${chapters.length} 篇/章、总字数 ${routing.totalWords}。请用 --kind long|short 拍板（章节<5 倾向短、字数≥30000 倾向长）`,
    }
  }
  const kind = routing.kind

  // 4. 推导书名
  const bookName = nameOpt || basename(sourcePath, '.md') || (kind === 'short' ? '导入短篇集' : '导入书籍')

  // 5. 同名冲突检查
  const existing = readBooks(workDir)
  if (existing.some((b) => b.name === bookName)) {
    return { ok: false, error: `已有一本叫「${bookName}」的书，换个名字或先删掉旧的` }
  }

  // 6. 复用 scaffoldBookRepo 建书（按 kind 建长篇 6.2 目录 / 短篇集 篇/ 布局 + git + 文风铁律 + AGENTS.md + init commit）
  const bookRoot = join(workDir, bookName)
  if (existsSync(bookRoot)) {
    return { ok: false, error: `目录「${bookName}」已存在` }
  }
  scaffoldBookRepo(bookRoot, { name: bookName, genre: genre ?? '', leadsEnabled: [], kind })

  // 7. 落正文（按 kind 分支落点）
  if (kind === 'short') {
    // 短篇集：每篇 → 篇/<篇号3位>-<标题>/正文.md（#29 第 4 节）；清单.md 留空占位（不臆造反转线索，吸收点 7.5）
    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i]!
      const 篇号 = i + 1
      const pieceDir = join(bookRoot, '篇', `${String(篇号).padStart(3, '0')}-${ch.标题}`)
      mkdirSync(pieceDir, { recursive: true })
      const piece: PieceMeta = {
        篇号,
        标题: ch.标题,
        // 外部短篇无 v1 目标情绪/核心反转 → 占位 + 诚实标注，不伪装（#29 第 4 节）
        _raw: { 导入: '待标注' },
      }
      writePiece(join(pieceDir, '正文.md'), piece, ch.body)
      writePieceList(join(pieceDir, '清单.md'), emptyPieceList())
    }
  } else {
    // 长篇：定稿/正文/<章号>-<标题>.md（行为逐字节不变，#36）
    for (const ch of chapters) {
      const meta: ChapterMeta = {
        章号: ch.章号,
        标题: ch.标题,
        钩子类型: '悬念钩',
        钩子强弱: '中',
        情绪定位: '铺垫',
        _path: '',
        _wordCount: ch.body.length,
        _raw: { 导入: '待标注' },
      }
      writeChapter(join(bookRoot, '定稿', '正文', `${ch.章号}-${ch.标题}.md`), meta, ch.body)
    }
  }

  // 8. 正文 commit（scaffoldBookRepo 已留 init commit 作为 HEAD）
  const unit = kind === 'short' ? '篇' : '章'
  const commit = addCommit(bookRoot, `import: 导入 ${chapters.length} ${unit}`)
  if (!commit.ok) return { ok: false, error: commit.humanMsg }

  // 9. 登记 + 设活动书（复用 M5 范式）
  const appendRes = appendBook(workDir, { name: bookName, path: bookName, kind, created_at: new Date().toISOString() })
  if (!appendRes.ok) return { ok: false, error: appendRes.reason }
  writeActive(workDir, bookName)

  return { ok: true, bookRoot, bookName, chapterCount: chapters.length, kind }
}

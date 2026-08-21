/**
 * `clwriting init` 逻辑层 —— 依据 M5 #30（GUI 建书入口，CLI 退场后仅剩此消费）。
 *
 * 装工作目录（非 git）+ 建第一本书（去 git 自管版本的书仓库）→ 登记 books.jsonl。
 * 角色壳 / templates 角色源 / .clwriting/dist 随 CLI 退场不再生成。
 *
 * 幂等：工作目录骨架已存在则复用；同名书已登记则报冲突不覆盖。
 */

import { existsSync, mkdirSync, readdirSync, type Dirent } from 'node:fs'
import { join, resolve } from 'node:path'
import { matchGenreLeads } from './data.js'
import { appendBook, writeActive, readBooks, bookStoragePath, isInvalidBookName } from './books.js'
import { scaffoldBookRepo, findGitAncestor } from './scaffold.js'
import type { LeadType } from '../format/types.js'

export interface InitOptions {
  /** 工作目录（cwd 或显式指定）；init 在此建书 */
  workDir: string
  /** 书名（必填，交互或 --name） */
  name: string
  /** 题材（可选，驱动 leads 推荐） */
  genre?: string
  /** 扩展账本类（--leads 直接指定；否则按题材推荐） */
  leads?: readonly string[]
  /** 长篇/短篇（默认 long；short 细节归 M8） */
  kind?: 'long' | 'short'
  /** AI 宿主（决策 12/22，默认 cc；首版只 cc） */
  host?: 'cc' | 'codex'
  /** 全书目标字数（决策 14，落 book.yaml target_words） */
  targetWords?: number
  /** 简介（GUI 新增 5.1，落 简介.md） */
  brief?: string
}

export type InitResult =
  | { ok: true; workDir: string; bookRoot: string; bookName: string; bookPath: string }
  | { ok: false; reason: string }

const CLWRITING_DIR = '.clwriting'

/**
 * init 主流程（#30 第 5 节 9 步，CLI 退场后收敛为：骨架 + scaffold + 登记）。
 * 非交互：调用方已收集 name/genre/leads；交互式逃生由 CLI 层处理（本函数纯逻辑）。
 */
export function doInit(opts: InitOptions): InitResult {
  const workDir = resolve(opts.workDir)
  const bookName = opts.name
  if (!bookName) return { ok: false, reason: '书名不能为空' }
  // P2-27：逻辑层补书名校验（与 server 建书同口径）——书名直接用作目录名，防 `../` 越出 workDir
  if (isInvalidBookName(bookName)) {
    return { ok: false, reason: '书名不能包含路径分隔符或特殊路径段（/ \\ . ..）' }
  }

  const kind = opts.kind ?? 'long'
  const bookPath = bookStoragePath(bookName, kind)
  const bookRoot = join(workDir, bookPath)

  const gitAncestor = findGitAncestor(workDir)
  if (gitAncestor) {
    return { ok: false, reason: `工作目录不能放在 git 仓库里：${gitAncestor}。请换一个非 git 目录再 init。` }
  }

  // 幂等检查：同名书已登记或目录已存在 → 拒绝覆盖。
  // 低级项（第六轮）：目录存在但「未登记 + 有骨架 + 正文零 .md」判为上次 init 在
  // scaffold 与登记之间崩掉的半成品——复跑幂等 scaffold（覆盖自身占位）续走登记，
  // 不再把用户卡死在「换个书名或先清空它」。
  const existingBooks = readBooks(workDir)
  const registered = existingBooks.some((b) => b.name === bookName)
  if (existsSync(bookRoot) && readdirSync(bookRoot).length > 0) {
    if (registered || !isResumableHalfScaffold(bookRoot)) {
      return { ok: false, reason: `目录「${bookName}」已存在且非空，换个书名或先清空它` }
    }
    // 半成品 → 落到下方 scaffold 复跑（幂等覆盖自身占位，正文零文件无用户内容可损失）
  }
  if (registered) {
    return { ok: false, reason: `已有一本叫「${bookName}」的书` }
  }

  // 确定扩展账本类（显式 > 题材推荐 > 空）。短篇集无长程账本（降级单篇清单 #27），恒空
  const leadsEnabled: LeadType[] = kind === 'short'
    ? []
    : opts.leads
      ? sanitizeToExtendedLeads(opts.leads)
      : opts.genre
        ? matchGenreLeads(opts.genre)
        : []

  // 步骤 5：工作目录骨架（非 git，幂等复用）
  scaffoldWorkDir(workDir)

  // 步骤 6：书仓库 scaffold（book.yaml + 6.2 目录 + 文风占位 + 初始 manifest——去 git，见 scaffold.ts）
  scaffoldBookRepo(bookRoot, { name: bookName, genre: opts.genre ?? '', leadsEnabled, kind, host: opts.host, targetWords: opts.targetWords, brief: opts.brief })

  // 步骤 8：登记 books.jsonl + 设活动书
  const appendRes = appendBook(workDir, {
    name: bookName,
    path: bookPath,
    kind,
    created_at: new Date().toISOString(),
  })
  if (!appendRes.ok) return appendRes
  writeActive(workDir, bookName)

  return { ok: true, workDir, bookRoot, bookName, bookPath }
}

/** 步骤 5：工作目录骨架（非 git，幂等——已存在则复用）。 */
function scaffoldWorkDir(workDir: string): void {
  mkdirSync(join(workDir, CLWRITING_DIR), { recursive: true })
}

/**
 * 低级项（第六轮）：半成品 scaffold 判定。
 * 判据：有 book.yaml（我们的骨架签名，区分用户自建目录）且 写作/正文 下零 .md
 * （正文是唯一不可再生区——零文件即无用户内容可损失；骨架其余占位均幂等可重建）。
 */
function isResumableHalfScaffold(bookRoot: string): boolean {
  if (!existsSync(join(bookRoot, 'book.yaml'))) return false
  return countMarkdownFiles(join(bookRoot, '写作', '正文')) === 0
}

function countMarkdownFiles(dir: string): number {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0 // 目录不存在（崩得更早）→ 按零文件计
  }
  let n = 0
  for (const e of entries) {
    if (e.isDirectory()) n += countMarkdownFiles(join(dir, e.name))
    else if (e.name.endsWith('.md')) n += 1
  }
  return n
}

/** 把字符串数组收敛为合法扩展账本类（剔除基础类/未知类/去重）。 */
function sanitizeToExtendedLeads(raw: readonly string[]): LeadType[] {
  const extended = new Set<LeadType>(['布局线', '设定线', '成长线', '关系线'])
  const seen = new Set<LeadType>()
  const out: LeadType[] = []
  for (const r of raw) {
    const t = r as LeadType
    if (extended.has(t) && !seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return out
}
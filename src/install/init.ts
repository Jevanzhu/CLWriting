/**
 * `clwriting init` 逻辑层 —— 依据 M5 #30（GUI 建书入口，CLI 退场后仅剩此消费）。
 *
 * 装工作目录（非 git）+ 建第一本书（去 git 自管版本的书仓库）→ 登记 books.jsonl。
 * 角色壳 / templates 角色源 / .clwriting/dist 随 CLI 退场不再生成。
 *
 * 幂等：工作目录骨架已存在则复用；同名书已登记则报冲突不覆盖。
 */

import { existsSync, mkdirSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { join, resolve } from 'node:path'
import { matchGenreLeads } from './data.js'
import { appendBook, appendBookAsync, writeActive, readBooks, bookStoragePath, isInvalidBookName, BOOK_NAME_MAX_BYTES } from './books.js'
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

/** 登记前步骤的结果：失败带人话 reason；可登记则带注册/回显所需的全部字段。 */
type InitStepOutcome =
  | { ok: false; reason: string; ready?: false }
  | {
      ready: true
      workDir: string
      bookRoot: string
      bookName: string
      bookPath: string
      kind: 'long' | 'short'
    }

const CLWRITING_DIR = '.clwriting'

/**
 * init 主流程（#30 第 5 节 9 步，CLI 退场后收敛为：骨架 + scaffold + 登记）。
 * 非交互：调用方已收集 name/genre/leads；交互式逃生由 CLI 层处理（本函数纯逻辑）。
 *
 * R36-9/R36-26（三十六轮）：主体拆出 doInitSteps（校验/幂等/骨架/scaffold 全同步
 * 瞬时段），登记段（books.lock）收口为独立步骤——同步版 doInit 经 appendBook、
 * 异步孪生 doInitAsync 经 appendBookAsync（AcquireAsync：事件循环不阻塞）。
 * GUI 建书端点统一走 doInitAsync；本同步版保留供测试/CLI 残余合法同步面。
 */
export function doInit(opts: InitOptions): InitResult {
  const step = doInitSteps(opts)
  if (!step.ready) return step
  const appendRes = appendBook(step.workDir, {
    name: step.bookName,
    path: step.bookPath,
    kind: step.kind,
    created_at: new Date().toISOString(),
  })
  if (!appendRes.ok) return appendRes
  writeActive(step.workDir, step.bookName)
  return { ok: true, workDir: step.workDir, bookRoot: step.bookRoot, bookName: step.bookName, bookPath: step.bookPath }
}

/**
 * doInit 的异步孪生（R36-9/R36-26）——登记段（books.jsonl 读改写）走 appendBookAsync
 * （tryBooksLockAsync：setTimeout 轮询，事件循环不阻塞）。GUI 建书端点
 * （POST /api/books）承载 SSE/全部接口，此前经同步 appendBook 的 Atomics.wait
 * 在双进程争写窗口最坏停 5s（R36-26：CLI 建书同根漏网）。前置各步骤与同步版
 * 逐位同源（doInitSteps 共用，结果恒等）；仅登记锁等待异步化。失败语义不变：
 * { ok:false, reason 人话 }，永不 reject。
 */
export async function doInitAsync(opts: InitOptions): Promise<InitResult> {
  const step = doInitSteps(opts)
  if (!step.ready) return step
  const appendRes = await appendBookAsync(step.workDir, {
    name: step.bookName,
    path: step.bookPath,
    kind: step.kind,
    created_at: new Date().toISOString(),
  })
  if (!appendRes.ok) return appendRes
  writeActive(step.workDir, step.bookName)
  return { ok: true, workDir: step.workDir, bookRoot: step.bookRoot, bookName: step.bookName, bookPath: step.bookPath }
}

/** doInit/doInitAsync 共用的登记前主流程（校验/幂等/骨架/scaffold；同步瞬时段）。 */
function doInitSteps(opts: InitOptions): InitStepOutcome {
  const workDir = resolve(opts.workDir)
  // 平台规范化批（2026-09-03）：书名 NFC 归一——书名直接用作目录名（books.jsonl 的
  // name/path 同源），mac 侧输入的 NFD 形态名跨机即「找不到文件」；归一在全部校验与
  // 拼接之前，登记与目录天然一致。存量 NFD 目录由启动迁移 v4 改名归一。
  const bookName = opts.name.normalize('NFC')
  if (!bookName) return { ok: false, reason: '书名不能为空' }
  // R74-11（七十四轮批 D）：书名 UTF-8 字节上限显式校验——超长名 mkdir ENAMETOOLONG
  // 裸抛破坏 {ok:false,reason} 契约。isInvalidBookName 已收录同判据作单源防御，但其
  // 通用分支的消息不含「过长」语义；本检查须在前，给出专门人话原因（上限推导见
  // books.ts BOOK_NAME_MAX_BYTES 头注，120 字节 ≈ 40 个汉字）
  if (Buffer.byteLength(bookName, 'utf8') > BOOK_NAME_MAX_BYTES) {
    return { ok: false, reason: `书名过长（上限约 ${Math.floor(BOOK_NAME_MAX_BYTES / 3)} 个汉字），请缩短后重试` }
  }
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
  // P5-数据层（第七轮）：同名「文件」（非目录）时下方 readdirSync 裸抛 ENOTDIR 破坏
  // {ok:false,reason} 契约——先行判定给出可读原因
  // R62-39：existsSync/statSync 之间存在窗口——同步盘/并发 init 下目录恰在两次调用
  // 之间被移走/删除时 statSync 裸抛 ENOENT 破坏 {ok:false,reason} 契约，收编为显式原因
  let bookRootIsFile = false
  if (existsSync(bookRoot)) {
    try {
      bookRootIsFile = !statSync(bookRoot).isDirectory()
    } catch (e) {
      return { ok: false, reason: `路径「${bookName}」判定失败（${e instanceof Error ? e.message : String(e)}），请稍后重试` }
    }
  }
  if (bookRootIsFile) {
    return { ok: false, reason: `路径「${bookName}」被同名文件占用（不是目录），换个书名或先移走它` }
  }
  // L-D2（第八轮）：readdirSync 收编——目录存在但 EACCES（同步盘/备份恢复中的权限
  // 残留）时裸抛同样破坏 {ok:false,reason} 契约（与上方同名文件 ENOTDIR 同族）
  let existingEntries: string[] = []
  if (existsSync(bookRoot)) {
    try {
      existingEntries = readdirSync(bookRoot)
    } catch (e) {
      return { ok: false, reason: `目录「${bookName}」无法读取（${e instanceof Error ? e.message : String(e)}），请检查权限后重试` }
    }
  }
  if (existingEntries.length > 0) {
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
  // 步骤 6：书仓库 scaffold（book.yaml + 6.2 目录 + 文风占位 + 初始 manifest——去 git，见 scaffold.ts）
  // R74-11（七十四轮批 D）：mkdir 族文件系统错误收编——书名/书库深度组合超 win
  // MAX_PATH（ENAMETOOLONG）、路径段被同名文件占用（ENOTDIR）、权限（EACCES）等
  // 此前从 scaffold 裸抛穿 doInit，破坏 {ok:false,reason} 契约（调用方按 reason 人话
  // 展示，裸 throw 直接炸启动链）；统一收编为可读原因
  try {
    scaffoldWorkDir(workDir)
    scaffoldBookRepo(bookRoot, { name: bookName, genre: opts.genre ?? '', leadsEnabled, kind, host: opts.host, targetWords: opts.targetWords, brief: opts.brief })
  } catch (e) {
    return { ok: false, reason: `建书目录失败（${e instanceof Error ? e.message : String(e)}），请换更短的书名或更浅的书库位置后重试` }
  }

  // 步骤 8：登记 books.jsonl + 设活动书——由调用方（同步 doInit / 异步 doInitAsync）
  // 完成：登记段持 books.lock（R63-2），同步/异步孪生按调用面分发（R36-9/R36-26
  // 建书锁异步化：GUI 端点走 doInitAsync → appendBookAsync，事件循环不阻塞）
  return { ready: true, workDir, bookRoot, bookName, bookPath, kind }
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
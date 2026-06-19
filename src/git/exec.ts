/**
 * git 执行器 + 健康检查 —— 依据 #16 git 隐身层 spec（M3 子 spec·#16）。
 *
 * 落地母本第 0.3 节原则 3「git 隐身」+ 第 4.1 节原则 2（AI 经 CLI 动 git）：
 * - 所有 git 调用经本层统一执行，集中 try/catch + 人话收口（运行时零依赖，不引 git 库）。
 * - finalize（#13）的 commit、状态机（#15）的健康检查、回滚（#16 第 5 节）都在此之上。
 *
 * #16 第 2 节 4 异常健康检查：半提交 / 合并冲突 / 僵死锁 / 网盘副本残留。
 * 另有安全提示：书仓库配置 remote 时提醒正文外传风险，但不阻断正常写作。
 * #16 第 3 节人话映射：对作者只出网文语言，永不出 git 命令、SHA、堆栈。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

// ── 统一 git 执行器（#16 第 3 节）──────────────────

/** git 调用结果：成功带 stdout，失败带人话 */
export type GitResult =
  | { ok: true; stdout: string }
  | { ok: false; humanMsg: string; stderr?: string }

/**
 * 执行一条 git 命令（统一收口，#16 第 3 节）。
 * execFileSync 数组形式不走 shell，免注入、免转义（同 finalize 既有做法）。
 * 失败 try/catch → 人话，不把作者丢给 git 报错。
 */
export function git(args: string[], cwd: string, opts?: { encoding?: 'utf-8' }): GitResult {
  try {
    // encoding 指定 'utf-8' → execFileSync 返回 string
    const stdout = execFileSync('git', args, {
      cwd,
      stdio: 'pipe',
      encoding: opts?.encoding ?? 'utf-8',
    })
    return { ok: true, stdout }
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string }
    const stderr =
      typeof err.stderr === 'string' ? err.stderr : err.stderr ? err.stderr.toString() : undefined
    return {
      ok: false,
      humanMsg: `git 操作失败（${args.join(' ')}）：${humanizeGitError(args, stderr)}`,
      stderr,
    }
  }
}

/** 把 git 原始报错翻成人话（#16 第 3 节，零机器味） */
function humanizeGitError(args: string[], stderr?: string): string {
  const sub = args[0] ?? ''
  const hint = stderr ?? ''
  if (sub === 'commit' && hint.includes('nothing to commit')) return '没有改动需要保存'
  if (sub === 'commit' && hint.includes('Author identity unknown')) return 'git 没设身份，请联系管理员配置 user.name/user.email'
  if (hint.includes('not a git repository')) return '这里不是书仓库（没有 .git）'
  return hint.split('\n')[0] || '未知错误'
}

// ── 常用 git 操作（#16 第 3 节映射表，finalize / 状态机复用）──

/** git status --porcelain（判定工作树脏不脏；core.quotepath=false 保中文路径不转义）。
 *  注意：只去末尾换行，**不动行首空格**——porcelain 是固定宽度格式（XY<空格>path），
 *  XY 中 X 状态码可能是空格（如 " M"=worktree改），行首 trim 会吃掉它破坏对齐。
 *  调用方按 .slice(3) 取 path。 */
export function statusPorcelain(cwd: string): string {
  // -c core.quotepath=false：非 ASCII 路径（中文目录/文件名）原样输出，免八进制转义
  const r = git(['-c', 'core.quotepath=false', 'status', '--porcelain'], cwd)
  return r.ok ? r.stdout.replace(/\n+$/, '') : ''
}

/** 最近一次 commit 的完整 message（取确认 trailer 用） */
export function lastCommitMsg(cwd: string): string {
  const r = git(['log', '-1', '--format=%B'], cwd)
  return r.ok ? r.stdout : ''
}

/**
 * git add + 一次 commit（#13 第 4 节原子点 + #16 第 3 节人话）。
 * finalize（#13）写时入账、#18 手改补登 都复用本函数：add+commit 是一个原子单元。
 *
 * @param paths 显式指定要入账的路径列表（相对 cwd）。
 *              传则只 `git add <paths>`，避免 `add -A` 误纳工作区无关改动（草稿残留/临时笔记等），
 *              保证「一次 commit = 一章定稿」的语义纯净；
 *              不传则回退到 `git add -A`（兼容手改补登等全量场景 + 既有测试）。
 * @returns 成功带 commit hash；失败带人话（不抛、调用方决定怎么报）
 */
export function addCommit(
  cwd: string,
  msg: string,
  paths?: string[],
): { ok: true; hash: string } | { ok: false; humanMsg: string } {
  const addArgs = paths && paths.length > 0 ? ['add', '--', ...paths] : ['add', '-A']
  const addR = git(addArgs, cwd)
  if (!addR.ok) return { ok: false, humanMsg: addR.humanMsg }

  const commitR = git(['commit', '-m', msg], cwd)
  if (!commitR.ok) return { ok: false, humanMsg: commitR.humanMsg }

  // 取 commit hash（commit 已成功；取不到不阻断定稿成立，但作为失败上报让调用方记）
  const headR = git(['rev-parse', 'HEAD'], cwd)
  if (!headR.ok) return { ok: false, humanMsg: `定稿已保存但取不到版本号：${headR.humanMsg}` }
  return { ok: true, hash: headR.stdout.trim() }
}

/**
 * 按定稿 commit 前缀反查某单元（章/篇）定稿 commit 的 SHA（#16 第 5 节回滚定位）。
 * 只搜当前分支历史，不用 --all——避免命中备份 ref（回收/回到N-*）上的旧 commit 导致定位错乱。
 *
 * 前缀按 kind（M8 #26）：long → `ch:<4 位补零章号>`；short → `pc:<3 位补零篇号>`。
 * 默认 long（向后兼容现有调用）。
 */
export function findChapterCommit(
  cwd: string,
  chapterNum: number,
  kind: 'long' | 'short' = 'long',
): string | null {
  const prefix = kind === 'short'
    ? `pc:${String(chapterNum).padStart(3, '0')} `
    : `ch:${String(chapterNum).padStart(4, '0')} `
  const r = git(['log', '--grep', `^${prefix.trim()}`, '--format=%H'], cwd)
  if (!r.ok) return null
  const lines = r.stdout.trim().split('\n').filter(Boolean)
  return lines.length > 0 ? lines[0]! : null
}

// ── 健康检查（#16 第 2 节，#15 态 1 路由进入）────────────

/** 健康检查发现的异常项（每类带人话 + 修复指引；会阻断写作入口） */
export interface HealthIssue {
  /** 异常种类：halfCommit / mergeConflict / staleLock / cloudCopy */
  kind: 'halfCommit' | 'mergeConflict' | 'staleLock' | 'cloudCopy'
  /** 人话（对作者，零机器味） */
  humanMsg: string
  /** 修复建议（怎么处理） */
  fix: string
  /** 相关文件（如网盘副本路径、冲突文件） */
  files?: string[]
}

/** 健康检查发现的风险提示（不阻断写作入口） */
export interface HealthWarning {
  /** 提示种类 */
  kind: 'remoteConfigured'
  /** 人话提示 */
  humanMsg: string
  /** 建议处理方式 */
  fix: string
  /** 相关 remote 名称 */
  remotes?: string[]
}

/** 健康检查报告 */
export interface HealthReport {
  /** 阻断性问题；干净则空数组 */
  issues: HealthIssue[]
  /** 非阻断风险提示 */
  warnings: HealthWarning[]
  /** 便利标志 */
  clean: boolean
}

/**
 * 进门 git 健康检查（#16 第 2 节）。
 * 按序查 4 类异常，命中即入 issues。clean = issues 为空。
 * 不健康不放行写章（#15 态 1 路由逻辑由状态机定，本函数只负责检测 + 出人话）。
 */
export function gitHealthCheck(bookRoot: string): HealthReport {
  const issues: HealthIssue[] = []
  const warnings: HealthWarning[] = []

  // #1 半提交：staged 残留（commit 中断标志）
  const staged = git(['diff', '--cached', '--name-only'], bookRoot)
  if (staged.ok && staged.stdout.trim().length > 0) {
    issues.push({
      kind: 'halfCommit',
      humanMsg: '上次保存没收尾，有改动挂在半路上。',
      fix: '确认这些改动要不要，接 finalize 续跑或撤销重来。',
      files: staged.stdout.trim().split('\n'),
    })
  }

  // #2 合并冲突：.git/MERGE_HEAD 存在 或 status 含 UU/AA/DD
  const mergeHead = existsSync(join(bookRoot, '.git', 'MERGE_HEAD'))
  const status = statusPorcelain(bookRoot)
  const conflictMarkers = status.split('\n').filter((l) => /^[UAD][UAD]/.test(l))
  if (mergeHead || conflictMarkers.length > 0) {
    issues.push({
      kind: 'mergeConflict',
      humanMsg: '有改动撞车了（合并冲突没解决完）。',
      fix: '打开冲突文件解决标记（<<<<<<< ======= >>>>>>>），或撤销这次合并重来。',
      files: conflictMarkers.map((l) => l.slice(3)),
    })
  }

  // #3 僵死锁：.git/index.lock 存在 → 报 staleLock。
  // git 正常操作不留锁；若真有并发 git 在跑，清锁后它会失败重试被 try/catch 兜住（宁停勿崩）。
  // M3 直接判锁存在即报（全局 ps 查活跃进程在开发机恒 true，误判锁为活跃反不安全，故不查）；M4 可精细化锁年龄判定。
  const indexLock = join(bookRoot, '.git', 'index.lock')
  if (existsSync(indexLock)) {
    issues.push({
      kind: 'staleLock',
      humanMsg: '上个操作没退干净，留了个锁。',
      fix: '已确认没有 git 在跑，可删 .git/index.lock 后重试。',
      files: ['.git/index.lock'],
    })
  }

  // #4 网盘副本残留：._*、.DS_Store、<名> 2.md、<名> (1).md 等同步盘冲突副本
  const cloudCopies = scanCloudCopies(bookRoot)
  if (cloudCopies.length > 0) {
    issues.push({
      kind: 'cloudCopy',
      humanMsg: '检测到同步盘副本残留，可能有双写冲突。',
      fix: '对比副本和原文件，确认哪份是真内容后删掉多余的；警示同步盘风险（建议关掉书仓库的同步盘）。',
      files: cloudCopies,
    })
  }

  const remotes = listRemotes(bookRoot)
  if (remotes.length > 0) {
    warnings.push({
      kind: 'remoteConfigured',
      humanMsg: '这本书配置了 git remote，小说正文存在被推到远端的风险。',
      fix: '默认 pre-push 会拦住误推；若不是你明确设置的备份远端，建议删除 remote 或保留本地仓库。',
      remotes,
    })
  }

  return { issues, warnings, clean: issues.length === 0 }
}

function listRemotes(bookRoot: string): string[] {
  const r = git(['remote'], bookRoot)
  if (!r.ok) return []
  return r.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
}

/** 扫描网盘副本残留（#16 第 2 节，真实坑：CLWriting 开发即踩过 SMB 同步盘） */
function scanCloudCopies(bookRoot: string): string[] {
  const copies: string[] = []
  const patterns = [
    /^\._[^/]+$/, // AppleDouble ._*
    /^\.DS_Store$/,
    /.+\s2\.md$/, // <名> 2.md（Dropbox/OneDrive 风格）
    /.+\s\(\d+\)\.md$/, // <名> (1).md（Google Drive 风格）
    /.+-conflicted copy.*\.md$/i, // <名>-conflicted copy.md
  ]
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      // 跳过 .git / node_modules（不扫 git 内部与依赖）
      if (e.name === '.git' || e.name === 'node_modules') continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        walk(full)
      } else if (patterns.some((p) => p.test(e.name))) {
        copies.push(full)
      }
    }
  }
  walk(bookRoot)
  return copies
}

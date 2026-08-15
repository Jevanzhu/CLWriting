/**
 * git 执行器 —— 去 git 方案（W0）后的残余活代码收口。
 *
 * 版本系统已改为「内容指纹 + manifest 定稿基线」（document/finalize.ts），
 * finalize 不再 commit、状态机不再做 git 健康检查——#16 的 addCommit /
 * findChapterCommit / gitHealthCheck / lastCommitMsg 均已无生产调用方，删除。
 *
 * 仍活着的调用方：
 * - ai-track.ts：AI 产出旁路 ref（refs/ai/*），作者人味信号用；
 * - install/migrate-finalized-revision.ts：旧书首次加载 git 历史反推定稿基线；
 * - state.ts：scanCloudCopies 网盘副本残留检测（写作状态机的进门检查之一）。
 *
 * 所有 git 调用仍经 git() 统一执行：spawnSync 数组形式不走 shell，免注入；
 * 失败按退出码 → 人话收口（#16 第 3 节原则：对作者永不出 git 命令、SHA、堆栈）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

// ── 统一 git 执行器（#16 第 3 节）──────────────────

/** git 调用结果：成功带 stdout，失败带人话 */
export type GitResult =
  | { ok: true; stdout: string }
  | { ok: false; humanMsg: string; stderr?: string }

/**
 * 执行一条 git 命令（统一收口，#16 第 3 节）。
 * spawnSync 数组形式不走 shell，免注入、免转义（同 finalize 既有做法）。
 * 失败按退出码 → 人话，不把作者丢给 git 报错。
 * opts.input：喂 stdin（hash-object --stdin 等内容写入场景用）。
 */
export function git(args: string[], cwd: string, opts?: { encoding?: 'utf-8'; input?: string }): GitResult {
  const r = spawnSync('git', args, {
    cwd,
    stdio: 'pipe',
    encoding: opts?.encoding ?? 'utf-8',
    ...(opts?.input !== undefined ? { input: opts.input } : {}),
  })
  if (r.status === 0) return { ok: true, stdout: String(r.stdout ?? '') }

  const stderr = String(r.stderr || r.error?.message || '')
  return {
    ok: false,
    humanMsg: `git 操作失败（${args.join(' ')}）：${humanizeGitError(args, stderr)}`,
    stderr,
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

/** git status --porcelain（判定工作树脏不脏；core.quotepath=false 保中文路径不转义）。
 *  注意：只去末尾换行，**不动行首空格**——porcelain 是固定宽度格式（XY<空格>path），
 *  XY 中 X 状态码可能是空格（如 " M"=worktree改），行首 trim 会吃掉它破坏对齐。
 *  调用方按 .slice(3) 取 path。 */
export function statusPorcelain(cwd: string, untrackedAll = false): string {
  // -c core.quotepath=false：非 ASCII 路径（中文目录/文件名）原样输出，免八进制转义
  const args = ['-c', 'core.quotepath=false', 'status', '--porcelain']
  if (untrackedAll) args.push('-uall')
  const r = git(args, cwd)
  return r.ok ? r.stdout.replace(/\n+$/, '') : ''
}

/** 扫描网盘副本残留（#16 第 2 节，真实坑：CLWriting 开发即踩过 SMB 同步盘） */
export function scanCloudCopies(bookRoot: string): string[] {
  const copies: string[] = []
  const patterns = [
    /^\._[^/]+$/, // AppleDouble ._*
    /^\.DS_Store$/,
    /.+-conflicted copy.*\.md$/i, // <名>-conflicted copy.md
  ]
  // X-P2-20：`<名> 2.md` / `<名> (1).md` 收紧为「同名去重副本」——同目录存在母本 `<名>.md` 才报；
  // 纯文件名正则分不出副本与合法标题（`第 2.md` 会被误报），必须验母本
  const dedupCopy = /^(.+)\s(?:\d+|\(\d+\))\.md$/
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      // 跳过 .git / node_modules / .cache（不扫 git 内部、依赖与可重建缓存）
      // X-P2-20：补 .版本（工作区/版本档案，每书成百上千文件，进门全扫纯属浪费）与 .trash（回收站）
      if (e.name === '.git' || e.name === 'node_modules' || e.name === '.cache' || e.name === '.版本' || e.name === '.trash') continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        walk(full)
      } else if (patterns.some((p) => p.test(e.name))) {
        copies.push(full)
      } else {
        const m = dedupCopy.exec(e.name)
        if (m && existsSync(join(dir, `${m[1]}.md`))) copies.push(full)
      }
    }
  }
  walk(bookRoot)
  return copies
}

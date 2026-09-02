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

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { log } from '../log/index.js'

// ── 统一 git 执行器（#16 第 3 节）──────────────────

/** git 调用结果：成功带 stdout，失败带人话 */
export type GitResult =
  | { ok: true; stdout: string }
  | { ok: false; humanMsg: string; stderr?: string }

/**
 * git 单次调用超时（P2-30）：仓库锁 / 交互提示 / 挂载盘无响应时 spawnSync 会永久阻塞
 * 调用线程——statusPorcelain 在 server 启动链路（migrate 反推）会拖死启动。超时后
 * kill 子进程并按失败返回（fail-closed：调用方不能把「未完成」当「成功/干净」）。
 * R36-5：gitAsync（异步路径）共用同一超时档；测试经 __setGitAsyncTimeoutForTest 缩短。
 */
export const GIT_TIMEOUT_MS = 15_000

/** R36-5：异步路径超时档生效值（模块内可变，仅测试注入口可改；先例同
 *  search.ts __setSearchCacheTtlForTest / books.ts __setBooksLockTimeoutForTest）。 */
let gitAsyncTimeoutMs = GIT_TIMEOUT_MS

/** R36-5：测试注入口（null/缺省恢复默认；生产零调用）。 */
export function __setGitAsyncTimeoutForTest(ms: number | null): void {
  gitAsyncTimeoutMs = ms ?? GIT_TIMEOUT_MS
}

/**
 * R66-22（十四轮）：git 子进程输出缓冲上限。spawnSync 默认 1MB——大书
 * `ls-files` / `status --porcelain -uall`（数千 tracked 文件 × 中文路径）输出
 * 超限即 ENOBUFS 失败，此前与普通失败无日志区分地静默降级（listTrackedDocs
 * 拿空表 → 旧书定稿基线迁移永久跳过）。抬高到 64MB（仅上限不预分配；书籍
 * 规模量级下不可能再触顶），触顶时单独留痕见下方 ENOBUFS 分支。
 */
const GIT_MAX_BUFFER = 64 * 1024 * 1024

/**
 * 执行一条 git 命令（统一收口，#16 第 3 节）。
 * spawnSync 数组形式不走 shell，免注入、免转义（同 finalize 既有做法）。
 * 失败按退出码 → 人话，不把作者丢给 git 报错。
 * opts.input：喂 stdin（hash-object --stdin 等内容写入场景用）。
 * 超时（P2-30）：15s 上限，git 无响应即中止并按失败返回（statusPorcelain 得 null → fail-closed）。
 */
export function git(args: string[], cwd: string, opts?: { encoding?: 'utf-8'; input?: string }): GitResult {
  const r = spawnSync('git', args, {
    cwd,
    stdio: 'pipe',
    encoding: opts?.encoding ?? 'utf-8',
    ...(opts?.input !== undefined ? { input: opts.input } : {}),
    timeout: GIT_TIMEOUT_MS,
    // R66-22（十四轮）：显式 maxBuffer——默认 1MB 下大书 git 输出超限即 ENOBUFS，
    // 与普通失败混在一起无留痕（listTrackedDocs 静默拿空 → 定稿基线迁移永久跳过）
    maxBuffer: GIT_MAX_BUFFER,
    // R37-4（三十七轮）：win 上不闪控制台窗（Electron 桌面形态下每次 git 调用可见）
    windowsHide: true,
  })
  if (r.status === 0) return { ok: true, stdout: String(r.stdout ?? '') }

  const errCode = (r.error as { code?: string } | undefined)?.code
  const timedOut = errCode === 'ETIMEDOUT' || r.signal === 'SIGTERM'
  const stderr = String(r.stderr || r.error?.message || '')
  // R77-3（二十五轮批 B）：ENOENT（找不到 git 可执行）特判——win 未装 Git for Windows
  // 的典型形态，此前落穿 generic 分支把 spawn 的英文报错翻面直出；特判成人话引导装 Git。
  // ENOENT 也可来自 cwd 不存在，但本模块调用方均传已验证书根，非本形态。
  // R66-22（十四轮）：ENOBUFS 单独留痕——输出缓冲超限是「结果被截断的环境问题」而非
  // git 本身失败，与普通失败混流会让静默降级（空表/跳过迁移）无从定位；抬高 maxBuffer
  // 后理论不可达，真触顶时 log.warn 供诊断。
  if (errCode === 'ENOBUFS') {
    log.warn('git', `git 输出超限（ENOBUFS，${args.join(' ')}）：子进程 stdout 超 maxBuffer ${GIT_MAX_BUFFER} 字节被截断，结果按失败返回`)
  }
  return {
    ok: false,
    humanMsg: timedOut
      ? `git 操作超时（${args.join(' ')}）：git 进程无响应，已中止`
      : errCode === 'ENOBUFS'
        ? `git 输出超限（${args.join(' ')}）：仓库改动量过大，输出超出缓冲上限，请分批处理或清理仓库`
        : errCode === 'ENOENT'
          ? '未检测到 Git（未安装或不在 PATH）——请安装 Git（Windows 推荐 Git for Windows）后重启应用'
          : `git 操作失败（${args.join(' ')}）：${humanizeGitError(args, stderr)}`,
    stderr,
  }
}

/**
 * R36-5（三十六轮）：git 异步执行路径——child_process.spawn 包 promise，供服务进程
 * 事件循环上的调用链（recordAiVersionAsync 的 hash-object/update-ref 等）使用。
 * R36-5 机理：同一 try 块紧邻注释宣称「保存锁等待不再冻结事件循环」，但 recordAiVersion
 * 仍是两次同步 spawnSync（父子进程全双工管道数据驱动，无响应时 spawnSync 阻塞当前
 * 线程直到超时）——git 无响应（网盘挂载 .git/杀软锁）每次阻塞事件循环最长 15s×2，
 * 保存/改稿/连写链（self-heal 每章一次）全被拖住。
 *
 * 语义与 git() 逐位对齐：数组形式不走 shell（免注入/免转义）、超时 kill 子进程并按
 * 失败返回（fail-closed——调用方不能把「未完成」当成功）、ENOENT/ENOBUFS 特判同源、
 * 输出缓冲上限同 GIT_MAX_BUFFER（超限按 ENOBUFS 失败）。超时有界（gitAsyncTimeoutMs），
 * 绝不挂起：spawn 后立即挂起 setTimeout，超时即 SIGTERM（best-effort）并随即按失败
 * resolve——不依赖子进程 'close' 收口（忽略 SIGTERM / 不可中断态的进程也保证有界）。
 * opts.signal：外部取消（AbortSignal）——取消同样 kill 子进程并按「已中止」失败返回。
 * 本函数永不 reject（错误一律 resolve ok:false）——调用方 await 不会落到未捕获异常。
 */
export function gitAsync(
  args: string[],
  cwd: string,
  opts?: { encoding?: 'utf-8'; input?: string; signal?: AbortSignal },
): Promise<GitResult> {
  return new Promise<GitResult>((resolve) => {
    // R37-4（三十七轮）：win 上不闪控制台窗（与同步 git() 同款）
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const stdoutParts: string[] = []
    const stderrParts: string[] = []
    // R66-22 同款缓冲上限：只收满上限为止（stream 继续排空，防子进程写阻塞在后挂 SIGPIPE）
    let buffered = 0
    let overBuffer = false
    let settled = false

    const settle = (r: GitResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        opts?.signal?.removeEventListener('abort', onAbort)
      } catch {
        /* best-effort */
      }
      resolve(r)
    }

    const timer = setTimeout(() => {
      if (settled) return
      // 超时（P2-30 同款语义）：kill 子进程（best-effort）并**直接**按失败 settle——
      // 不依赖 'close' 收口：进程忽略 SIGTERM / 不可中断态（D-state）等 kill 不生效
      // 形态下也保证超时严格有界（调用方绝不被挂起）
      child.kill('SIGTERM')
      settle({
        ok: false,
        humanMsg: `git 操作超时（${args.join(' ')}）：git 进程无响应，已中止`,
        stderr: stderrParts.join(''),
      })
    }, gitAsyncTimeoutMs)
    // 子进程自身持事件循环上界，兜底定时器不拖延进程退出
    timer.unref()

    const onAbort = (): void => {
      if (settled) return
      child.kill('SIGTERM')
      settle({
        ok: false,
        humanMsg: `git 操作已中止（${args.join(' ')}）：请求被取消`,
        stderr: stderrParts.join(''),
      })
    }
    if (opts?.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    const collect = (dst: string[], chunk: Buffer | string): void => {
      if (overBuffer) return
      buffered += Buffer.byteLength(chunk)
      if (buffered > GIT_MAX_BUFFER) {
        overBuffer = true
        return
      }
      dst.push(String(chunk))
    }
    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', (c) => collect(stdoutParts, c))
    child.stderr.on('data', (c) => collect(stderrParts, c))

    if (opts?.input !== undefined) {
      child.stdin.on('error', () => {
        /* EPIPE 等：子进程提前退出时忽略（close 分支已收口失败语义） */
      })
      child.stdin.write(opts.input)
    }
    child.stdin.end()

    child.on('error', (err) => {
      if (settled) return
      const code = (err as NodeJS.ErrnoException).code
      settle({
        ok: false,
        // R77-3 同款：ENOENT（找不到 git 可执行）特判人话
        humanMsg:
          code === 'ENOENT'
            ? '未检测到 Git（未安装或不在 PATH）——请安装 Git（Windows 推荐 Git for Windows）后重启应用'
            : `git 操作失败（${args.join(' ')}）：${err.message}`,
        stderr: err.message,
      })
    })

    child.on('close', (code) => {
      if (settled) return
      const stderr = stderrParts.join('')
      if (code === 0 && !overBuffer) {
        settle({ ok: true, stdout: stdoutParts.join('') })
        return
      }
      settle({
        ok: false,
        humanMsg: overBuffer
          ? `git 输出超限（${args.join(' ')}）：仓库改动量过大，输出超出缓冲上限，请分批处理或清理仓库`
          : `git 操作失败（${args.join(' ')}）：${humanizeGitError(args, stderr)}`,
        stderr,
      })
    })
  })
}

/** 把 git 原始报错翻成人话（#16 第 3 节，零机器味）。
 *  R26-56（二十六轮）：commit 两翻译分支删除——addCommit 随 #16 去依赖化移除后本模块
 *  再无 commit 子命令调用方（现存导出仅 status/scan 类，test/git/exec.test.ts 亦无
 *  commit 分支用例），两分支永不命中；args 形参保留（调用点报错信封仍要 join 展示）。 */
function humanizeGitError(_args: string[], stderr?: string): string {
  const hint = stderr ?? ''
  if (hint.includes('not a git repository')) return '这里不是书仓库（没有 .git）'
  return hint.split('\n')[0] || '未知错误'
}

/** git status --porcelain（判定工作树脏不脏；core.quotepath=false 保中文路径不转义）。
 *  注意：只去末尾换行，**不动行首空格**——porcelain 是固定宽度格式（XY<空格>path），
 *  XY 中 X 状态码可能是空格（如 " M"=worktree改），行首 trim 会吃掉它破坏对齐。
 *  调用方按 .slice(3) 取 path。
 *  RB-IF-P1-1：失败返回 null（与「干净」的 '' 区分）——fail-open 会让调用方把
 *  无法判定的脏集当空集（migrate 据此把脏 entry 全部误标已定稿）。调用方须显式处理 null。 */
export function statusPorcelain(cwd: string, untrackedAll = false): string | null {
  // -c core.quotepath=false：非 ASCII 路径（中文目录/文件名）原样输出，免八进制转义
  const args = ['-c', 'core.quotepath=false', 'status', '--porcelain']
  if (untrackedAll) args.push('-uall')
  const r = git(args, cwd)
  return r.ok ? r.stdout.replace(/\n+$/, '') : null
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
  // R77-3（二十五轮批 B）：坚果云 win 特征——`<名>（冲突副本 …）.md` 中文冲突标记
  //（全角/半角括号或连字符分隔，名与分隔符间的空格不入捕获——母本推导不受尾随空格干扰）。
  // OneDrive 式 `<名>-<计算机名>.md` 与合法标题不可分（假阳性高），不进自动检测，
  // 改根 README「Windows 版使用须知」披露；同 X-P2-20 必须验母本。
  const zhConflicted = /^(.+?)\s*[（(-]\s*冲突副本.*\.md$/
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
        else {
          const c = zhConflicted.exec(e.name)
          if (c && existsSync(join(dir, `${c[1]}.md`))) copies.push(full)
        }
      }
    }
  }
  walk(bookRoot)
  return copies
}

/**
 * git 执行器 —— 去 git 方案后的残余活代码收口。
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
 * 所有 git 调用仍经 git 统一执行：spawnSync 数组形式不走 shell，免注入；
 * 失败按退出码 → 人话收口（#16 第 3 节原则：对作者永不出 git 命令、SHA、堆栈）。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { log } from '../log/index.js'
import { testableConst } from '../shared/testable.js'

// ── 统一 git 执行器（#16 第 3 节）──────────────────

/** git 调用结果：成功带 stdout，失败带人话 */
type GitResult = { ok: true; stdout: string } | { ok: false; humanMsg: string; stderr?: string }

/**
 * git 单次调用超时：仓库锁 / 交互提示 / 挂载盘无响应时 spawnSync 会永久阻塞
 * 调用线程——statusPorcelain 在 server 启动链路（migrate 反推）会拖死启动。超时后
 * kill 子进程并按失败返回（fail-closed：调用方不能把「未完成」当「成功/干净」）。
 * gitAsync（异步路径）共用同一超时档；测试经 __setGitAsyncTimeoutForTest 缩短。
 */
const GIT_TIMEOUT_MS = 15_000

/** 三件套换装 testableConst 工厂异步路径超时覆盖档——
 *  getter 消费点显式调用（null 回退常量档），setter 元组第二位原名原签名
 *  （传 null 即还原默认档，测试面零感知）。 */
export const [getGitAsyncTimeoutMs, __setGitAsyncTimeoutForTest] = testableConst<number | null>(null)

/**
 * IR-3SIGTERM → SIGKILL 升级 kill。SIGTERM 是 best-effort
 *（git 可捕获忽略 / 不可中断态 D-state 下不生效），裸 TERM 后子进程可能滞留——
 * 网盘 .git 句柄/锁文件不释放，残留进程累积。先礼后兵：TERM 立即发，宽限期
 * GIT_KILL_ESCALATION_MS 后仍不退 → SIGKILL 强制收口。升级定时器 unref 不持事件
 * 循环；对已退出进程 kill 是无害 no-op（返回 false / ESRCH 均吞）。settle 语义不变
 *（不等待 close——调用方绝不被挂起）。
 * 导出仅为单测注入假 child（同款已登记结构债：生产消费方仅 gitAsync 两处）。
 */
const GIT_KILL_ESCALATION_MS = 2_000

export function killWithEscalation(
  child: { kill: (signal: NodeJS.Signals) => boolean },
  delayMs: number = GIT_KILL_ESCALATION_MS,
): () => void {
  try {
    child.kill('SIGTERM')
  } catch {
    /* 已退出/权限：升级定时器照设，KILL 再兜一次 */
  }
  const t = setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 已退出：no-op */
    }
  }, delayMs)
  t.unref()
  return () => clearTimeout(t)
}

/**
 * git 子进程输出缓冲上限。spawnSync 默认 1MB——大书
 * `ls-files` / `status --porcelain -uall`（数千 tracked 文件 × 中文路径）输出
 * 超限即 ENOBUFS 失败，此前与普通失败无日志区分地静默降级（listTrackedDocs
 * 拿空表 → 旧书定稿基线迁移永久跳过）。抬高到 64MB（仅上限不预分配；书籍
 * 规模量级下不可能再触顶），触顶时单独留痕见下方 ENOBUFS 分支。
 */
const GIT_MAX_BUFFER = 64 * 1024 * 1024

/**
 * 书目录（外部来源）不可信——git 会读仓库内
 * `.git/config`，其中 `core.fsmonitor = <命令>` 在 `status` 刷新索引时被当场执行
 *（本机实测 git 2.52 win：裸 `git status --porcelain` 即触发命名脚本），
 * 而 `safe.directory` 只拦属主不一致——作者自己下载/解压的书目录属主就是他本人，
 * 拦不住。server 启动链 migrateFinalizedRevisions 对每本书跑 statusPorcelain，
 * 等价于「把他人共享的书目录放进书库 = 启动即执行任意命令」。
 *
 * 统一前置两类 -c 覆盖（命令行 -c 优先级高于仓库内配置，实测生效）：
 * - `core.fsmonitor=false`：关掉外部 fsmonitor 命令——本条的唯一活靶；
 * - `core.hooksPath=NUL`（win）/`/dev/null`（posix）：hooks 全关——现存子命令
 *   （status / for-each-ref / hash-object / update-ref / cat-file）本不触发 hook，
 *   此处只防将来新增子命令（checkout/commit 类）把同一面带回来。
 *
 * 未屏蔽 global/system 配置：那是用户/管理员自己的信任域（本害面是随书目录流入的仓库内
 * 配置），且 Git for Windows 系统配置带 autocrlf 等既有默认，屏蔽会引入无关行为变化。
 * 残余（如实记档，不在本条修）：git 可执行仍按 PATH 解析、未做绝对路径——要劫持得先能
 * 写入应用工作目录/PATH，风险面远小于本条。
 * 导出单源：同步 git 与 gitAsync 共用；测试经此断言平台分支与参数面。
 */
export function hardenGitArgs(args: string[]): string[] {
  return [
    '-c',
    'core.fsmonitor=false',
    '-c',
    `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
    ...args,
  ]
}

/**
 * 执行一条 git 命令（统一收口，#16 第 3 节）。
 * spawnSync 数组形式不走 shell，免注入、免转义（同 finalize 既有做法）。
 * 失败按退出码 → 人话，不把作者丢给 git 报错。
 * opts.input：喂 stdin（hash-object --stdin 等内容写入场景用）。
 * 超时：15s 上限，git 无响应即中止并按失败返回（statusPorcelain 得 null → fail-closed）。
 * 传参经 hardenGitArgs（RC：仓库内 fsmonitor/hooks 配置不可信）；
 * 报错信封仍用调用方原 args 拼装，-c 加固参数不外露给作者。
 */
export function git(args: string[], cwd: string, opts?: { encoding?: 'utf-8'; input?: string }): GitResult {
  const r = spawnSync('git', hardenGitArgs(args), {
    cwd,
    stdio: 'pipe',
    // （win 平台专项）/ 双线同旨合并：windowsHide——
    // git.exe 是控制台程序，打包态 GUI（无控制台）下不设此项会为每次调用新建可见
    // 控制台窗（启动迁移链/保存链高频调用连续闪窗）；隐藏窗口不影响 stdio 管道，
    // dev 有控制台形态行为不变。
    windowsHide: true,
    encoding: opts?.encoding ?? 'utf-8',
    ...(opts?.input !== undefined ? { input: opts.input } : {}),
    timeout: GIT_TIMEOUT_MS,
    // 显式 maxBuffer——默认 1MB 下大书 git 输出超限即 ENOBUFS，
    // 与普通失败混在一起无留痕（listTrackedDocs 静默拿空 → 定稿基线迁移永久跳过）
    maxBuffer: GIT_MAX_BUFFER,
  })
  if (r.status === 0) return { ok: true, stdout: String(r.stdout ?? '') }

  const errCode = (r.error as { code?: string } | undefined)?.code
  // SIGTERM 单独分诊——spawnSync 自家超时必带 ETIMEDOUT
  // 错误码（win 实证：error.code=ETIMEDOUT + signal=SIGTERM 并存），原
  // `|| r.signal === 'SIGTERM'` 把外部终止（任务管理器/脚本 kill git 进程）也误归
  // 「超时」文案误导排障方向
  const timedOut = errCode === 'ETIMEDOUT'
  const externallyTerminated = !timedOut && r.signal === 'SIGTERM'
  const stderr = String(r.stderr || r.error?.message || '')
  // ENOENT（找不到 git 可执行）特判——win 未装 Git for Windows
  // 的典型形态，此前落穿 generic 分支把 spawn 的英文报错翻面直出；特判成人话引导装 Git。
  // ENOENT 也可来自 cwd 不存在，但本模块调用方均传已验证书根，非本形态。
  // ENOBUFS 单独留痕——输出缓冲超限是「结果被截断的环境问题」而非
  // git 本身失败，与普通失败混流会让静默降级（空表/跳过迁移）无从定位；抬高 maxBuffer
  // 后理论不可达，真触顶时 log.warn 供诊断。
  if (errCode === 'ENOBUFS') {
    log.warn(
      'git',
      `git 输出超限（ENOBUFS，${args.join(' ')}）：子进程 stdout 超 maxBuffer ${GIT_MAX_BUFFER} 字节被截断，结果按失败返回`,
    )
  }
  return {
    ok: false,
    humanMsg: timedOut
      ? `git 操作超时（${args.join(' ')}）：git 进程无响应，已中止`
      : externallyTerminated
        ? `git 进程被终止（${args.join(' ')}）：收到外部 SIGTERM 信号（非超时）`
        : errCode === 'ENOBUFS'
          ? `git 输出超限（${args.join(' ')}）：仓库改动量过大，输出超出缓冲上限，请分批处理或清理仓库`
          : errCode === 'ENOENT'
            ? gitMissingHint() // mac适配：文案按平台分支（与同步 git() 共用 gitMissingHint 单源）
            : `git 操作失败（${args.join(' ')}）：${humanizeGitError(args, stderr)}`,
    stderr,
  }
}

/**
 * git 异步执行路径——child_process.spawn 包 promise，供服务进程
 * 事件循环上的调用链（recordAiVersionAsync 的 hash-object/update-ref 等）使用。
 * 机理：同一 try 块紧邻注释宣称「保存锁等待不再冻结事件循环」，但 recordAiVersion
 * 仍是两次同步 spawnSync（父子进程全双工管道数据驱动，无响应时 spawnSync 阻塞当前
 * 线程直到超时）——git 无响应（网盘挂载 .git/杀软锁）每次阻塞事件循环最长 15s×2，
 * 保存/改稿/连写链（self-heal 每章一次）全被拖住。
 *
 * 语义与 git 逐位对齐：数组形式不走 shell（免注入/免转义）、超时 kill 子进程并按
 * 失败返回（fail-closed——调用方不能把「未完成」当成功）、ENOENT/ENOBUFS 特判同源、
 * 输出缓冲上限同 GIT_MAX_BUFFER（超限按 ENOBUFS 失败）。超时有界（gitAsyncTimeoutMs），
 * 绝不挂起：spawn 后立即挂起 setTimeout，超时即 kill（SIGTERM→2s 宽限 SIGKILL 升级，
 * 忽略 TERM 的滞留进程不再无限占锁/句柄）并随即按失败
 * resolve——不依赖子进程 'close' 收口（忽略信号 / 不可中断态的进程也保证有界）。
 * opts.signal：外部取消（AbortSignal）——取消同样 kill 子进程并按「已中止」失败返回。
 * 本函数永不 reject（错误一律 resolve ok:false）——调用方 await 不会落到未捕获异常。
 */
export function gitAsync(
  args: string[],
  cwd: string,
  opts?: { encoding?: 'utf-8'; input?: string; signal?: AbortSignal },
): Promise<GitResult> {
  return new Promise<GitResult>((resolve) => {
    // （双线同旨合并）：windowsHide 同步补齐——异步路径与同步路径
    // 同频闪窗，与同步 git 同款收口
    // RC：传参与同步 git 同源经 hardenGitArgs（仓库内 fsmonitor/hooks 不可信）
    const child = spawn('git', hardenGitArgs(args), { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const stdoutParts: string[] = []
    const stderrParts: string[] = []
    // 同款缓冲上限：只收满上限为止（stream 继续排空，防子进程写阻塞在后挂 SIGPIPE）
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
      // 超时（同款语义）：kill 子进程并**直接**按失败 settle——
      // 不依赖 'close' 收口：进程忽略信号 / 不可中断态（D-state）等 kill 不生效
      // 形态下也保证超时严格有界（调用方绝不被挂起）。
      // 裸 SIGTERM 对忽略该信号的 git 不生效（进程滞留占网盘句柄/锁）——
      // 升级链先 TERM、2s 宽限后 KILL（killWithEscalation），settle 语义不变。
      killWithEscalation(child)
      settle({
        ok: false,
        humanMsg: `git 操作超时（${args.join(' ')}）：git 进程无响应，已中止`,
        stderr: stderrParts.join(''),
      })
    }, getGitAsyncTimeoutMs() ?? GIT_TIMEOUT_MS)
    // 子进程自身持事件循环上界，兜底定时器不拖延进程退出
    timer.unref()

    const onAbort = (): void => {
      if (settled) return
      // 同超时路径——TERM 后升级 KILL，取消不再依赖子进程对 TERM 的配合
      killWithEscalation(child)
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
        // 同款：ENOENT（找不到 git 可执行）特判人话
        // mac适配：文案按平台分支（与同步 git() 共用 gitMissingHint 单源）
        humanMsg: code === 'ENOENT' ? gitMissingHint() : `git 操作失败（${args.join(' ')}）：${err.message}`,
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
 * commit 两翻译分支删除——addCommit 随 #16 去依赖化移除后本模块
 *  再无 commit 子命令调用方（现存导出仅 status/scan 类，test/git/exec.test.ts 亦无
 *  commit 分支用例），两分支永不命中；args 形参保留（调用点报错信封仍要 join 展示）。 */
function humanizeGitError(_args: string[], stderr?: string): string {
  const hint = stderr ?? ''
  if (hint.includes('not a git repository')) return '这里不是书仓库（没有 .git）'
  return hint.split('\n')[0] || '未知错误'
}

/**
 * ENOENT（找不到 git 可执行）的安装指引文案（-mac适配）——按平台给
 * 可行动指引：darwin 走 xcode-select（Command Line Tools 自带 git，mac 最常见补装
 * 通道）；linux 中性指向系统包管理器；win 维持原文（Git for Windows）。
 * 同步 git() 与异步 gitAsync 两处 ENOENT 特判共用本单源（同族文案不漂移）。
 */
function gitMissingHint(): string {
  if (process.platform === 'darwin') {
    return '未检测到 Git——请在终端执行 `xcode-select --install` 安装 Command Line Tools（或从 https://git-scm.com 安装）后重启应用'
  }
  if (process.platform === 'linux') {
    return '未检测到 Git（未安装或不在 PATH）——请用系统包管理器安装 Git（如 apt/dnf/pacman install git）后重启应用'
  }
  return '未检测到 Git（未安装或不在 PATH）——请安装 Git（Windows 推荐 Git for Windows）后重启应用'
}

/** git status --porcelain（判定工作树脏不脏；core.quotepath=false 保中文路径不转义）。
 *  注意：只去末尾换行，**不动行首空格**——porcelain 是固定宽度格式（XY<空格>path），
 *  XY 中 X 状态码可能是空格（如 " M"=worktree改），行首 trim 会吃掉它破坏对齐。
 *  调用方按 .slice(3) 取 path。
 * 失败返回 null（与「干净」的 '' 区分）——fail-open 会让调用方把
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
  // `<名> 2.md` / `<名> (1).md` 收紧为「同名去重副本」——同目录存在母本 `<名>.md` 才报；
  // 纯文件名正则分不出副本与合法标题（`第 2.md` 会被误报），必须验母本
  const dedupCopy = /^(.+)\s(?:\d+|\(\d+\))\.md$/
  // 坚果云 win 特征——`<名>（冲突副本 …）.md` 中文冲突标记
  //（全角/半角括号或连字符分隔，名与分隔符间的空格不入捕获——母本推导不受尾随空格干扰）。
  // OneDrive 式 `<名>-<计算机名>.md` 与合法标题不可分（假阳性高），不进自动检测，
  // 同步盘场景靠用户避开放置（坚果云式标记仍自动检测）；同必须验母本。
  const zhConflicted = /^(.+?)\s*[（(-]\s*冲突副本.*\.md$/
  // Windows 资源管理器
  // 首份副本 `<名> - Copy.md` 与中文 Windows 形态 `<名> - 副本.md`——dedupCopy 的
  // 数字形态不匹配无数字母本，母本自身漏报（` - Copy (2)` 虽可经 dedupCopy 命中，
  // 但需 ` - Copy.md` 在盘，链式依赖使本源恒漏）。同母本收紧：`<名>.md`
  // 在盘才报，合法标题含该字样不误伤。
  const explorerCopy = /^(.+?)\s- (?:Copy|副本)(?:\s\(\d+\))?\.md$/
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      // 跳过 .git / node_modules / .cache（不扫 git 内部、依赖与可重建缓存）
      // 补 .版本（工作区/版本档案，每书成百上千文件，进门全扫纯属浪费）与 .trash（回收站）
      // 补工作区内部簿记目录全表（layout.ts
      // WORKSPACE_INTERNAL_DIR_PREFIXES 的「工作区/ 下直接子目录」清单对齐）——.journal
      // 内 AppleDouble 伴生（._xxx.jsonl）此前被 patterns[0] 当 cloudCopy 报红（进门每次
      // 误报，journal 目录恰是同步盘伴生高发位）；待定稿/导出/spills/.snapshots/.账本推进
      // 暂存同理不扫。跳过在 patterns 判定前，`._*` 伴生不因目录面扩大而误入候选
      //（顶层/内容区的 `._*` 维持既有「报为副本」口径不变）。
      if (
        e.name === '.git' ||
        e.name === 'node_modules' ||
        e.name === '.cache' ||
        e.name === '.版本' ||
        e.name === '.trash' ||
        e.name === '.journal' ||
        e.name === '.snapshots' ||
        e.name === '.账本推进暂存' ||
        e.name === 'spills' ||
        e.name === '待定稿' ||
        e.name === '导出'
      )
        continue
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
          else {
            const w = explorerCopy.exec(e.name)
            if (w && existsSync(join(dir, `${w[1]}.md`))) copies.push(full)
          }
        }
      }
    }
  }
  walk(bookRoot)
  return copies
}

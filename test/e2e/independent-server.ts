/**
 * P2-13（09-30 评审修复批）：e2e 独立 server 起停壳。
 *
 * 背景：playwright.config.ts 把 33 个 spec 挂在 globalSetup 的单一 workDir 上串行跑
 * （前序 spec 落盘是后序输入），任一环 flake/行为变化都会连坐整段。评审方向 =「只读型
 * spec 逐步迁独立 workDir，缩小连坐半径」。迁一个只读 spec = 复制 40 行起停样板
 * （env 存取还原 + EADDRINUSE 人话提示 + 监听失败清理 + close 后删目录），八个既有
 * 独立 server spec 已是该样板的逐字拷贝族——照「同构拷贝第三处即收单源」纪律，第九处
 * 起走本壳，不再复制。
 *
 * 本壳封装的顺序契约（逐条对应既有样板，缺一即引入残留/假红）：
 * 1. env 先存后改、close 时原样还原（CLWRITING_DRIVER 缺省改 mock；此前无差别 delete
 *    会把外层 CLI/CI 预设值抹掉，见 usage-card R32-36 记档）；
 * 2. 起服前建 workDir/userDataPath，监听失败时**先清理再上抛**（对齐 global-setup
 *    R27-124「失败路径不留残」口径）；
 * 3. EADDRINUSE 打指因人话提示（含本 spec tag + win 分支探针命令——只给 lsof 在 win
 *    上是死指引）；
 * 4. close 顺序 = 先 server.close 再删目录（Windows 句柄异步收尾，目录清理走
 *    rmTempDirRetry 重试封装）。
 *
 * 清理所有权：workDir 由本壳创建（未传 opts.workDir）时由本壳删；调用方传入自建
 * workDir（需播种 ghost 登记/自制 fixture 的场景）时**归调用方自清**——本壳不删非己物。
 *
 * 未迁移项（本批不扩面，留后续批按同一方向推进）：既有 8 个自带同形样板的独立 server
 * spec（ai-degrade/ai-provider/auto-write/usage-card/startup-notices/short-full-flow/
 * batch-finalize/release-smoke）仍持各自拷贝——它们各有差异分支（AI_DOWN 旗标、
 * 子进程起服、自制 fixture 播种），迁移需逐档核差异，与「缩小连坐半径」无收益，故本批
 * 零触碰；后续批可照本壳形状逐个收编。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../../src/studio/server/index.js'
import { makeDualTrackWorkdir } from '../studio/fixtures.js'
import { e2ePort } from './e2e-ports.js'
// R0910-W：临时目录清理走重试封装（Windows 句柄异步收尾的 ENOTEMPTY/EPERM/EBUSY）
import { rmTempDirRetry } from './tmp-cleanup.js'

export interface IndependentServer {
  /** 相对 CLW_E2E_PORT_BASE 的偏移（偏移表见 e2e-ports.ts） */
  readonly offset: number
  readonly port: number
  /** http://127.0.0.1:<port>（spec 内 page.goto 用；不再有 baseURL 缺省可用） */
  readonly base: string
  readonly workDir: string
  /** 未建时为 ''（opts.userDataPath === false） */
  readonly userDataPath: string
  /** 关 server → 还原 env → 删自建目录（幂等调用无误；重复删因 force 视作成功） */
  close(): Promise<void>
}

export interface StartIndependentServerOptions {
  /** spec 短名（EADDRINUSE 提示里标来源；惯例同 attachPageErrorBaseline 的 specTag） */
  tag: string
  /** 端口偏移，须在 e2e-ports.ts 偏移表登记（越界由 e2ePort fail-fast 拦住） */
  offset: number
  /** 自建 workDir（需播种文件时传入）；传入后清理归调用方，本壳不删 */
  workDir?: string
  /** 自建 userDataPath；缺省本壳建临时目录（隔离事件库/prefs，不落真实用户档），
   *  false = 不传（需「无 userDataPath」语义的场景：需审计端点恒空/共享面无事件库） */
  userDataPath?: string | false
  /** 额外 env（起服前生效、close 时还原）；值为 undefined 表示「本次会话内删除该键」 */
  env?: Record<string, string | undefined>
}

export async function startIndependentServer(opts: StartIndependentServerOptions): Promise<IndependentServer> {
  const { tag, offset } = opts
  const port = e2ePort(offset)
  const base = `http://127.0.0.1:${port}`

  // ① env 存取还原（CLWRITING_DRIVER 固定参与——driver 选择在 startServer 内求值）
  const extra = opts.env ?? {}
  const prevEnv = new Map<string, string | undefined>([['CLWRITING_DRIVER', process.env['CLWRITING_DRIVER']]])
  for (const key of Object.keys(extra)) prevEnv.set(key, process.env[key])
  const restoreEnv = (): void => {
    for (const [key, value] of prevEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  const ownsWorkDir = opts.workDir === undefined
  const workDir = opts.workDir ?? makeDualTrackWorkdir()
  const userDataPath =
    opts.userDataPath === false ? '' : (opts.userDataPath ?? mkdtempSync(join(tmpdir(), `clwriting-e2e-${tag}-ud-`)))
  const cleanup = (): void => {
    restoreEnv()
    if (userDataPath) rmTempDirRetry(userDataPath)
    if (ownsWorkDir) rmTempDirRetry(workDir)
  }

  process.env['CLWRITING_DRIVER'] = 'mock'
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  const server = startServer({
    port,
    workDir,
    ...(userDataPath ? { userDataPath } : {}),
    staticDir: join(process.cwd(), 'dist', 'web'),
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve())
      // ③ 固定端口被占给指因人话提示（X-36③ global-setup 口径；win 上 lsof 是死指引）
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          const probe =
            process.platform === 'win32'
              ? `netstat -ano | findstr :${port} 查占用 PID 后 taskkill /PID <pid> /F`
              : `lsof -i :${port} 查占用进程并 kill`
          console.error(
            `[e2e ${tag}] 端口 ${port} 已被占用（偏移 ${offset}）——通常是上一次 e2e 未退干净或本地 dev 服务抢占。\n` +
              `排查：${probe}；整族端口被争用时可用 CLW_E2E_PORT_BASE=<基址> 整套平移（偏移表见 test/e2e/e2e-ports.ts）。`,
          )
        }
        // ② 监听失败不留残：先清本次自建目录 + 还原 env 再上抛
        reject(err)
      })
    })
  } catch (err) {
    cleanup()
    throw err
  }

  return {
    offset,
    port,
    base,
    workDir,
    userDataPath,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      cleanup()
    },
  }
}

/**
 * studio server 启动共享核心（阶段 22 批 U1，微决策 U-3）。
 *
 * server-main（node 直跑，e2e release-smoke 用）与 server-utility（Electron
 * utilityProcess 子进程入口）两形态的参数组装 / 启动事件信封化收敛到此单一真相源，
 * 反对两入口各自复制参数解析（漂移先例：U-3 立项动机）。
 *
 * 纯函数 + 依赖注入（startServer/setInitialBook 可换假件），两入口等价性由
 * test/desktop/server-boot.test.ts 锚定。行为红线：缺省值与拆分前逐字不变——
 * --token/--book/--dir/--mirror-console 缺省时 startServer 收到 undefined，
 * 走其内部缺省（randomUUID / 不设初始书 / welcome 态 / mirrorConsoleLog=true）。
 */
import type http from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { startServer as defaultStartServer, type StudioServerOptions } from '../studio/server/index.js'
import { setInitialBook as defaultSetInitialBook } from '../studio/server/api/books.js'

/** argv 解析结果；mirrorConsole 三态（null = 未传 flag，透传 undefined 走 startServer 缺省）。 */
export interface ParsedServerArgs {
  port: number
  /** --dir；null = welcome 态（与拆分前 startServer({workDir:null}) 等价，S-8） */
  workDir: string | null
  /** --user-data；null = 未提供（server-main 形态自行补 defaultUserDataPath()） */
  userDataPath: string | null
  /** --book；null = 不设初始书 */
  book: string | null
  /** --token；null = 每次随机生成（缺省行为不变，U-6 注入态由 server-manager 恒传） */
  token: string | null
  /** --mirror-console 标志；null = 未传 */
  mirrorConsole: boolean | null
}

function argValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag)
  return i !== -1 && i + 1 < argv.length ? (argv[i + 1] ?? null) : null
}

/** 解析 --dir/--user-data/--port/--token/--book/--mirror-console；未识别参数忽略。 */
export function parseServerArgs(argv: string[], opts?: { portDefault?: number }): ParsedServerArgs {
  const portRaw = argValue(argv, '--port')
  const port = portRaw !== null ? Number(portRaw) : NaN
  return {
    port: Number.isFinite(port) ? port : (opts?.portDefault ?? 0),
    workDir: argValue(argv, '--dir'),
    userDataPath: argValue(argv, '--user-data'),
    book: argValue(argv, '--book'),
    token: argValue(argv, '--token'),
    mirrorConsole: argv.includes('--mirror-console') ? true : null,
  }
}

/** boot-error 信封：EADDRINUSE 给可读中文（server-main.ts 拆分前口径原样保留）。 */
export interface BootErrorEnvelope {
  code: string
  message: string
}

export function describeBootError(err: unknown, port: number): BootErrorEnvelope {
  const code = (err as NodeJS.ErrnoException | null)?.code ?? 'UNKNOWN'
  if (code === 'EADDRINUSE') {
    return {
      code,
      message: `端口 ${port} 已被占用（EADDRINUSE），请释放占用进程或用 --port 换端口`,
    }
  }
  return { code, message: `server 启动失败：${err instanceof Error ? err.message : String(err)}` }
}

/** 静态前端目录：相对编译产物入口（dist/web）派生——打包 asar 与开发态同款（R-6 先例）。 */
export function deriveStaticDir(moduleUrl: string): string {
  return join(dirname(fileURLToPath(moduleUrl)), '..', 'web')
}

export interface BootServerDeps {
  /** 缺省真实 startServer；测试注入假件（不 vi.mock 整模块） */
  startServer?: (opts: StudioServerOptions) => http.Server
  /** 缺省真实 setInitialBook（--book 下沉：child 在 startServer 前调，U-1 附带） */
  setInitialBook?: (name: string) => void
}

export interface BootCallbacks {
  /** listening 后回调实际监听端口（--port 0 随机端口时与配置值不同） */
  onReady: (port: number) => void
  /** 监听失败（EADDRINUSE 等）——替代拆分前各入口自挂的 reject/exit 路径 */
  onBootError: (err: unknown) => void
}

/**
 * 按解析参数起 server 并把 listening/error 事件信封化回调（两入口共用）。
 * 调用序铁律：--book 时 setInitialBook 必须先于 startServer（等价拆分前 main.ts
 * bootstrap 中 setInitialBook → startServer 的顺序，测试锚定）。
 * error 监听在 startServer 返回后挂——与拆分前两入口一致（listen 同步发起、
 * 'error' 异步派发，安全窗口成立）。
 */
export function bootServerFromArgs(
  parsed: ParsedServerArgs,
  staticDir: string,
  cb: BootCallbacks,
  deps: BootServerDeps = {},
): http.Server {
  const startServerImpl = deps.startServer ?? defaultStartServer
  const setInitialBookImpl = deps.setInitialBook ?? defaultSetInitialBook
  if (parsed.book) setInitialBookImpl(parsed.book)
  const server = startServerImpl({
    port: parsed.port,
    staticDir,
    workDir: parsed.workDir,
    userDataPath: parsed.userDataPath,
    mirrorConsoleLog: parsed.mirrorConsole ?? undefined,
    studioToken: parsed.token ?? undefined,
  })
  server.once('listening', () => {
    const addr = server.address()
    if (addr && typeof addr === 'object') cb.onReady(addr.port)
    else cb.onBootError(new Error('无法获取监听端口'))
  })
  server.once('error', (err: unknown) => cb.onBootError(err))
  return server
}

/**
 * （二十五轮批 A）：系统字体列表 TTL 缓存（main 进程侧，降半档）。
 *
 * desktop:get-system-fonts 每次调用都真跑 font-list 的系统命令（mac osascript /
 * win 注册表枚举），百毫秒级且结果在一次会话内基本不变。前端 useSystemFonts 已有
 * 会话级单例缓存，本模块补主进程侧缺口：渲染层重载（设置弹窗重开）/ 第二窗口再次
 * invoke 时的重复系统命令。
 *
 * 语义：TTL 内命中缓存；过期/未缓存真跑 loader；并发调用合并为同一在途 Promise
 * （双窗口同拍拉取只跑一次系统命令）。loader 失败不缓存（无负缓存）——首次失败
 * 照抛（调用方 main.ts catch 后返回 [] 的兜底语义不变）；（-⑥）补
 * serve-stale：已持有过期缓存时重载失败不再作废回 []，回吐旧值且不刷 cachedAt
 * （下次调用仍重试探测——瞬时故障只降级一次可见性，不丢好数据）。
 * ttlMs/now 可注入（测试用，不动生产语义）。
 */
import { spawn } from 'node:child_process'
import { join, sep } from 'node:path'
import { testableConst } from '../shared/testable.js'

interface SystemFontCacheOptions {
  /** 缓存存活期；缺省 60s（字体安装属低频事件，60s 内的陈旧可接受）。 */
  ttlMs?: number
  /** 时钟源（测试注入用）。 */
  now?: () => number
}

export function createSystemFontCache(
  load: () => Promise<string[]>,
  opts?: SystemFontCacheOptions,
): () => Promise<string[]> {
  const ttl = opts?.ttlMs ?? 60_000
  const now = opts?.now ?? Date.now
  let cached: string[] | null = null
  let cachedAt = 0
  let inflight: Promise<string[]> | null = null
  return async () => {
    if (cached !== null && now() - cachedAt < ttl) return cached
    if (inflight) return inflight
    inflight = load()
      .then((fonts) => {
        cached = fonts
        cachedAt = now()
        return fonts
      })
      .catch((e: unknown) => {
        // （-⑥）：serve-stale——TTL 过期后的重载失败此前直穿 reject，
        // 调用方兜底 []（手里明明有 60s 前的好列表也整场作废，字体下拉空到下次
        // 成功探测）。持有过期缓存时回吐旧值；不刷 cachedAt（下次调用仍重试，
        // 瞬时故障不固化为新 TTL）。首次（无缓存）维持 reject——负缓存仍不设。
        if (cached !== null) return cached
        throw e
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }
}

// ── ：mac/linux font-list 调用超时 ─────────────────────

/** font-list 枚举超时（毫秒）——10s 对齐 win-fonts 的缺省超时档
 *  （win 走 listWindowsFonts 自带超时 + kill，不经本包裹）。 */
export const FONT_LIST_TIMEOUT_MS = 10_000

/** 三件套换装 testableConst 工厂：生效值 getter（消费点显式调用）+ 测试注入 setter 元组第二位（原名原签名，测试面零感知）。 */
export const [getFontListTimeoutMs, __setFontListTimeoutForTest] = testableConst(FONT_LIST_TIMEOUT_MS)

// ── （审查）：探测熔断 + 超时必杀 ─────────────

/**
 * 探测熔断阈值——连续失败（含超时/命令异常）达到该次数后，本进程内不再重试
 * 探测，直接 reject，走调用方（main.ts）既有 catch → 返回 [] 的降级，契约不变。
 * 档位 2：首败可能是瞬时抖动，连败两次即认定会话内环境性故障（挂起的系统命令不会
 * 在毫秒级自愈）。与 journal.ts 同模式：常量 + 内部可变生效值 + 注入钩子。
 */
const FONT_PROBE_BREAKER_THRESHOLD = 2

/** 三件套换装 testableConst 工厂：生效值 getter（消费点显式调用）+ 测试注入 setter 元组第二位（原名原签名，测试面零感知），生产恒用常量档。 */
export const [getFontProbeBreakerThreshold, __setFontProbeBreakerThresholdForTest] =
  testableConst(FONT_PROBE_BREAKER_THRESHOLD)

/** 连续失败计数（模块级 = 进程级：会话内系统字体环境只有一份，跨 cache 实例共享）。 */
let fontProbeConsecutiveFailures = 0

/** 测试注入钩子（生产零调用）：清零失败计数并还原阈值常量档（用例间隔离）。 */
export function __resetFontListBreakerForTest(): void {
  fontProbeConsecutiveFailures = 0
  __setFontProbeBreakerThresholdForTest(FONT_PROBE_BREAKER_THRESHOLD)
}

/** 熔断为什么是进程级——系统字体列表在一次会话内不会自愈：osascript/字体
 *  枚举二进制/PowerShell 挂起或失败通常是持久性的（系统服务损坏、安全软件拦截、PATH
 *  被裁剪），进程内隔一会重试只会再付一次满额超时；而字体下拉在设置弹窗每次重开都会
 *  触发（font-cache 失败不缓存），无熔断时每次都重新 spawn + 等满超时档，子进程残留
 *  与等待惩罚无上界。进程级熔断把最坏代价封顶为「阈值 × 超时档」，此后调用即时降级。
 *  只挡「缓存 miss 后的探测」：TTL 命中与在途合并（createSystemFontCache）先于本判断
 *  结算，命中路径不受熔断影响。win 的 listWindowsFonts 自带超时 kill 不动
 *  （起 listWindowsFonts 内部亦套用本熔断——PS 挂死连败达阈值后同样秒降级，
 *  不再每次重开下拉等满 10s），熔断面覆盖三平台探测。 */
export async function fontListProbeWithBreaker(run: () => Promise<string[]>): Promise<string[]> {
  if (fontProbeConsecutiveFailures >= getFontProbeBreakerThreshold()) {
    throw new Error(`系统字体探测连续失败 ${fontProbeConsecutiveFailures} 次，本进程已熔断跳过重探（重启应用后重试）`)
  }
  try {
    const fonts = await run()
    fontProbeConsecutiveFailures = 0 // 成功清零：偶发失败不累积成熔断
    return fonts
  } catch (e) {
    fontProbeConsecutiveFailures++
    throw e
  }
}

/** 子进程句柄的最小面（测试注入用；生产 spawn 返回的 ChildProcess 结构性满足——win-fonts.ts 同口径）。 */
export interface FontListSpawnChild {
  stdout?: { on(event: 'data', cb: (d: Buffer) => void): unknown } | null
  stderr?: { on(event: 'data', cb: (d: Buffer) => void): unknown } | null
  on(event: 'error', cb: (err: Error) => void): unknown
  on(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'close', cb: (code: number | null) => void): unknown
  /** 超时强杀用；测试假件可不实现（无 kill 时仅放弃等待，win-fonts 同口径）。 */
  kill?(signal?: NodeJS.Signals): boolean | undefined
}

export type FontListSpawn = (cmd: string, args: string[], opts: { windowsHide: boolean }) => FontListSpawnChild

/** fontListWithTimeout 注入面——全部可选，缺省 = 原行为（load 路径，零变化）。 */
interface FontListWithTimeoutDeps {
  /** 自管 spawn 的枚举命令（测试注入 node -e 跨平台假命令形态）；注入后超时必杀子进程。
   *  缺省不 spawn：font-list 不暴露子进程句柄，load 路径超时只能放弃等待（原语义）。 */
  command?: string
  /** 自管命令参数；缺省 []（node -e 形态即 ['-e', script]）。 */
  args?: string[]
  /** 输出解析口径；缺省 process.platform（darwin 按 font-list 包内 fontlist 二进制行口径，其余按 fc-list 行口径）。 */
  platform?: NodeJS.Platform
  /** spawn 注入（测试计数断言用）；仅 command 注入时生效。 */
  spawnImpl?: FontListSpawn
  /** 自管路径超时毫秒；缺省 fontListTimeoutMs 生效值。load 路径恒用该生效值（与一致）。 */
  timeoutMs?: number
}

/** spawn 启动面失败（ENOENT/EACCES 等）标记——区别于「命令跑了但失败/超时」。 */
interface FontListSetupError extends Error {
  fontListSetupFailure?: boolean
}

/** 骨架子进程句柄的最小结构面——两调用方
 *  注入接口（本模块 FontListSpawnChild / win-fonts FontSpawnChild）的结构交集，两接口
 *  均结构性满足，现有测试假件不改语义直接可用（生产 spawn 返回的 ChildProcess 同满足）。 */
interface SpawnCollectChild {
  stdout?: { on(event: 'data', cb: (d: Buffer) => void): unknown } | null
  stderr?: { on(event: 'data', cb: (d: Buffer) => void): unknown } | null
  on(event: 'error', cb: (err: Error) => void): unknown
  on(event: 'close', cb: (code: number | null) => void): unknown
  /** C201：SIGKILL 升级链的撤销挂点（生产 ChildProcess 原生有；测试假件可不实现）。 */
  once?(event: 'close', cb: () => void): unknown
  kill?(signal?: NodeJS.Signals): boolean | undefined
}

/** C201：SIGTERM → SIGKILL 升级窗（毫秒）——对齐 server-proc
 *  killProcAwaitEscalating 的 2s 有界窗；窗内 close 未到即二次收口。 */
const FONT_KILL_ESCALATION_MS = 2_000

/**
 * windowsHide spawn → Buffer[] 收集 →
 * setTimeout 超时 kill → error 监听 → close 结算的公共骨架单源——font-cache 自管枚举
 * （runFontListCommandWithKill）与 win-fonts PowerShell 枚举（listWindowsFonts 内层
 * Promise）此前两份逐字同构骨架收编于此（win-fonts 保留平台守卫/PS 脚本常量/熔断
 * 包装在调用方）。差异面全参数化：超时/退出码文案（两调用方各留原文案，测试锚定）、
 * kill 信号（缺省 SIGTERM）、启动面标记（font-list 回落链专用）、结算解析回调。
 * 纪律单点：windowsHide = libuv CREATE_NO_WINDOW（GUI 主进程起控制台程序不闪窗，
 * win-fonts / 本模块同款）；数组参数不经 shell；Buffer[] 整流一次解码
 * 防多字节字体名跨 chunk 边界劈成 U+FFFD（同口径）；结算统一在 close（stdio
 * 收尾后触发，输出收完再解析）。原 font-cache 版的 noop 'exit' 监听随收编取消
 * （EventEmitter 语义下未监听的 exit 无副作用，纯注释性消纳）。
 * 注入接口兼容：FontListSpawnChild/FontSpawnChild 现有测试（pm12-font-list-kill /
 * win-fonts）不改语义只按需改导入。
 */
interface SpawnCollectKillParams {
  /** spawn 实现（生产 = node:child_process spawn 包装；测试注入计数/假件）。 */
  doSpawn: (cmd: string, args: string[], opts: { windowsHide: boolean }) => SpawnCollectChild
  /** 超时毫秒。 */
  timeoutMs: number
  /** 超时 reject 文案（调用方自带档位插值）。 */
  timeoutMessage: string
  /** 超时 kill 信号；缺省 SIGTERM（win 上等价 TerminateProcess，同口径）。 */
  killSignal?: NodeJS.Signals
  /** 非 0 退出码错误文案前缀（拼 `…退出码 N[：stderr 前 200 字]`）。 */
  exitCodeErrorPrefix: string
  /** spawn error 打「启动面」标记（fontListSetupFailure，font-list 回落链消费）；win 侧不标。 */
  markSetupFailure?: boolean
  /** close(0) 结算的 stdout 解码；缺省 UTF-8（toString('utf8')）。
   * 重评二轮-：reg.exe 等按控制台 OEM 码页
   *  落字节的命令需注入码页感知解码（严格 UTF-8 试解失败回落 GBK，见 win-fonts.ts
   *  decodeRegOutput）——骨架原固定 toString('utf8') 把 zh-CN 机器 reg 输出的中文字体名
   *  整面解成 U+FFFD（本机字节级实证）。PS/fontlist 通道自设 UTF-8 输出不注入，缺省
   *  行为零变化。 */
  decodeStdout?: (buf: Buffer) => string
  /** close(0) 结算解析：入参 = 整流解码后的 stdout 原文。 */
  parse: (stdout: string) => string[]
}

export function spawnCollectKillFonts(command: string, args: string[], p: SpawnCollectKillParams): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    let settled = false
    const child = p.doSpawn(command, args, { windowsHide: true })
    const outParts: Buffer[] = []
    const errParts: Buffer[] = []
    child.stdout?.on('data', (d) => {
      outParts.push(d)
    })
    child.stderr?.on('data', (d) => {
      errParts.push(d)
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      // 超时必杀（缺省 SIGTERM；win 上等价 TerminateProcess）——不 kill 则挂起
      // 命令成孤儿进程。kill 已退出进程的 ESRCH：同步 throw 由 try/catch 吞掉；异步
      // 形态（退出与 kill 竞态）走下方 error 监听（settled 后吞）。
      try {
        child.kill?.(p.killSignal ?? 'SIGTERM')
      } catch {
        /* ESRCH：进程已退出 */
      }
      // C201：SIGKILL 升级链——SIGTERM 单发对装了 TERM handler 或
      // 陷入不可中断态的子进程不成杀（孤儿存续到父进程退出），与本仓 server-proc 的
      // killProcAwaitEscalating（TERM → 2s → KILL）纪律对齐：有界窗内 close 未到即
      // 二次收口 SIGKILL（KILL 不可被用户态拦截）。close 的结算监听在下方，此处 once
      // 仅负责撤销升级定时器（假件无 once 时跳过撤销——定时器后触发打已死进程，ESRCH
      // 由 try/catch 吞掉，无副作用）；窗内子进程正常退出则升级不发生。
      const escalate = setTimeout(() => {
        try {
          child.kill?.('SIGKILL')
        } catch {
          /* ESRCH：进程已退出 */
        }
      }, FONT_KILL_ESCALATION_MS)
      escalate.unref()
      child.once?.('close', () => clearTimeout(escalate))
      reject(new Error(p.timeoutMessage))
    }, p.timeoutMs)
    // error 必监听——超时 kill 打在已退出进程上会异步抛 ESRCH（往已关流写则
    // EPIPE），无监听即 uncaughtException 崩主进程。已结算则吞掉；未结算 = 命令起不来
    // （ENOENT/EACCES 等启动面），markSetupFailure 时打标记 reject 供上层回落 load
    // （font-list 对二进制缺失自有回落链，保持其可达）。
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (p.markSetupFailure) {
        const tagged = err as FontListSetupError
        tagged.fontListSetupFailure = true
        reject(tagged)
      } else {
        reject(err)
      }
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      if (code !== 0) {
        const errText = Buffer.concat(errParts).toString('utf8').trim()
        reject(
          new Error(`${p.exitCodeErrorPrefix}退出码 ${code ?? 'null'}${errText ? `：${errText.slice(0, 200)}` : ''}`),
        )
        return
      }
      const out = Buffer.concat(outParts)
      resolve(p.parse(p.decodeStdout ? p.decodeStdout(out) : out.toString('utf8')))
    })
  })
}

/**
 * 自管 spawn 的字体枚举——子进程句柄在手，超时必杀；输出处理逐字对齐
 * font-list 上游（darwin 包内 fontlist 二进制 / linux fc-list 的行口径 + standardize
 * disableQuoting + 大小写不敏感排序），注入同形输出的命令即得同形结果。
 * spawn-collect-kill 骨架收编为 spawnCollectKillFonts 单源，本函数只
 * 剩 font-list 侧参数（启动面标记 + darwin/linux 行口径解析回调）。
 */
function runFontListCommandWithKill(command: string, args: string[], deps: FontListWithTimeoutDeps): Promise<string[]> {
  const timeoutMs = deps.timeoutMs ?? getFontListTimeoutMs()
  const platform = deps.platform ?? process.platform
  const doSpawn: FontListSpawn = deps.spawnImpl ?? ((cmd, a, opts) => spawn(cmd, a, opts))
  return spawnCollectKillFonts(command, args, {
    doSpawn,
    timeoutMs,
    timeoutMessage: `font-list 字体枚举超过 ${timeoutMs}ms 未返回，已中止等待并终止子进程`,
    exitCodeErrorPrefix: 'font-list 字体枚举',
    markSetupFailure: true,
    parse: (raw) => parseFontListStdout(raw, platform),
  })
}

/**
 * font-list standardize 的 disableQuoting 移植单源（win-fonts.ts
 * 同款逐字双实现收编——本模块导出，win-fonts 消费）：\uXXXX 解码 + 剥包裹引号。
 */
export function bareFontName(rawLine: string): string {
  const unescaped = rawLine.replace(/\\u([\da-f]{4})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
  if (unescaped.length >= 2 && unescaped.startsWith('"') && unescaped.endsWith('"')) {
    return unescaped.slice(1, -1)
  }
  return unescaped
}

/**
 * font-list core.getFonts 的排序口径单源（剥前导引号后大小写
 * 不敏感；主序比较器形态同上游）——win-fonts.ts 的内联比较器随批收编为消费本导出。
 * nano ：原恒 -1/1——等价名（剥引号+小写后相等）也返回 1，
 * 非严格弱序（等价类内不对称），Array.sort 下等价名内部次序随输入序漂移不稳定。
 * 等价时按原字符串比较作 tie-break（仍等则 0），成严格弱序；行为面仅内部次序
 * 确定化，登记/输出集合与主序（大小写不敏感）不变。
 */
export function compareFontNames(a: string, b: string): number {
  const na = a.replace(/^['"]+/, '').toLocaleLowerCase()
  const nb = b.replace(/^['"]+/, '').toLocaleLowerCase()
  if (na === nb) return a < b ? -1 : a > b ? 1 : 0 // nano ：等价名按原串 tie-break
  return na < nb ? -1 : 1
}

/** 自管命令 stdout → 字体名数组（逐字对齐 font-list 上游各平台分支的行处理）。 */
function parseFontListStdout(raw: string, platform: NodeJS.Platform): string[] {
  let fonts: string[]
  if (platform === 'darwin') {
    // font-list libs/darwin getByExecFile 口径：按行 → 去重 → 滤空与 iconfont 例外（不 trim，同上游）
    fonts = Array.from(new Set(raw.split('\n'))).filter((i) => i !== '' && i !== 'iconfont')
  } else {
    // font-list libs/linux 口径：按行 → 滤空 → 去重
    fonts = Array.from(new Set(raw.split('\n').filter((f) => f !== '')))
  }
  // core.getFonts({ disableQuoting: true }) 收尾：standardize（解码 + 剥引号）+ 排序
  return fonts.map(bareFontName).sort(compareFontNames)
}

/**
 * /：darwin 自管 spawn 的
 * fontlist 二进制解析——bundle 同伴定位 + asar 外置路径改写（main.ts loadFontList 接线用，
 * 拍板项随本批落地）。两个形态：
 * - dev/直跑：bundleDir = dist/desktop（main bundle 的目录），二进制由 tsup onSuccess
 *   拷入同目录，路径原样可用；
 * - 打包态：dist/** 进 asar 后 spawn 不认 asar 内路径（execFile 有 Electron 补丁、
 *   spawn 没有）——electron-builder asarUnpack 把 dist/desktop/fontlist 外置到
 * app.asar.unpacked/ 同相对位（：asar 内路径带 dist/ 段，上批裸
 *   desktop/fontlist 零命中），同相对位替换取真路径。
 * 任一形态的启动面失败（ENOENT/EACCES）都由 fontListWithTimeout 的
 * fontListSetupFailure 回落链兜住（回落 load → font-list 自带 system_profiler），
 * 本函数只负责给出正确的第一优先路径。纯函数（路径字符串进出），直测钉两形态。
 */
export function darwinFontListCommand(bundleDir: string): { command: string; args: string[] } {
  const bin = join(bundleDir, 'fontlist')
  const marker = `app.asar${sep}`
  // sep 锚定目录分隔（防「app.asar」恰为文件名前缀的误替换）；dev 形态不含 marker 原样返回
  const command = bin.includes(marker) ? bin.replace(marker, `app.asar.unpacked${sep}`) : bin
  return { command, args: [] }
}

/**
 * C201：linux 自管 fc-list 命令形态——把 darwin 已接线的超时必杀
 * 自管 spawn 骨架推广到 linux（此前 linux 维持 load 路径：font-list 不暴露子进程
 * 句柄，fc-list 挂死时超时只放弃等待、子进程成孤儿，连 SIGTERM 都没有）。
 * 命令与参数对 font-list libs/linux 上游逐字对齐（`fc-list -f "%{family[0]}\n"`——
 * 上游经 exec shell 剥引号，fc-list 实参 = `%{family[0]}\n` 字面反斜杠 n；spawn
 * 数组参数不经 shell，args 直接给同一字面量）；stdout 行口径解析复用
 * parseFontListStdout(raw, 'linux')（已逐字对齐上游 split/filter/去重
 * + standardize disableQuoting + 排序）。fc-list 缺失（ENOENT 启动面）→
 * fontListSetupFailure → fontListWithTimeout 回落 load——上游的 `whereis fc-list /
 * fc-list2` 兜底探测链由回落保持可达。纯函数（常量进出），直测钉形态。
 */
export function linuxFontListCommand(): { command: string; args: string[] } {
  return { command: 'fc-list', args: ['-f', '%{family[0]}\\n'] }
}

/** 原实现抽提（load 路径：font-list 不暴露子进程句柄，超时只放弃等待），文案与语义零变化。 */
function fontListLoadWithTimeout(load: () => Promise<string[]>): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`font-list 字体枚举超过 ${getFontListTimeoutMs()}ms 未返回，已放弃等待`))
    }, getFontListTimeoutMs())
    load().then(
      (fonts) => {
        clearTimeout(timer)
        resolve(fonts)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/**
 * font-list 调用的超时包裹——mac/linux 分支（main.ts loadFontList）
 * 此前裸调 getSystemFontList，osascript/系统命令挂起时 Promise 永不结算，字体下拉
 * 悬死且（font-cache 失败不缓存）每次重开再起一个挂起命令。
 *
 * （审查）补两口：
 * ① 超时必杀：注入 deps.command 时切自管 spawn——超时回调 child.kill（SIGTERM），
 * error/exit 监听消纳 kill 竞态（ESRCH/EPIPE）不成 uncaughtException；缺省（不注入）
 *   维持原语义：load（font-list）不暴露子进程句柄，超时只放弃等待。
 * ② 会话级熔断：全路径套 fontListProbeWithBreaker，连续失败 ≥ 阈值后本进程不再重试，
 * 直接 reject 走调用方既有降级（main.ts catch → []），只挡缓存 miss 后的探测。
 *
 * win 平台评估结论：win-fonts.ts 已自带 10s 超时 + child.kill（SIGTERM，win 上
 * TerminateProcess），仓库无 taskkill 分支（仅 e2e global-setup 有手工排查提示语），
 * 保留不改写；本函数自管路径同样统一 SIGTERM 口径，不引入 taskkill。
 *
 * 接线沿革：生产接线（main.ts loadFontList）曾不传 deps——超时必杀路径生产不可达，
 * 接线待拍板；现已接线收口：mac 侧 main.ts 注入 darwinFontListCommand(here)（随包
 * 二进制 + asarUnpack 外置见 tsup.config.ts / electron-builder.yml），超时必杀生产
 * 生效、启动面失败回落 load；linux 亦改注入
 * linuxFontListCommand（fc-list 挂死时 load 路径不暴露子进程句柄、子进程成孤儿
 * ——自管 spawn 超时 TERM→2s→KILL 升级链收口，ENOENT 自动回落 load），接线点在
 * ipc.ts loadFontList。会话级熔断
 * （fontListProbeWithBreaker）生产持续生效（缺省路径即包裹），win 侧
 * listWindowsFonts 亦套用。打包态实测复验登记台账（build:desktop:dir + DMG 手验）。
 */
export function fontListWithTimeout(load: () => Promise<string[]>, deps?: FontListWithTimeoutDeps): Promise<string[]> {
  return fontListProbeWithBreaker(() => {
    const command = deps?.command
    if (!command) return fontListLoadWithTimeout(load)
    const args = deps?.args ?? []
    return runFontListCommandWithKill(command, args, { ...deps, command }).catch((err: FontListSetupError) => {
      // 命令起不来（启动面，如打包态 asar 内二进制不可执行）→ 回落 load——
      // font-list 对二进制缺失有自己的回落链（darwin 退 system_profiler 管道），保持
      // 其可达 = 与纯 font-list 行为一致；「命令跑了但失败/超时」不回落。
      if (!err.fontListSetupFailure) throw err
      return fontListLoadWithTimeout(load)
    })
  })
}

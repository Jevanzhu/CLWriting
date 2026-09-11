/**
 * MP2-1（专项重评二轮修复批）：win 系统字体自绘枚举——不经 cmd、不闪窗。
 *
 * font-list 上游 win32 路径 getByPowerShell 用 `exec('chcp 65001|powershell -command …')`
 * 起 PowerShell：exec 经 cmd.exe 且未设 windowsHide，win 打包态（GUI 子系统主进程）
 * 打开设置弹窗字体下拉（首次拉取 / font-cache 60s TTL 过期后重拉）即闪控制台黑窗。
 * 项目自身子进程纪律（git 双入口 R1W-8 统一 windowsHide + 数组参数免 shell）在本
 * 模块对齐到字体枚举：spawn('powershell.exe', [args], { windowsHide: true }) 直起、
 * 数组参数不经 shell。PowerShell 脚本对齐 font-list 口径（PresentationCore
 * SystemFontFamilies，zh-cn 族名回落 en-us）；后处理 = font-list standardize 的
 * disableQuoting 裸名移植（\uXXXX 解码 + 剥包裹引号 + 大小写不敏感排序），调用方
 * （main.ts 的 font-cache loader）拿到的形态与 font-list({ disableQuoting: true })
 * 一致，前端消费方零改动。
 *
 * 失败语义：spawn 失败 / 非 0 退出 / 超时 → 抛错（与 font-list 抛错同口径），由调用方
 * catch 返回 []（font-cache 不缓存失败）。win 实机闪窗形态复验挂账（本机 macOS
 * 静态实证 + 上游源码核实，见二轮报告 §九）。
 *
 * R39-2（三十九轮）：stdout/stderr 改 Buffer[] 收集 + close 时整流一次解码——逐
 * chunk toString('utf8') 会把被切在 chunk 边界上的多字节字符（CJK 字体族名 3 字节/字）
 * 各自解成 U+FFFD，中文字体名乱码且无报错；对齐 server-manager.ts splitLines 的
 * setEncoding 跨边界安全口径。R39-5：10s 超时兜底——PS 挂死（PSModulePath 损坏/
 * 杀软拦截）时 Promise 永不结算且失败不入缓存（font-cache），每次重开字体下拉再
 * spawn 一个 powershell，句柄累积；超时 kill + reject。
 *
 * R48-72（四十八轮）：bareFontName/排序比较器与 font-cache.ts 逐字双实现收编——
 * 删本地副本改消费 font-cache 导出（单源），口径零变化。
 * R48-74（四十八轮）：枚举整体套 fontListProbeWithBreaker（进程级会话熔断）——PS
 * 挂死时连败达阈值后本进程秒降级，不再每次重开下拉等满 10s（与 mac/linux 熔断面
 * 对齐）；R39-5 自身超时 kill 不动。
 * R0912-A-P3-3（2026-09-12 独立重评修复批）：spawn→收集→超时 kill→结算骨架与
 * font-cache 自管枚举收编为 spawnCollectKillFonts 单源（font-cache.ts），本模块保留
 * 平台守卫 / PS 脚本常量 / 熔断包装与 win 侧文案；注入接口 FontSpawn/FontSpawnChild
 * 不变，既有测试零语义改动。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { bareFontName, compareFontNames, fontListProbeWithBreaker, spawnCollectKillFonts } from './font-cache.js'

/** PowerShell 枚举脚本（对齐 font-list getByPowerShell：chcp 65001 + UTF-8 输出编码）。 */
const PS_FONT_SCRIPT = [
  'chcp 65001|Out-Null',
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName PresentationCore',
  '$families=[Windows.Media.Fonts]::SystemFontFamilies',
  "foreach($family in $families){$name='';if(!$family.FamilyNames.TryGetValue([Windows.Markup.XmlLanguage]::GetLanguage('zh-cn'),[ref]$name)){$name=$family.FamilyNames[[Windows.Markup.XmlLanguage]::GetLanguage('en-us')]}echo $name}",
].join(';')

/** 子进程句柄的最小面（测试注入用；生产 spawn 返回的 ChildProcess 结构性满足）。 */
export interface FontSpawnChild {
  stdout?: { on(event: 'data', cb: (d: Buffer) => void): unknown } | null
  stderr?: { on(event: 'data', cb: (d: Buffer) => void): unknown } | null
  on(event: 'error', cb: (err: Error) => void): unknown
  on(event: 'close', cb: (code: number | null) => void): unknown
  /** 超时强杀用（R39-5）；生产 ChildProcess 自带，测试假件可不实现（无 kill 时仅放弃等待）。 */
  kill?(signal?: NodeJS.Signals): boolean | undefined
}

export type FontSpawn = (cmd: string, args: string[], opts: { windowsHide: boolean }) => FontSpawnChild

export interface ListWindowsFontsDeps {
  /** 平台注入（测试用；生产走 process.platform，仅 win32 走本枚举）。 */
  platform?: NodeJS.Platform
  /** spawn 注入（测试用）。 */
  spawnImpl?: FontSpawn
  /** 枚举超时毫秒（R39-5，测试注入用）；缺省 10s。超时 kill 子进程并 reject。 */
  timeoutMs?: number
}

/** R38-21：SystemRoot 绝对路径兜底（SystemRoot 是 Windows 系统必需环境变量，恒在）。 */
function resolvePowershellExe(): string {
  const sysRoot = process.env['SystemRoot'] ?? process.env['windir']
  if (sysRoot) {
    const abs = join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (existsSync(abs)) return abs
  }
  return 'powershell.exe'
}

/** PowerShell stdout → 字体名数组（R0912-A-P3-3 起为 spawnCollectKillFonts 骨架的结算
 *  回调）：PowerShell UTF-8 输出可能带 BOM 前导（Console.OutputEncoding 初始化）剥一次；
 *  font-list standardize 的 disableQuoting 移植口径（裸名 + 滤空）。 */
function parsePowerShellFontStdout(out: string): string[] {
  const fonts = out
    .replace(/^\uFEFF/, '')
    .split('\n')
    .map((ln) => bareFontName(ln.trim()))
    .filter((f) => f !== '')
  // R48-72（四十八轮）：排序口径消费 font-cache 单源导出（原内联比较器逐字同款）
  fonts.sort(compareFontNames)
  return fonts
}

export async function listWindowsFonts(deps: ListWindowsFontsDeps = {}): Promise<string[]> {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') {
    throw new Error(`listWindowsFonts 只服务 win32（收到 ${platform}）——非 win 平台由调用方走 font-list`)
  }
  const doSpawn: FontSpawn = deps.spawnImpl ?? ((cmd, args, opts) => spawn(cmd, args, opts))
  // R38-21（三十八轮）：powershell.exe 依赖 PATH 解析——异常裁剪的 PATH 环境下 ENOENT
  // → 调用方 catch 得空字体表（静默降级）。SystemRoot 恒在（Windows 系统必需环境变量），
  // 据此拼绝对路径兜底；解析优先级：绝对路径存在 → 用之，否则回退 PATH 裸名。
  const psExe = resolvePowershellExe()
  const timeoutMs = deps.timeoutMs ?? 10_000
  // R48-74（四十八轮）：整体套进程级会话熔断——连败达阈值（font-cache PM-12 档 2）
  // 后本进程不再重探，直接 reject 走调用方（main.ts）catch → [] 降级；成功清零计数。
  // 平台守卫在熔断判断之外（非 win 调用属编程错误，不消耗熔断计数）。
  // R0912-A-P3-3（2026-09-12 独立重评修复批）：windowsHide spawn → Buffer[] 收集 →
  // 超时 kill → error/close 结算骨架收编为 font-cache spawnCollectKillFonts 单源
  // （windowsHide + 数组参数不经 shell 纪律随骨架单点化），本函数保留平台守卫 /
  // PS 脚本常量 / 熔断包装与 win 文案（超时/退出码，测试锚定）；R39-5 超时 kill 语义
  // 不变（骨架缺省 SIGTERM，win 上等价原 kill() 的 TerminateProcess）。
  return await fontListProbeWithBreaker(
    () =>
      spawnCollectKillFonts(psExe, ['-NoProfile', '-NonInteractive', '-Command', PS_FONT_SCRIPT], {
        doSpawn,
        timeoutMs,
        timeoutMessage: `powershell 字体枚举超过 ${timeoutMs}ms 未退出，已中止`,
        exitCodeErrorPrefix: 'powershell 字体枚举',
        parse: parsePowerShellFontStdout,
      }),
  )
}

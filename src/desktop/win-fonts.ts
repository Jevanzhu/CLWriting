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
 */
import { spawn } from 'node:child_process'

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

/** font-list standardize 的 disableQuoting 移植：\uXXXX 解码 + 剥包裹引号。 */
function bareFontName(rawLine: string): string {
  const unescaped = rawLine.replace(/\\u([\da-f]{4})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
  if (unescaped.length >= 2 && unescaped.startsWith('"') && unescaped.endsWith('"')) {
    return unescaped.slice(1, -1)
  }
  return unescaped
}

export async function listWindowsFonts(deps: ListWindowsFontsDeps = {}): Promise<string[]> {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') {
    throw new Error(`listWindowsFonts 只服务 win32（收到 ${platform}）——非 win 平台由调用方走 font-list`)
  }
  const doSpawn: FontSpawn = deps.spawnImpl ?? ((cmd, args, opts) => spawn(cmd, args, opts))
  const timeoutMs = deps.timeoutMs ?? 10_000
  return await new Promise<string[]>((resolve, reject) => {
    // windowsHide: true = libuv CREATE_NO_WINDOW——GUI 子系统主进程起控制台程序的
    // 闪窗治本位（与 git/exec.ts R1W-8 同纪律）；数组参数免 shell，不经 cmd.exe。
    const child = doSpawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_FONT_SCRIPT], {
      windowsHide: true,
    })
    // R39-2：整流解码——收 Buffer[] 拼接后一次 toString，防多字节字符跨 chunk 边界劈成 U+FFFD
    const outParts: Buffer[] = []
    const errParts: Buffer[] = []
    child.stdout?.on('data', (d) => {
      outParts.push(d)
    })
    child.stderr?.on('data', (d) => {
      errParts.push(d)
    })
    // R39-5：超时兜底（kill 缺席的测试假件仅放弃等待，Promise 仍按 reject 结算）
    const timer = setTimeout(() => {
      try {
        child.kill?.()
      } catch {
        /* 已退出 */
      }
      reject(new Error(`powershell 字体枚举超过 ${timeoutMs}ms 未退出，已中止`))
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const out = Buffer.concat(outParts).toString('utf8')
      const err = Buffer.concat(errParts).toString('utf8')
      if (code !== 0) {
        reject(new Error(`powershell 字体枚举退出码 ${code ?? 'null'}${err ? `：${err.trim().slice(0, 200)}` : ''}`))
        return
      }
      // PowerShell UTF-8 输出可能带 BOM 前导（Console.OutputEncoding 初始化），剥一次
      const fonts = out
        .replace(/^\uFEFF/, '')
        .split('\n')
        .map((ln) => bareFontName(ln.trim()))
        .filter((f) => f !== '')
      // font-list core 的排序口径移植（剥前导引号后大小写不敏感；比较器恒 -1/1 同款）
      fonts.sort((a, b) =>
        a.replace(/^['"]+/, '').toLocaleLowerCase() < b.replace(/^['"]+/, '').toLocaleLowerCase() ? -1 : 1,
      )
      resolve(fonts)
    })
  })
}

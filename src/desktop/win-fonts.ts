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
 * 失败语义：spawn 失败 / 非 0 退出 → 抛错（与 font-list 抛错同口径），由调用方
 * catch 返回 []（font-cache 不缓存失败）。win 实机闪窗形态复验挂账（本机 macOS
 * 静态实证 + 上游源码核实，见二轮报告 §九）。
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
}

export type FontSpawn = (cmd: string, args: string[], opts: { windowsHide: boolean }) => FontSpawnChild

export interface ListWindowsFontsDeps {
  /** 平台注入（测试用；生产走 process.platform，仅 win32 走本枚举）。 */
  platform?: NodeJS.Platform
  /** spawn 注入（测试用）。 */
  spawnImpl?: FontSpawn
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
  return await new Promise<string[]>((resolve, reject) => {
    // windowsHide: true = libuv CREATE_NO_WINDOW——GUI 子系统主进程起控制台程序的
    // 闪窗治本位（与 git/exec.ts R1W-8 同纪律）；数组参数免 shell，不经 cmd.exe。
    const child = doSpawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_FONT_SCRIPT], {
      windowsHide: true,
    })
    let out = ''
    let err = ''
    child.stdout?.on('data', (d) => {
      out += d.toString('utf8')
    })
    child.stderr?.on('data', (d) => {
      err += d.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => {
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

/**
 * MP2-1（专项重评二轮修复批）：win 字体自绘枚举——windowsHide 纪律 + font-list
 * 口径移植（\uXXXX 解码 / 剥引号 / 大小写不敏感排序）。
 *
 * font-list 上游 getByPowerShell 经 cmd.exe exec 未设 windowsHide，win 打包态闪黑窗；
 * 本测试对修复面（spawn 直起 + windowsHide: true + 数组参数）与解析面逐项断言。
 * 平台/spawn 均注入，不依赖真 win 环境（win 实机闪窗形态复验挂账，报告 §九）。
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { listWindowsFonts, type FontSpawn, type FontSpawnChild } from '../../src/desktop/win-fonts.js'
import { __resetFontListBreakerForTest } from '../../src/desktop/font-cache.js'

// R48-74（四十八轮）：listWindowsFonts 内部套进程级会话熔断（font-cache 模块级失败
// 计数跨用例累积，阈值 2）——用例间清零并还原阈值档，失败类用例不污染后续用例。
beforeEach(() => {
  __resetFontListBreakerForTest()
})

interface FakeChild extends FontSpawnChild {
  emitClose(code: number | null): void
  emitError(err: Error): void
}

function makeFakeChild(): FakeChild {
  const handlers = {
    error: [] as Array<(err: Error) => void>,
    close: [] as Array<(code: number | null) => void>,
  }
  const child = {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    // 对象字面量里写两个同名 `on` 方法重载会被后者静默覆盖（JS 无重载）——error
    // 处理器全部漏注册，reject 被当 close 回调误调。必须单方法按事件名分发。
    on(event: string, cb: (...args: never[]) => void): unknown {
      if (event === 'error') handlers.error.push(cb as (err: Error) => void)
      else handlers.close.push(cb as (code: number | null) => void)
      return child
    },
    emitClose(code: number | null) {
      for (const cb of handlers.close) cb(code)
    },
    emitError(err: Error) {
      for (const cb of handlers.error) cb(err)
    },
  }
  return child
}

function run(stdout: string, opts?: { code?: number; stderr?: string }) {
  const calls: Array<{ cmd: string; args: string[]; opts: { windowsHide: boolean } }> = []
  let child: FakeChild | null = null
  const spawnImpl: FontSpawn = (cmd, args, spOpts) => {
    calls.push({ cmd, args, opts: spOpts })
    child = makeFakeChild()
    return child
  }
  const promise = listWindowsFonts({ platform: 'win32', spawnImpl })
  const c = child!
  // 接口面 FontSpawnChild.stdout 只有 on('data')，注入实现是 PassThrough——收窄回写端
  const so = c.stdout as PassThrough
  const se = c.stderr as PassThrough
  so.write(stdout, 'utf8')
  so.end()
  if (opts?.stderr) {
    se.write(opts.stderr, 'utf8')
    se.end()
  }
  c.emitClose(opts?.code ?? 0)
  return { promise, calls }
}

describe('MP2-1：win 字体枚举 spawn 纪径（windowsHide + 数组参数直起）', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('spawn powershell.exe 数组参数且 windowsHide: true（不经 cmd、CREATE_NO_WINDOW）', async () => {
    // R38-21：SystemRoot 兜底解析——本用例钉 PATH 裸名形态，清空 SystemRoot/windir
    //（win CI 实机 SystemRoot 恒在会解析出绝对路径，破坏裸名断言）
    vi.stubEnv('SystemRoot', '')
    vi.stubEnv('windir', '')
    const { promise, calls } = run('Arial\n')
    await promise
    expect(calls).toHaveLength(1)
    expect(calls[0]!.cmd).toBe('powershell.exe')
    expect(calls[0]!.args[0]).toBe('-NoProfile')
    expect(calls[0]!.args[1]).toBe('-NonInteractive')
    expect(calls[0]!.args[2]).toBe('-Command')
    // 脚本口径对齐 font-list：SystemFontFamilies 枚举 + zh-cn 回落 en-us + UTF-8 输出
    expect(calls[0]!.args[3]).toContain('[Windows.Media.Fonts]::SystemFontFamilies')
    expect(calls[0]!.args[3]).toContain("GetLanguage('zh-cn')")
    expect(calls[0]!.args[3]).toContain("GetLanguage('en-us')")
    expect(calls[0]!.args[3]).toContain('[System.Text.Encoding]::UTF8')
    expect(calls[0]!.opts.windowsHide).toBe(true) // 修复点：闪窗治本位
  })

  it('R38-21: SystemRoot 绝对路径兜底——System32/WindowsPowerShell/v1.0/powershell.exe 存在即用之（PATH 裁剪环境不再 ENOENT 空表）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psroot-'))
    const psDir = join(root, 'System32', 'WindowsPowerShell', 'v1.0')
    mkdirSync(psDir, { recursive: true })
    writeFileSync(join(psDir, 'powershell.exe'), '')
    vi.stubEnv('SystemRoot', root)
    const { promise, calls } = run('Arial\n')
    await promise
    expect(calls[0]!.cmd).toBe(join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
    expect(calls[0]!.opts.windowsHide).toBe(true)
  })

  it('R38-21: SystemRoot 指向不存在目录 → 回退 PATH 裸名（确定性降级）', async () => {
    vi.stubEnv('SystemRoot', join(tmpdir(), 'psroot-missing-xx'))
    const { promise, calls } = run('Arial\n')
    await promise
    expect(calls[0]!.cmd).toBe('powershell.exe')
  })

  it('解析口径 = font-list disableQuoting 移植：\\uXXXX 解码 + 剥引号 + 大小写不敏感排序', async () => {
    const stdout = '"Helvetica Neue"\r\n\\U559c\\U9e4a\r\nArial\r\n\r\n'
    const { promise } = run(stdout)
    await expect(promise).resolves.toEqual(['Arial', 'Helvetica Neue', '喜鹊']) // 修复点：口径一致
  })

  it('PowerShell UTF-8 BOM 前导剥除（首字体名不被 \uFEFF 前缀污染）', async () => {
    const { promise } = run('\uFEFF"Microsoft YaHei"\r\nSimSun\r\n')
    await expect(promise).resolves.toEqual(['Microsoft YaHei', 'SimSun'])
  })

  it('非 0 退出码 → 抛错（调用方 catch 返回 []，与 font-list 失败同口径）', async () => {
    const { promise } = run('', { code: 1, stderr: 'Add-Type 异常' })
    await expect(promise).rejects.toThrow(/退出码 1.*Add-Type 异常/)
  })

  it('spawn error 事件透传拒绝', async () => {
    const child = makeFakeChild()
    const promise = listWindowsFonts({ platform: 'win32', spawnImpl: () => child })
    child.emitError(new Error('spawn ENOENT'))
    await expect(promise).rejects.toThrow('spawn ENOENT')
  })

  it('非 win32 平台守卫：抛错（平台分支归 main.ts，win-fonts 只服务 win）', async () => {
    await expect(listWindowsFonts({ platform: 'darwin' })).rejects.toThrow('只服务 win32')
  })
})

describe('R39-2/R39-5（三十九轮）：整流解码 + 超时兜底', () => {
  it('跨 chunk 多字节字符整流解码（中文字体名被切在 chunk 边界不成 U+FFFD）', async () => {
    let child: FakeChild | null = null
    const spawnImpl: FontSpawn = (cmd, args, opts) => {
      void cmd
      void args
      void opts
      child = makeFakeChild()
      return child
    }
    const promise = listWindowsFonts({ platform: 'win32', spawnImpl })
    const c = child!
    const so = c.stdout as PassThrough
    const full = Buffer.from('"微软雅黑"\r\nSimSun\r\n', 'utf8')
    // 修复前形态：多字节字符中段切两笔（软 = bytes 4-6，切点 5 落字中）——逐 chunk
    // toString('utf8') 会把「软」劈成 U+FFFD；整流后逐字节还原
    so.write(full.subarray(0, 5))
    so.write(full.subarray(5))
    so.end()
    c.emitClose(0)
    await expect(promise).resolves.toEqual(['SimSun', '微软雅黑'])
  })

  it('超时 kill + reject（PS 挂死不再永占 IPC/累积句柄；kill 缺席的假件仅放弃等待）', async () => {
    let killed = 0
    const child = makeFakeChild()
    ;(child as FakeChild & { kill: (s?: string) => boolean }).kill = () => {
      killed++
      return true
    }
    const promise = listWindowsFonts({ platform: 'win32', spawnImpl: () => child, timeoutMs: 25 })
    await expect(promise).rejects.toThrow(/25ms 未退出/)
    expect(killed).toBe(1)
  })
})

// R48-74（四十八轮）：win 枚举套进程级会话熔断——PS 挂死连败达阈值后秒降级，不再
// 每次重开下拉等满 10s（与 mac/linux 熔断面对齐）；自身超时 kill 行为不变。
describe('R48-74：win 枚举套进程级会话熔断', () => {
  it('连败 2 次达阈值 → 第三次调用秒拒熔断错（spawn 不再被触达）', async () => {
    await expect(run('', { code: 1 }).promise).rejects.toThrow(/退出码 1/)
    await expect(run('', { code: 1 }).promise).rejects.toThrow(/退出码 1/)
    // 熔断态在 spawn 之前即拒：run 假件（同步 emitClose 流程）不适用，用计数 spawn 直证
    let spawnCount = 0
    const promise = listWindowsFonts({
      platform: 'win32',
      spawnImpl: () => {
        spawnCount++
        return makeFakeChild()
      },
    })
    await expect(promise).rejects.toThrow(/连续失败 2 次.*熔断/)
    expect(spawnCount).toBe(0)
  })

  it('成功清零计数——失败→成功→失败序列逐次真探（偶发失败不累积成熔断）', async () => {
    await expect(run('', { code: 1 }).promise).rejects.toThrow(/退出码 1/)
    await expect(run('Arial\n').promise).resolves.toEqual(['Arial'])
    await expect(run('', { code: 1 }).promise).rejects.toThrow(/退出码 1/)
  })

  it('平台守卫抛错不消耗熔断计数（守卫在熔断判断之外）', async () => {
    await expect(listWindowsFonts({ platform: 'darwin' })).rejects.toThrow('只服务 win32')
    await expect(listWindowsFonts({ platform: 'darwin' })).rejects.toThrow('只服务 win32')
    // 两次守卫抛错后计数仍为 0：真实失败一次即报原始错误（非熔断错）
    await expect(run('', { code: 1 }).promise).rejects.toThrow(/退出码 1/)
  })
})

/**
 * MP2-1（专项重评二轮修复批）：win 字体自绘枚举——windowsHide 纪律 + font-list
 * 口径移植（\uXXXX 解码 / 剥引号 / 大小写不敏感排序）。
 *
 * font-list 上游 getByPowerShell 经 cmd.exe exec 未设 windowsHide，win 打包态闪黑窗；
 * 本测试对修复面（spawn 直起 + windowsHide: true + 数组参数）与解析面逐项断言。
 * 平台/spawn 均注入，不依赖真 win 环境（win 实机闪窗形态复验挂账，报告 §九）。
 */
import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { listWindowsFonts, type FontSpawn, type FontSpawnChild } from '../../src/desktop/win-fonts.js'

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
  it('spawn powershell.exe 数组参数且 windowsHide: true（不经 cmd、CREATE_NO_WINDOW）', async () => {
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

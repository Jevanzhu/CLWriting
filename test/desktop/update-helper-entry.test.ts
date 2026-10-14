/**
 * 阶段 55：main.ts 顶部的**助手态分流**——带 `--apply-update` 启动时绝不进入应用形态。
 *
 * 为什么这是硬判据（而不是「顺手测一下」）：助手是「旧应用已退出、新版未就位」窗口里
 * 唯一活着的进程。它一旦按应用形态跑起来（setPath / 请求单实例锁 / fork server / 建窗），
 * 就会与马上要被换名的目录纠缠出双开、锁冲突与半截界面——这正是分流存在的理由。
 *
 * 手法：`process.exit` 打桩成抛错，在分流出口处**截断模块求值**（生产口径是
 * app.exit + process.exit 双发，先到者终止进程；截断本身即判据——其后的装配面一行都
 * 不该跑到）。runUpdateHelper 打桩（真跑会去换真目录），argv 解析走真件。
 */
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { deadPid } from '../helpers/dead-pid.js'
import { M, mkTmp, captureMainTestEnvPrev, cleanupMainTmpDirs, restoreMainTestEnv } from './main-fixtures.js'
import {
  installMainProcessListenerHarness,
  removeTrackedProcessListeners,
  restoreMainProcessListenerHarness,
} from './main-process-harness.js'

installMainProcessListenerHarness()
const prevEnv = captureMainTestEnvPrev()
const prevNoAsar = (process as { noAsar?: boolean }).noAsar
const prevCwd = process.cwd()

afterAll(() => {
  removeTrackedProcessListeners()
  restoreMainProcessListenerHarness()
  restoreMainTestEnv(prevEnv)
  if (prevNoAsar === undefined) delete (process as { noAsar?: boolean }).noAsar
  else (process as { noAsar?: boolean }).noAsar = prevNoAsar
  process.chdir(prevCwd)
  cleanupMainTmpDirs()
})

const helperCalls = vi.hoisted(() => ({
  invocations: [] as Array<Record<string, unknown>>,
  outcome: 'applied' as 'applied' | 'aborted' | 'rolled-back',
  /** 助手被调用时刻的 process.noAsar——解压写 resources/app.asar 的成活判据（win 真机实测） */
  noAsarAtRun: null as boolean | null,
  /** 助手被调用时刻的 cwd——目标目录改名不被自身 cwd 占住的前提（win 真机实测） */
  cwdAtRun: null as string | null,
}))
vi.mock('../../src/desktop/update-helper.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/desktop/update-helper.js')>()
  return {
    ...actual,
    runUpdateHelper: async (inv: Record<string, unknown>) => {
      helperCalls.invocations.push(inv)
      helperCalls.noAsarAtRun = (process as { noAsar?: boolean }).noAsar ?? null
      helperCalls.cwdAtRun = process.cwd()
      return helperCalls.outcome
    },
  }
})

/** 以给定 argv 导入 main.js：分流出口的 process.exit 抛错即「截断」信号 */
async function importMainWithArgv(argv: string[]): Promise<Error> {
  const argvPrev = process.argv
  process.argv = argv
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('__helper_exit__')
  }) as never)
  vi.resetModules()
  try {
    await import('../../src/desktop/main.js')
    throw new Error('main.js 未被截断（分流出口没走到）')
  } catch (e) {
    return e as Error
  } finally {
    process.argv = argvPrev
    exitSpy.mockRestore()
  }
}

describe('助手态分流（--apply-update）', () => {
  it('完整 argv：跑助手→app.exit(0)，装配面（setPath/锁/server/窗/whenReady）一行未跑', async () => {
    helperCalls.invocations.length = 0
    const home = mkTmp('clw-upd-entry-')
    const appsParent = mkTmp('clw-upd-apps-')
    const targetDir = join(appsParent, 'CLWriting')
    const logDir = join(home, 'instances', 'welcome', 'logs')
    const pid = deadPid()
    const before = {
      windows: M.windows.length,
      forks: M.forkCalls.length,
      whenReady: M.whenReadyCalls,
      setPaths: JSON.stringify(M.setPaths),
      initLogging: M.initLoggingCalls.length,
      httpBits: M.ipcHandle['desktop:open-external'] ? 1 : 0,
      flushLogs: M.flushLogsCalls,
      exitCodes: M.exitCodes.length,
    }
    const err = await importMainWithArgv([
      'CLWriting.exe',
      '--apply-update',
      '--payload',
      '/tmp/缓存/pkg.zip',
      '--target',
      targetDir,
      '--pid',
      String(pid),
      '--from-version',
      '1.0.0-rc.4',
      '--to-version',
      '1.0.0',
      '--home',
      home,
      '--log-dir',
      logDir,
    ])
    expect(err.message).toBe('__helper_exit__')
    expect(helperCalls.invocations).toHaveLength(1)
    expect(helperCalls.invocations[0]).toMatchObject({
      payloadZip: '/tmp/缓存/pkg.zip',
      targetDir,
      pid,
      fromVersion: '1.0.0-rc.4',
      toVersion: '1.0.0',
      homeDir: home,
      logDir,
    })
    // 结局 applied → 退出码 0（app.exit 捕获面）
    expect(M.exitCodes.at(-1)).toBe(0)
    // 助手日志目录挂上了（唯一一次 initLogging——应用形态那次没发生）
    expect(M.initLoggingCalls.length).toBe(before.initLogging + 1)
    expect(M.initLoggingCalls.at(-1)?.logsDir).toBe(logDir)
    // asar 层已关（助手进程写 resources/app.asar 的成活前提——win 真机实测的必败点）
    expect(helperCalls.noAsarAtRun).toBe(true)
    // 助手 cwd 已挪出目标目录（cwd 占住目录会让目标目录改名 EBUSY——win 真机实测）。
    // 两侧先取真身再比：macOS 的 /var 是指向 /private/var 的符号链接，process.cwd()
    // 回的是解析后形态，而 tmpdir() 给的路径不解析——字串直比在 mac 恒不等。
    expect(realpathSync(String(helperCalls.cwdAtRun)).toLowerCase()).toBe(realpathSync(appsParent).toLowerCase())
    // 修复 D：退出前等过日志泵（恰一次，且发生在本次 exit 之前——结局行/错误行不随
    // process.exit 丢，这是助手无控制台下唯一的过程证据）
    expect(M.flushLogsCalls).toBe(before.flushLogs + 1)
    expect(M.exitCodesAtFlush.at(-1)).toBe(before.exitCodes)
    // 应用装配面全未触达
    expect(M.windows.length).toBe(before.windows)
    expect(M.forkCalls.length).toBe(before.forks)
    expect(M.whenReadyCalls).toBe(before.whenReady)
    expect(JSON.stringify(M.setPaths)).toBe(before.setPaths)
    expect(M.ipcHandle['desktop:open-external'] ? 1 : 0).toBe(before.httpBits)
  })

  it('带旗但参数不全：记 error 后退出码 2，不跑助手、同样不落回应用形态', async () => {
    helperCalls.invocations.length = 0
    const before = { windows: M.windows.length, forks: M.forkCalls.length, logs: M.logErrors.length, flushLogs: M.flushLogsCalls }
    const err = await importMainWithArgv(['CLWriting.exe', '--apply-update', '--payload', '/tmp/pkg.zip'])
    expect(err.message).toBe('__helper_exit__')
    expect(M.exitCodes.at(-1)).toBe(2)
    expect(helperCalls.invocations).toHaveLength(0)
    expect(M.logErrors.length).toBe(before.logs + 1)
    expect(M.flushLogsCalls).toBe(before.flushLogs) // 未起助手、未挂文件 sink——无需等泵
    expect(M.windows.length).toBe(before.windows)
    expect(M.forkCalls.length).toBe(before.forks)
  })

  it('结局非 applied（rolled-back）→ 退出码 3（退出码即「本轮更新没成」的进程级信号）', async () => {
    helperCalls.outcome = 'rolled-back'
    const home = mkTmp('clw-upd-entry3-')
    try {
      const err = await importMainWithArgv([
        'CLWriting.exe',
        '--apply-update',
        '--payload',
        '/tmp/pkg.zip',
        '--target',
        '/apps/CLWriting',
        '--pid',
        String(deadPid()),
        '--from-version',
        '1.0.0-rc.4',
        '--to-version',
        '1.0.0',
        '--home',
        home,
      ])
      expect(err.message).toBe('__helper_exit__')
      expect(M.exitCodes.at(-1)).toBe(3)
    } finally {
      helperCalls.outcome = 'applied'
    }
  })
})

/**
 * 阶段 55：更新助手（目录替换执行者）——真文件系统 + 真解压（`src/update/extract`），
 * 便携包用本仓诊断包写入器现造（store zip），进程存活/拉起/时钟走注入桩。
 *
 * 判据锚在**盘面终态**上：applied ⟺ 目标目录内容已是新版且旧版整目录留在 `.old-`；
 * aborted ⟺ 目标目录逐字节未动；rolled-back ⟺ 目标目录恢复为旧版。结果条（跨进程
 * 信箱）与拉起调用面同批断言——它们是新进程唯一的现场来源。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tempDirTracked } from '../helpers/temp-dir.js'
import { buildZipStore } from '../../src/diagnostics/zip.js'
import { readUpdateAttemptNote } from '../../src/update/cache.js'
import {
  otherInstancesRunning,
  parseApplyUpdateArgv,
  recoverInterruptedSwap,
  runUpdateHelper,
  type ApplyUpdateInvocation,
  type UpdateHelperDeps,
} from '../../src/desktop/update-helper.js'

const OLD_VERSION = '1.0.0-rc.4'
const NEW_VERSION = '1.0.0'

interface Scene {
  root: string
  appDir: string
  home: string
  zipPath: string
  sha: string
}

/** 场景：旧应用目录（含假 exe）+ 便携包（含新版假 exe）+ 共享根 */
function makeScene(): Scene {
  const root = tempDirTracked('clw-upd-helper-')
  const appDir = join(root, 'app')
  mkdirSync(appDir, { recursive: true })
  writeFileSync(join(appDir, 'CLWriting.exe'), 'old-exe')
  writeFileSync(join(appDir, 'resources.txt'), 'old-resources')
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  const zipPath = join(root, 'CLWriting-1.0.0-x64.zip')
  writeFileSync(
    zipPath,
    buildZipStore([
      { name: 'CLWriting.exe', data: 'new-exe' },
      { name: 'resources/app.asar', data: 'new-asar' },
    ]),
  )
  const sha = createHash('sha256').update(readFileSync(zipPath)).digest('hex')
  return { root, appDir, home, zipPath, sha }
}

function invocation(s: Scene, over: Partial<ApplyUpdateInvocation> = {}): ApplyUpdateInvocation {
  return {
    payloadZip: s.zipPath,
    targetDir: s.appDir,
    // 缺省给一个不可能存活的 pid（真判据走注入桩；这里只是让默认值自洽）
    pid: 999_999_999,
    fromVersion: OLD_VERSION,
    toVersion: NEW_VERSION,
    relaunchArgs: [],
    exePath: null,
    sha256: s.sha,
    homeDir: s.home,
    logDir: null,
    ...over,
  }
}

/** 缺省桩：旧进程已死、不真睡、拉起成功（记录调用面） */
function stubs(over: Partial<UpdateHelperDeps> = {}): { deps: UpdateHelperDeps; spawned: string[][] } {
  const spawned: string[][] = []
  const deps: UpdateHelperDeps = {
    isProcessAlive: () => false,
    sleep: async () => {},
    spawnDetached: async (exe, args) => {
      spawned.push([exe, ...args])
      return true
    },
    ...over,
  }
  return { deps, spawned }
}

function exeOf(appDir: string): string {
  return readFileSync(join(appDir, 'CLWriting.exe'), 'utf-8')
}

describe('parseApplyUpdateArgv（助手 argv 解析）', () => {
  it('完整 argv → 调用对象（--dir 转为重启参数、试验性字段透传）', () => {
    const inv = parseApplyUpdateArgv([
      'CLWriting.exe',
      '--apply-update',
      '--payload',
      'C:/cache/pkg.zip',
      '--target',
      'C:/apps/CLWriting',
      '--pid',
      '4321',
      '--from-version',
      OLD_VERSION,
      '--to-version',
      NEW_VERSION,
      '--home',
      'C:/home',
      '--log-dir',
      'C:/home/instances/x/logs',
      '--sha256',
      'a'.repeat(64),
      '--dir',
      'D:/书库',
    ])
    expect(inv).toEqual({
      payloadZip: 'C:/cache/pkg.zip',
      targetDir: 'C:/apps/CLWriting',
      pid: 4321,
      fromVersion: OLD_VERSION,
      toVersion: NEW_VERSION,
      relaunchArgs: ['--dir', 'D:/书库'],
      exePath: null,
      sha256: 'a'.repeat(64),
      homeDir: 'C:/home',
      logDir: 'C:/home/instances/x/logs',
    })
  })

  it('无旗 → null；缺必需项/pid 非法 → null（调用方按「带旗不可解析」退出，不落回应用形态）', () => {
    expect(parseApplyUpdateArgv(['CLWriting.exe'])).toBeNull()
    expect(parseApplyUpdateArgv(['x', '--apply-update', '--target', 't'])).toBeNull()
    expect(
      parseApplyUpdateArgv([
        'x',
        '--apply-update',
        '--payload',
        'p',
        '--target',
        't',
        '--pid',
        '0',
        '--from-version',
        'a',
        '--to-version',
        'b',
      ]),
    ).toBeNull()
    // 旗后紧跟下一个旗（值为空）同样作废——防「--payload --target x」把旗名当路径
    expect(
      parseApplyUpdateArgv([
        'x',
        '--apply-update',
        '--payload',
        '--target',
        't',
        '--pid',
        '7',
        '--from-version',
        'a',
        '--to-version',
        'b',
      ]),
    ).toBeNull()
  })
})

describe('recoverInterruptedSwap（中断自愈）', () => {
  it('目标缺席 + .old- 残留 → 取 mtime 最新者还原', () => {
    const root = tempDirTracked('clw-upd-recover-')
    const target = join(root, 'app')
    const older = join(root, 'app.old-0.9.0')
    const newer = join(root, 'app.old-1.0.0-rc.4')
    mkdirSync(older, { recursive: true })
    mkdirSync(newer, { recursive: true })
    writeFileSync(join(newer, 'CLWriting.exe'), 'old-exe')
    // mtime 显式置位：同毫秒落盘时排序平局会取 readdir 序，判据退化为「看运气」
    utimesSync(older, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))
    utimesSync(newer, new Date('2026-01-02T00:00:00Z'), new Date('2026-01-02T00:00:00Z'))
    expect(recoverInterruptedSwap(target)).toBe(true)
    expect(readFileSync(join(target, 'CLWriting.exe'), 'utf-8')).toBe('old-exe')
    expect(existsSync(newer)).toBe(false) // 已改名回位
  })

  it('目标健在 → 不动（正常启动路径零副作用）', () => {
    const root = tempDirTracked('clw-upd-recover2-')
    const target = join(root, 'app')
    mkdirSync(target, { recursive: true })
    mkdirSync(join(root, 'app.old-9.9.9'), { recursive: true })
    expect(recoverInterruptedSwap(target)).toBe(false)
  })
})

describe('runUpdateHelper（换目录主流程）', () => {
  it('成功：新版就位、旧版整目录留 .old-、拉起新版、结果条 applied/ok', async () => {
    const s = makeScene()
    const { deps, spawned } = stubs()
    const outcome = await runUpdateHelper(invocation(s), deps)
    expect(outcome).toBe('applied')
    expect(exeOf(s.appDir)).toBe('new-exe')
    expect(readFileSync(join(s.appDir, 'resources/app.asar'), 'utf-8')).toBe('new-asar')
    const oldDir = `${s.appDir}.old-${OLD_VERSION}`
    expect(readFileSync(join(oldDir, 'CLWriting.exe'), 'utf-8')).toBe('old-exe')
    expect(existsSync(`${s.appDir}-new-${NEW_VERSION}`)).toBe(false) // 新版目录已被改名占位
    // 拉起的是目标目录内的 exe（新版）
    expect(spawned).toEqual([[join(s.appDir, 'CLWriting.exe')]])
    expect(readUpdateAttemptNote(s.home)).toMatchObject({
      outcome: 'applied',
      reason: 'ok',
      from: OLD_VERSION,
      to: NEW_VERSION,
    })
  })

  it('重启参数随拉起透传（--dir 书库），exePath 注入优先', async () => {
    const s = makeScene()
    const { deps, spawned } = stubs()
    await runUpdateHelper(invocation(s, { relaunchArgs: ['--dir', 'D:/书库'], exePath: 'E:/custom.exe' }), deps)
    expect(spawned).toEqual([['E:/custom.exe', '--dir', 'D:/书库']])
  })

  it('旧进程超期不退 → aborted/timeout：不换目录、不拉起（前台应用还在，再拉起就是双开）', async () => {
    const s = makeScene()
    const { deps, spawned } = stubs({
      isProcessAlive: () => true,
      now: (() => {
        let t = 0
        return () => (t += 5000)
      })(),
    })
    const outcome = await runUpdateHelper(invocation(s), deps)
    expect(outcome).toBe('aborted')
    expect(exeOf(s.appDir)).toBe('old-exe')
    expect(spawned).toEqual([])
    expect(readUpdateAttemptNote(s.home)).toMatchObject({ outcome: 'aborted', reason: 'timeout' })
  })

  it('旧进程中途退出 → 轮询等到它退再动手（等待期不是一次判定）', async () => {
    const s = makeScene()
    let polls = 0
    const { deps, spawned } = stubs({
      isProcessAlive: () => {
        polls += 1
        return polls < 3 // 前两次还在（等待期），第三次起已退
      },
    })
    const outcome = await runUpdateHelper(invocation(s), deps)
    expect(outcome).toBe('applied')
    expect(polls).toBeGreaterThanOrEqual(3)
    expect(exeOf(s.appDir)).toBe('new-exe')
    expect(spawned).toEqual([[join(s.appDir, 'CLWriting.exe')]])
  })

  it('其他实例在跑 → aborted/other-instances：不动目标目录，把旧应用还给用户', async () => {
    const s = makeScene()
    const { deps, spawned } = stubs({ instancesRunning: () => true })
    const outcome = await runUpdateHelper(invocation(s), deps)
    expect(outcome).toBe('aborted')
    expect(exeOf(s.appDir)).toBe('old-exe')
    expect(spawned).toEqual([[join(s.appDir, 'CLWriting.exe')]])
    expect(readUpdateAttemptNote(s.home)).toMatchObject({ outcome: 'aborted', reason: 'other-instances' })
  })

  it('包体 sha256 复核不符 → aborted/payload-corrupt（校验不过绝不解压）', async () => {
    const s = makeScene()
    const { deps } = stubs()
    const outcome = await runUpdateHelper(invocation(s, { sha256: 'f'.repeat(64) }), deps)
    expect(outcome).toBe('aborted')
    expect(exeOf(s.appDir)).toBe('old-exe')
    expect(existsSync(`${s.appDir}-new-${NEW_VERSION}`)).toBe(false)
    expect(readUpdateAttemptNote(s.home)).toMatchObject({ outcome: 'aborted', reason: 'payload-corrupt' })
  })

  it('包体缺失 → aborted/payload-missing：不动目标目录', async () => {
    const s = makeScene()
    const { deps } = stubs()
    const outcome = await runUpdateHelper(invocation(s, { payloadZip: join(s.root, 'missing.zip') }), deps)
    expect(outcome).toBe('aborted')
    expect(exeOf(s.appDir)).toBe('old-exe')
    expect(readUpdateAttemptNote(s.home)).toMatchObject({ outcome: 'aborted', reason: 'payload-missing' })
  })

  it('新版就位失败 → rolled-back/swap-failed：旧版已还原、无新版目录残片', async () => {
    const s = makeScene()
    // 模拟「解压产物在就位前消失/不可用」：新版目录在改名时已不存在（rename ENOENT）
    const { deps } = stubs({
      extract: async (_zip, dir) => {
        const { rmSync } = await import('node:fs')
        rmSync(dir, { recursive: true, force: true })
      },
    })
    const outcome = await runUpdateHelper(invocation(s), deps)
    expect(outcome).toBe('rolled-back')
    expect(exeOf(s.appDir)).toBe('old-exe') // 还原到旧版（用户下次双击可用）
    expect(existsSync(`${s.appDir}-new-${NEW_VERSION}`)).toBe(false)
    expect(existsSync(`${s.appDir}.old-${OLD_VERSION}`)).toBe(false) // 旧目录已改名回位
    expect(readUpdateAttemptNote(s.home)).toMatchObject({ outcome: 'rolled-back', reason: 'swap-failed' })
  })

  it('目标目录缺席 → aborted/target-missing（且先把 .old- 残留还原）', async () => {
    const s = makeScene()
    const { rmSync, renameSync } = await import('node:fs')
    // 造「已改名未就位」的中断现场
    renameSync(s.appDir, `${s.appDir}.old-${OLD_VERSION}`)
    const { deps } = stubs()
    const outcome = await runUpdateHelper(invocation(s, { payloadZip: join(s.root, 'missing.zip') }), deps)
    expect(outcome).toBe('aborted')
    // 还原发生了（旧版回了原位），随后因包体缺失中止
    expect(exeOf(s.appDir)).toBe('old-exe')
    expect(readUpdateAttemptNote(s.home)).toMatchObject({ outcome: 'aborted', reason: 'payload-missing' })
    void rmSync
  })

  it('上次失败留下的 -new- 半成品目录在本次起手被清掉（不带旧内容混入新版）', async () => {
    const s = makeScene()
    const newDir = `${s.appDir}-new-${NEW_VERSION}`
    mkdirSync(newDir, { recursive: true })
    writeFileSync(join(newDir, 'stale.txt'), 'stale')
    const { deps } = stubs()
    expect(await runUpdateHelper(invocation(s), deps)).toBe('applied')
    expect(exeOf(s.appDir)).toBe('new-exe')
    expect(existsSync(join(s.appDir, 'stale.txt'))).toBe(false)
  })

  it('解压失败 → aborted/extract-failed：目标目录未动、半成品目录清掉', async () => {
    const s = makeScene()
    const { deps } = stubs({
      extract: async () => {
        throw new Error('zip 损坏')
      },
    })
    const outcome = await runUpdateHelper(invocation(s), deps)
    expect(outcome).toBe('aborted')
    expect(exeOf(s.appDir)).toBe('old-exe')
    expect(existsSync(`${s.appDir}-new-${NEW_VERSION}`)).toBe(false)
    expect(readUpdateAttemptNote(s.home)).toMatchObject({ outcome: 'aborted', reason: 'extract-failed' })
  })

  it('拉起失败不影响 applied 结局（用户手动打开同样是新版），原因码如实标 relaunch-failed', async () => {
    const s = makeScene()
    const { deps } = stubs({ spawnDetached: async () => false })
    const outcome = await runUpdateHelper(invocation(s), deps)
    expect(outcome).toBe('applied')
    expect(exeOf(s.appDir)).toBe('new-exe')
    expect(readUpdateAttemptNote(s.home)).toMatchObject({ outcome: 'applied', reason: 'relaunch-failed' })
  })
})

describe('otherInstancesRunning（跨库多窗预检）', () => {
  function startInstance(home: string, key: string, pid: number): string {
    const dir = join(home, 'instances', key)
    mkdirSync(dir, { recursive: true })
    const lock = join(dir, 'app-instance.lock')
    writeFileSync(lock, JSON.stringify({ pid, bootTime: Date.now() }))
    return lock
  }

  it('活 pid 持锁 = 有实例；excludeKey 排除自身；死 pid 残留不算', () => {
    const home = tempDirTracked('clw-upd-instances-')
    expect(otherInstancesRunning(home)).toBe(false) // 无 instances/ 目录
    startInstance(home, 'aaa', process.pid)
    expect(otherInstancesRunning(home)).toBe(true)
    expect(otherInstancesRunning(home, 'aaa')).toBe(false) // 自身实例：点更新的是我自己
    const dead = startInstance(home, 'bbb', 999_999_999)
    expect(existsSync(dead)).toBe(true)
    expect(otherInstancesRunning(home, 'aaa')).toBe(false) // 死进程残留锁：不算在跑
  })
})

describe('助手默认值兜底', () => {
  it('exePath 缺省 = 目标目录内的 CLWriting.exe', async () => {
    const s = makeScene()
    const calls: string[] = []
    const deps: UpdateHelperDeps = {
      isProcessAlive: () => false,
      sleep: async () => {},
      spawnDetached: async (exe) => {
        calls.push(exe)
        return true
      },
    }
    await runUpdateHelper(invocation(s, { exePath: null }), deps)
    expect(calls[0]).toBe(join(s.appDir, 'CLWriting.exe'))
    expect(vi.isMockFunction(deps.spawnDetached)).toBe(false)
  })
})

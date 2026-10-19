/**
 * 阶段 55：更新助手（目录替换执行者）——真文件系统 + 真解压（`src/update/extract`），
 * 便携包用本仓诊断包写入器现造（store zip），进程存活/拉起/时钟走注入桩。
 *
 * 判据锚在**盘面终态**上：applied ⟺ 目标目录内容已是新版且旧版整目录留在 `.old-`；
 * aborted ⟺ 目标目录逐字节未动；rolled-back ⟺ 目标目录恢复为旧版。结果条（跨进程
 * 信箱）与拉起调用面同批断言——它们是新进程唯一的现场来源。
 *
 * 来源校验（助手 argv 是外部输入）：夹具必须自洽——包体落在共享根更新缓存内，助手镜像
 * 取当前场景应用目录内的 exe（就地形态）；不符形态与降级方向各有拒绝路径用例。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tempDirTracked } from '../helpers/temp-dir.js'
import { buildZipStore } from '../../src/diagnostics/zip.js'
import { readUpdateAttemptNote, takeUpdateAttemptNote, updateCacheDir, updateCacheRoot, updateResultPath, writeUpdateAttemptNote, type UpdateAttemptNote } from '../../src/update/cache.js'
import { type ExtractLimits } from '../../src/update/extract.js'
import {
  EXTRACT_BYTES_FACTOR,
  PORTABLE_EXE_NAME,
  RECOVER_UPDATE_FLAG,
  isRecoverUpdateInvocation,
  otherInstancesRunning,
  ownInstanceKeyOf,
  parseApplyUpdateArgv,
  recoverInterruptedSwap,
  runRecoverUpdateCli,
  runUpdateHelper,
  type ApplyUpdateInvocation,
  type UpdateHelperDeps,
} from '../../src/desktop/update-helper.js'
import { instanceKeyForDir } from '../../src/fs/user-data-path.js'

const OLD_VERSION = '1.0.0-rc.4'
const NEW_VERSION = '1.0.0'

interface Scene {
  root: string
  appDir: string
  home: string
  zipPath: string
  sha: string
}

/** 当前场景（`stubs` 取它拼助手镜像路径——每个用例都先 makeScene 再造桩） */
let activeScene: Scene | null = null

/** 场景：旧应用目录（含假 exe）+ 便携包（落在共享根更新缓存内）+ 共享根 */
function makeScene(): Scene {
  const root = tempDirTracked('clw-upd-helper-')
  const appDir = join(root, 'app')
  mkdirSync(appDir, { recursive: true })
  writeFileSync(join(appDir, PORTABLE_EXE_NAME), 'old-exe')
  writeFileSync(join(appDir, 'resources.txt'), 'old-resources')
  const home = join(root, 'home')
  const zipDir = updateCacheDir(home, NEW_VERSION)
  mkdirSync(zipDir, { recursive: true })
  const zipPath = join(zipDir, `CLWriting-${NEW_VERSION}-x64.zip`)
  writeFileSync(
    zipPath,
    buildZipStore([
      { name: PORTABLE_EXE_NAME, data: 'new-exe' },
      { name: 'resources/app.asar', data: 'new-asar' },
    ]),
  )
  const sha = createHash('sha256').update(readFileSync(zipPath)).digest('hex')
  const scene: Scene = { root, appDir, home, zipPath, sha }
  activeScene = scene
  return scene
}

/** 场景内更新缓存里的一个路径（校验只放行缓存内的包体） */
function cachePathOf(s: Scene, name: string): string {
  return join(updateCacheDir(s.home, NEW_VERSION), name)
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

/** 缺省桩：旧进程已死、不真睡、拉起成功（记录调用面）；助手镜像缺省 = 当前场景应用目录内的
 *  exe（就地形态——来源校验要求镜像目录与目标目录同源，假形态两不沾）。 */
function stubs(over: Partial<UpdateHelperDeps> = {}): { deps: UpdateHelperDeps; spawned: string[][] } {
  const spawned: string[][] = []
  const deps: UpdateHelperDeps = {
    isProcessAlive: () => false,
    sleep: async () => {},
    spawnDetached: async (exe, args) => {
      spawned.push([exe, ...args])
      return true
    },
    ...(activeScene ? { execPath: join(activeScene.appDir, PORTABLE_EXE_NAME) } : {}),
    ...over,
  }
  return { deps, spawned }
}

function exeOf(appDir: string): string {
  return readFileSync(join(appDir, PORTABLE_EXE_NAME), 'utf-8')
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
    writeFileSync(join(newer, PORTABLE_EXE_NAME), 'old-exe')
    // mtime 显式置位：同毫秒落盘时排序平局会取 readdir 序，判据退化为「看运气」
    utimesSync(older, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))
    utimesSync(newer, new Date('2026-01-02T00:00:00Z'), new Date('2026-01-02T00:00:00Z'))
    expect(recoverInterruptedSwap(target)).toBe(true)
    expect(readFileSync(join(target, PORTABLE_EXE_NAME), 'utf-8')).toBe('old-exe')
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
    expect(readFileSync(join(oldDir, PORTABLE_EXE_NAME), 'utf-8')).toBe('old-exe')
    expect(existsSync(`${s.appDir}-new-${NEW_VERSION}`)).toBe(false) // 新版目录已被改名占位
    // 拉起的是目标目录内的 exe（新版）
    expect(spawned).toEqual([[join(s.appDir, PORTABLE_EXE_NAME)]])
    expect(readUpdateAttemptNote(s.home)).toMatchObject({
      outcome: 'applied',
      reason: 'ok',
      from: OLD_VERSION,
      to: NEW_VERSION,
    })
  })

  it('暂存副本形态（助手镜像在 <home>/更新缓存/<版本>/helper）同样放行——这是控制器的装配形态', async () => {
    const s = makeScene()
    const stageDir = join(updateCacheDir(s.home, NEW_VERSION), 'helper')
    mkdirSync(stageDir, { recursive: true })
    writeFileSync(join(stageDir, PORTABLE_EXE_NAME), 'staged-helper')
    const { deps } = stubs({ execPath: join(stageDir, PORTABLE_EXE_NAME) })
    expect(await runUpdateHelper(invocation(s), deps)).toBe('applied')
    expect(exeOf(s.appDir)).toBe('new-exe')
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
    expect(spawned).toEqual([[join(s.appDir, PORTABLE_EXE_NAME)]])
  })

  it('其他实例在跑 → aborted/other-instances：不动目标目录，把旧应用还给用户', async () => {
    const s = makeScene()
    const { deps, spawned } = stubs({ instancesRunning: () => true })
    const outcome = await runUpdateHelper(invocation(s), deps)
    expect(outcome).toBe('aborted')
    expect(exeOf(s.appDir)).toBe('old-exe')
    expect(spawned).toEqual([[join(s.appDir, PORTABLE_EXE_NAME)]])
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
    const outcome = await runUpdateHelper(invocation(s, { payloadZip: cachePathOf(s, 'missing.zip') }), deps)
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
    const { renameSync } = await import('node:fs')
    // 造「已改名未就位」的中断现场
    renameSync(s.appDir, `${s.appDir}.old-${OLD_VERSION}`)
    const { deps } = stubs()
    const outcome = await runUpdateHelper(invocation(s, { payloadZip: cachePathOf(s, 'missing.zip') }), deps)
    expect(outcome).toBe('aborted')
    // 还原发生了（旧版回了原位），随后因包体缺失中止
    expect(exeOf(s.appDir)).toBe('old-exe')
    expect(readUpdateAttemptNote(s.home)).toMatchObject({ outcome: 'aborted', reason: 'payload-missing' })
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

  it('解压上限随包体下发（解压炸弹面：绝对红线由 extract 兜底）', async () => {
    const s = makeScene()
    const seen: Array<Partial<ExtractLimits> | undefined> = []
    const { deps } = stubs({
      extract: async (_zip, dir, limits) => {
        seen.push(limits)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, PORTABLE_EXE_NAME), 'new-exe')
      },
    })
    expect(await runUpdateHelper(invocation(s), deps)).toBe('applied')
    expect(seen[0]?.maxTotalBytes).toBe(readFileSync(s.zipPath).length * EXTRACT_BYTES_FACTOR)
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

describe('runUpdateHelper 来源校验（argv 是外部输入：拒绝即一字节不动、不写结果条）', () => {
  it('目标目录与助手镜像无关 → 拒（哪怕该目录内有同名 exe）', async () => {
    const s = makeScene()
    const victim = join(s.root, 'victim')
    mkdirSync(victim, { recursive: true })
    writeFileSync(join(victim, PORTABLE_EXE_NAME), 'victim-exe')
    const { deps, spawned } = stubs()
    const outcome = await runUpdateHelper(invocation(s, { targetDir: victim }), deps)
    expect(outcome).toBe('aborted')
    expect(exeOf(victim)).toBe('victim-exe') // 未改名、未搬走、未删
    expect(spawned).toEqual([])
    expect(readUpdateAttemptNote(s.home)).toBeNull()
  })

  it('目标目录内无便携 exe → 拒（非应用目录不得被改名/递归删）', async () => {
    const s = makeScene()
    const other = join(s.root, 'not-an-app')
    mkdirSync(other, { recursive: true })
    const { deps } = stubs({ execPath: join(other, PORTABLE_EXE_NAME) })
    const outcome = await runUpdateHelper(invocation(s, { targetDir: other }), deps)
    expect(outcome).toBe('aborted')
    expect(existsSync(other)).toBe(true)
    expect(readUpdateAttemptNote(s.home)).toBeNull()
  })

  it('包体不在更新缓存内 → 拒（解压与换目录的输入只认共享根内的包）', async () => {
    const s = makeScene()
    const outside = join(s.root, 'evil.zip')
    writeFileSync(outside, readFileSync(s.zipPath))
    const { deps, spawned } = stubs()
    const outcome = await runUpdateHelper(invocation(s, { payloadZip: outside }), deps)
    expect(outcome).toBe('aborted')
    expect(exeOf(s.appDir)).toBe('old-exe')
    expect(spawned).toEqual([])
    expect(readUpdateAttemptNote(s.home)).toBeNull()
  })

  it('包体无 sha256 锚 → 拒；测试专项开关显式放行', async () => {
    const s = makeScene()
    const { deps } = stubs()
    expect(await runUpdateHelper(invocation(s, { sha256: null }), deps)).toBe('aborted')
    expect(exeOf(s.appDir)).toBe('old-exe')
    expect(readUpdateAttemptNote(s.home)).toBeNull()

    const allowed = stubs({ allowUnanchoredPayloadForTest: true })
    expect(await runUpdateHelper(invocation(s, { sha256: null }), allowed.deps)).toBe('applied')
    expect(exeOf(s.appDir)).toBe('new-exe')
  })

  it('目标版本不高于当前版本 → 拒（fail-closed 防降级：全链任一环漂移都不得把旧版装回）', async () => {
    const s = makeScene()
    const { deps, spawned } = stubs()
    const outcome = await runUpdateHelper(invocation(s, { fromVersion: '2.0.0', toVersion: '2.0.0' }), deps)
    expect(outcome).toBe('aborted')
    expect(exeOf(s.appDir)).toBe('old-exe')
    expect(spawned).toEqual([])
    expect(readUpdateAttemptNote(s.home)).toBeNull()
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
      execPath: join(s.appDir, PORTABLE_EXE_NAME),
    }
    await runUpdateHelper(invocation(s, { exePath: null }), deps)
    expect(calls[0]).toBe(join(s.appDir, PORTABLE_EXE_NAME))
    expect(vi.isMockFunction(deps.spawnDetached)).toBe(false)
  })
})

describe('takeUpdateAttemptNote（一次性信箱：读后即删；删除失败仍返回本次内容）', () => {
  const noteOf = (outcome: 'applied' | 'rolled-back'): UpdateAttemptNote => ({
    at: '2026-01-01T00:00:00.000Z',
    outcome,
    from: OLD_VERSION,
    to: NEW_VERSION,
    reason: outcome === 'applied' ? 'ok' : 'swap-failed',
  })

  it('首次取到 → 文件已删 → 二次取为空（同一提示不重复出现）', () => {
    const home = tempDirTracked('clw-upd-take-')
    mkdirSync(updateCacheRoot(home), { recursive: true })
    expect(writeUpdateAttemptNote(home, noteOf('rolled-back'))).toBe(true)
    expect(takeUpdateAttemptNote(home)).toMatchObject({ outcome: 'rolled-back', reason: 'swap-failed' })
    expect(existsSync(updateResultPath(home))).toBe(false)
    expect(takeUpdateAttemptNote(home)).toBeNull()
  })

  it('删除失败（瞬时占用）→ 不抛出、仍返回本次内容，文件留待下次再取', () => {
    const home = tempDirTracked('clw-upd-take2-')
    mkdirSync(updateCacheRoot(home), { recursive: true })
    expect(writeUpdateAttemptNote(home, noteOf('applied'))).toBe(true)
    const taken = takeUpdateAttemptNote(home, {
      rm: () => {
        throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })
      },
    })
    // 回退即变红：删失败分支若改抛错或改返 null，「新版起不来」场景的唯一反馈通道即丢
    expect(taken).toMatchObject({ outcome: 'applied', reason: 'ok' })
    expect(existsSync(updateResultPath(home))).toBe(true)
  })
})

describe('ownInstanceKeyOf 与实例在持判定（助手侧显式排除自身，与控制器侧对称）', () => {
  it('本机 key 两路取法：--log-dir 的 instances/<key>/logs 段优先，其次 --dir 书库经单源算式', () => {
    const s = makeScene()
    expect(ownInstanceKeyOf(invocation(s, { logDir: join(s.home, 'instances', 'abc123', 'logs') }))).toBe('abc123')
    expect(ownInstanceKeyOf(invocation(s, { relaunchArgs: ['--dir', 'D:/书库'] }))).toBe(instanceKeyForDir('D:/书库'))
    expect(ownInstanceKeyOf(invocation(s))).toBeNull() // 两路皆无 → 不排除（多算即保守 abort）
  })

  it('预检把本机 key 传进「实例在持」判定：只有自身锁在持时不 abort', async () => {
    const s = makeScene()
    const seen: Array<string | null | undefined> = []
    const { deps } = stubs({
      // 判别式桩：excludeKey 命中本机 key 才算「无其他实例」；未传/不匹配即按在持计（多算保守）
      instancesRunning: (_home, excludeKey) => {
        seen.push(excludeKey)
        return excludeKey !== 'abc123'
      },
    })
    const outcome = await runUpdateHelper(invocation(s, { logDir: join(s.home, 'instances', 'abc123', 'logs') }), deps)
    expect(seen).toEqual(['abc123']) // 回退即变红：单参调用形态下这里收到的是 undefined
    expect(outcome).toBe('applied')
  })
})

describe('runRecoverUpdateCli（不依赖应用启动的中断自愈还原入口）', () => {
  it('旗判定：含旗即还原态（解析失败也不得落回应用形态）', () => {
    expect(isRecoverUpdateInvocation(['CLWriting.exe', RECOVER_UPDATE_FLAG, '--target', 'C:/app'])).toBe(true)
    expect(isRecoverUpdateInvocation(['CLWriting.exe', '--apply-update'])).toBe(false)
  })

  it('target 缺席 + .old- 残留 → 只做还原：目录回位并返回成功，不拉起进程、不写结果条', () => {
    const s = makeScene()
    renameSync(s.appDir, `${s.appDir}.old-${OLD_VERSION}`)
    expect(runRecoverUpdateCli(['CLWriting.exe', RECOVER_UPDATE_FLAG, '--target', s.appDir])).toBe(true)
    expect(exeOf(s.appDir)).toBe('old-exe')
    expect(readUpdateAttemptNote(s.home)).toBeNull() // 还原出口不碰一次性信箱
  })

  it('无可还原残留 / 缺 --target → 返回失败（可观测出口，不静默装作已还原）', () => {
    const s = makeScene()
    expect(runRecoverUpdateCli(['CLWriting.exe', RECOVER_UPDATE_FLAG, '--target', join(s.root, 'gone')])).toBe(false)
    expect(runRecoverUpdateCli(['CLWriting.exe', RECOVER_UPDATE_FLAG])).toBe(false)
  })
})

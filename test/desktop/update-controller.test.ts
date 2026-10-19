/**
 * 阶段 55：更新控制器——能力闸 / 下载编排（net.fetch 假件，可直驱动发布与包体两面）/
 * apply 预检四道闸 / 退出链兑现（argv 组装 + 拉起调用面）/ 启动维护清扫规则。
 *
 * 装置复用 main-fixtures（electron 假件 + 共享根假件 + net.fetch 捕获面）；
 * workdir-controller 按面打桩（currentWorkDir / isRelaunchPending 是本模块的显式输入），
 * update-helper 只桩 spawnDetachedProcess（真拉起会 spawn 测试 runner 自身）。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { M, mkTmp, cleanupMainTmpDirs } from './main-fixtures.js'
import {
  __getPendingUpdateForTest,
  __setPendingUpdateForTest,
  armPendingUpdateIfAny,
  cancelUpdateDownload,
  createUpdateCheckHost,
  discardPendingUpdate,
  helperStageDir,
  prepareUpdateApply,
  runUpdateMaintenance,
  selfUpdateDownloadCapable,
  selfUpdateInstallCapable,
  startUpdateDownload,
  UPDATE_DEV_FORCE_ENV,
} from '../../src/desktop/update-controller.js'
import {
  applyUpdateCheckResult,
  __resetUpdateCheckForTest,
  UPDATE_RESULT_MESSAGE_TYPE,
} from '../../src/update/check.js'
import { updateCacheDir, updateCacheRoot, UPDATE_RESULT_FILENAME } from '../../src/update/cache.js'

const wd = vi.hoisted(() => ({ workDir: null as string | null, relaunchPending: false }))
vi.mock('../../src/desktop/workdir-controller.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/desktop/workdir-controller.js')>()),
  currentWorkDir: () => wd.workDir,
  isRelaunchPending: () => wd.relaunchPending,
}))

const spawnSpy = vi.hoisted(() => ({ calls: [] as string[][] }))
vi.mock('../../src/desktop/update-helper.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/desktop/update-helper.js')>()),
  spawnDetachedProcess: async (exe: string, args: string[]) => {
    spawnSpy.calls.push([exe, ...args])
    return true
  },
}))

const ZIP_BYTES = Buffer.from('fake-portable-zip-payload')
const ZIP_SHA = createHash('sha256').update(ZIP_BYTES).digest('hex')
const ASSET_NAME = 'CLWriting-1.0.0-x64.zip'
const ASSET_URL = 'https://objects.githubusercontent.com/CLWriting-1.0.0-x64.zip'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

/** 平台覆写（win 分支判据走 process.platform；用例结束还原原描述符） */
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

afterAll(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
  cleanupMainTmpDirs()
})

let savedForce: string | undefined

beforeEach(() => {
  M.isPackaged = true
  // 安装闸的防降级断言比的是「当前版本 vs 目标版本」：闸用例的目标恒为 1.0.0，
  // 故当前版本取更低值（真机上升级时旧版本也正是更低值）
  M.appVersion = '0.9.0'
  M.netFetchCalls.length = 0
  M.netFetchResponse = null
  M.logWarns.length = 0
  M.logInfos.length = 0
  spawnSpy.calls.length = 0
  wd.workDir = null
  wd.relaunchPending = false
  __setPendingUpdateForTest(null)
  savedForce = process.env[UPDATE_DEV_FORCE_ENV]
  delete process.env[UPDATE_DEV_FORCE_ENV]
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
  // 每个用例独立共享根（缓存/实例锁都挂在它下面）
  M.userData = mkTmp('clw-upd-ctl-')
})

afterAll(() => {
  if (savedForce === undefined) delete process.env[UPDATE_DEV_FORCE_ENV]
  else process.env[UPDATE_DEV_FORCE_ENV] = savedForce
})

/** 发布信息响应（GitHub releases 列表形） */
function releasesResponse(version: string, asset: Record<string, unknown> | null): unknown {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => [
      {
        tag_name: `v${version}`,
        draft: false,
        assets: asset
          ? [
              { name: ASSET_NAME, browser_download_url: ASSET_URL, size: ZIP_BYTES.length, ...asset },
              { name: 'SHA256SUMS.txt', browser_download_url: 'https://objects.githubusercontent.com/SHA256SUMS.txt' },
            ]
          : [],
      },
    ],
    body: { cancel: async () => {} },
  }
}

/** 包体响应（单块 ReadableStream 假件） */
function zipResponse(body: Buffer): unknown {
  let sent = false
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? String(body.length) : null) },
    body: {
      getReader: () => ({
        read: async () =>
          sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: new Uint8Array(body) }),
      }),
    },
  }
}

function serveByUrl(version: string, digest: string | null): void {
  M.netFetchResponse = (url: string) => {
    if (url.includes('api.github.com')) {
      return releasesResponse(version, digest ? { digest: `sha256:${digest}` } : {})
    }
    return zipResponse(ZIP_BYTES)
  }
}

describe('能力闸（阶段 55）', () => {
  it('打包 + win32 → 下载与安装双开；打包 + 非 win → 双关（自动安装不出 Windows）', () => {
    setPlatform('win32')
    expect(selfUpdateDownloadCapable()).toBe(true)
    expect(selfUpdateInstallCapable()).toBe(true)
    setPlatform('darwin')
    expect(selfUpdateDownloadCapable()).toBe(false)
    expect(selfUpdateInstallCapable()).toBe(false)
  })

  it('开发态显式开关：放行下载、**不**放行安装；打包态忽略该变量（宿主残留不改生产行为）', () => {
    setPlatform('darwin')
    M.isPackaged = false
    process.env[UPDATE_DEV_FORCE_ENV] = '1'
    expect(selfUpdateDownloadCapable()).toBe(true)
    expect(selfUpdateInstallCapable()).toBe(false)
    M.isPackaged = true
    expect(selfUpdateDownloadCapable()).toBe(false)
  })
})

describe('startUpdateDownload（发布信息重取 + 流式下载 + 缓存复用）', () => {
  it('正常：解析资产 → 下载校验落盘 → 置就绪态（进度回调透传）', async () => {
    setPlatform('win32')
    serveByUrl('1.0.0', ZIP_SHA)
    const progress: number[] = []
    const r = await startUpdateDownload({ version: '1.0.0', onProgress: (p) => progress.push(p.received) })
    expect(r).toEqual({ ok: true })
    const zipPath = join(updateCacheDir(M.userData, '1.0.0'), ASSET_NAME)
    expect(readFileSync(zipPath).equals(ZIP_BYTES)).toBe(true)
    expect(__getPendingUpdateForTest()).toMatchObject({ zipPath, sha256: ZIP_SHA, toVersion: '1.0.0' })
    expect(progress.at(-1)).toBe(ZIP_BYTES.length)
    expect(M.netFetchCalls[0]).toContain('api.github.com')
    expect(M.netFetchCalls[1]).toBe(ASSET_URL)
  })

  it('缓存复用：正式名已存在且实测 sha 与发布方一致 → 不再第二次拉包', async () => {
    setPlatform('win32')
    serveByUrl('1.0.0', ZIP_SHA)
    await startUpdateDownload({ version: '1.0.0', onProgress: () => {} })
    const firstCalls = M.netFetchCalls.length
    __setPendingUpdateForTest(null)
    const again = await startUpdateDownload({ version: '1.0.0', onProgress: () => {} })
    expect(again).toEqual({ ok: true })
    expect(M.netFetchCalls.length).toBe(firstCalls + 1) // 只多一次发布信息请求
    expect(__getPendingUpdateForTest()?.sha256).toBe(ZIP_SHA)
  })

  it('版本对不上（发布页已变）→ 拒下载', async () => {
    setPlatform('win32')
    serveByUrl('2.0.0', ZIP_SHA)
    const r = await startUpdateDownload({ version: '1.0.0', onProgress: () => {} })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('版本已变化')
  })

  it('该版本无便携包（assets 里没有 x64 zip）→ 拒下载，提示走「去下载」', async () => {
    setPlatform('win32')
    M.netFetchResponse = () => releasesResponse('1.0.0', null)
    const r = await startUpdateDownload({ version: '1.0.0', onProgress: () => {} })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('去下载')
  })

  it('发布信息取不到（网络失败）→ 契约化失败，不抛', async () => {
    setPlatform('win32')
    const r = await startUpdateDownload({ version: '1.0.0', onProgress: () => {} })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('取不到发布信息')
  })

  it('发布集里没有正式版 → 报「无正式版」而非网络错（两因两话，别把排查引向代理）', async () => {
    setPlatform('win32')
    M.netFetchResponse = () => releasesResponse('1.0.0-rc.4', null)
    const r = await startUpdateDownload({ version: '1.0.0-rc.4', onProgress: () => {} })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('正式版')
    expect(r.reason).not.toContain('网络')
  })

  it('校验不匹配 → 失败信封含「校验未通过」，且不置就绪态、盘上无残迹', async () => {
    setPlatform('win32')
    serveByUrl('1.0.0', 'f'.repeat(64))
    const r = await startUpdateDownload({ version: '1.0.0', onProgress: () => {} })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('校验未通过')
    expect(__getPendingUpdateForTest()).toBeNull()
    expect(existsSync(join(updateCacheDir(M.userData, '1.0.0'), ASSET_NAME))).toBe(false)
  })

  it('取消入口安全：无在途下载时为 no-op（不抛）', () => {
    expect(() => cancelUpdateDownload()).not.toThrow()
  })
})

describe('更新链地址信任面（白名单 + 校验清单派生）', () => {
  it('地址白名单：发布域主机可信、其余不可信（非法 URL 亦不可信）', async () => {
    const { isTrustedUpdateUrl } = await import('../../src/update/download.js')
    expect(isTrustedUpdateUrl('https://github.com/Jevanzhu/CLWriting/releases/download/v1.0.0/a.zip')).toBe(true)
    expect(isTrustedUpdateUrl('https://objects.githubusercontent.com/a.zip')).toBe(true)
    expect(isTrustedUpdateUrl('https://api.github.com/repos/Jevanzhu/CLWriting/releases')).toBe(true)
    expect(isTrustedUpdateUrl('https://evil.test/a.zip')).toBe(false)
    expect(isTrustedUpdateUrl('https://github.com.evil.test/a.zip')).toBe(false)
    expect(isTrustedUpdateUrl('not a url')).toBe(false)
  })

  it('校验清单地址由编译期仓常量与 tag 派生（不取发布响应里的地址）', async () => {
    const { releaseChecksumsUrl } = await import('../../src/update/download.js')
    expect(releaseChecksumsUrl('v1.0.0')).toBe(
      'https://github.com/Jevanzhu/CLWriting/releases/download/v1.0.0/SHA256SUMS.txt',
    )
  })

  it('资产地址不在发布域白名单 → 下载拒且零出站（不把「下哪个文件」交给可篡改的响应）', async () => {
    setPlatform('win32')
    M.netFetchResponse = (url: string) => {
      if (url.includes('api.github.com')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => [
            {
              tag_name: 'v1.0.0',
              draft: false,
              assets: [{ name: ASSET_NAME, browser_download_url: 'https://evil.test/x.zip', size: ZIP_BYTES.length }],
            },
          ],
          body: { cancel: async () => {} },
        }
      }
      return zipResponse(ZIP_BYTES)
    }
    const r = await startUpdateDownload({ version: '1.0.0', onProgress: () => {} })
    expect(r.ok).toBe(false)
    expect(String(r.reason)).toContain('下载失败')
    expect(M.netFetchCalls.filter((u) => u.includes('evil.test'))).toEqual([])
    expect(__getPendingUpdateForTest()).toBeNull()
    expect(existsSync(join(updateCacheDir(M.userData, '1.0.0'), ASSET_NAME))).toBe(false)
  })
})

describe('prepareUpdateApply（四道闸）', () => {
  it('目标版本不高于当前版本 → 拒（fail-closed 防降级：全链任一环节漂移都不得把旧版装回）', () => {
    setPlatform('win32')
    M.appVersion = '2.0.0'
    __setPendingUpdateForTest({ zipPath: '/tmp/z.zip', sha256: 'a'.repeat(64), toVersion: '1.0.0' })
    const r = prepareUpdateApply({ version: '1.0.0' })
    expect(r.ok).toBe(false)
    expect(String(r.reason)).toContain('更高的版本')
  })

  beforeEach(() => setPlatform('win32'))

  it('就绪态缺失 → 拒（先下载）', () => {
    expect(prepareUpdateApply({ version: '1.0.0' })).toEqual({ ok: false, reason: expect.stringContaining('尚未就绪') })
  })

  it('就绪版本与请求版本不一致 → 拒（重新检查更新）', () => {
    __setPendingUpdateForTest({ zipPath: '/tmp/z.zip', sha256: 'a'.repeat(64), toVersion: '1.0.0' })
    const r = prepareUpdateApply({ version: '2.0.0' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('版本已变化')
  })

  it('切库在途 → 拒（两个重启意图会起两个新进程）', () => {
    __setPendingUpdateForTest({ zipPath: '/tmp/z.zip', sha256: 'a'.repeat(64), toVersion: '1.0.0' })
    wd.relaunchPending = true
    const r = prepareUpdateApply({ version: '1.0.0' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('切换书库')
  })

  it('其他实例在跑 → 拒；「其他」不含本实例（自身 key 排除）', () => {
    __setPendingUpdateForTest({ zipPath: '/tmp/z.zip', sha256: 'a'.repeat(64), toVersion: '1.0.0' })
    const selfLock = join(M.userData, 'instances', 'welcome', 'app-instance.lock')
    const otherLock = join(M.userData, 'instances', 'otherlib', 'app-instance.lock')
    for (const p of [selfLock, otherLock]) {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, JSON.stringify({ pid: process.pid, bootTime: Date.now() }))
    }
    // 自身（welcome，因 currentWorkDir 为空）不算「其他」——但 otherlib 在跑 → 拒
    const blocked = prepareUpdateApply({ version: '1.0.0' })
    expect(blocked.ok).toBe(false)
    expect(blocked.reason).toContain('窗口')
    // 去掉他库实例 → 通过
    writeFileSync(otherLock, JSON.stringify({ pid: 999_999_999, bootTime: Date.now() })) // 死 pid 残留
    expect(prepareUpdateApply({ version: '1.0.0' })).toEqual({ ok: true })
  })

  it('非 win/打包态 → 拒且文案指向平台限制（开发态已下载时另给可读交代）', () => {
    setPlatform('darwin')
    M.isPackaged = false
    process.env[UPDATE_DEV_FORCE_ENV] = '1'
    __setPendingUpdateForTest({ zipPath: '/tmp/z.zip', sha256: 'a'.repeat(64), toVersion: '1.0.0' })
    expect(prepareUpdateApply({ version: '1.0.0' }).reason).toContain('Windows')
  })
})

describe('armPendingUpdateIfAny / discardPendingUpdate（退出链兑现）', () => {
  it('就绪 + win 打包态 → 暂存副本 + 拉起助手（argv 全量：payload/target/pid/版本/共享根/日志目录/--dir）', () => {
    setPlatform('win32')
    wd.workDir = 'D:/书库'
    // 假应用目录经 process.execPath 改道（生产 = dirname(execPath)；用例结束还原）
    const appDir = mkTmp('clw-upd-appdir-')
    writeFileSync(join(appDir, 'CLWriting.exe'), 'fake exe')
    mkdirSync(join(appDir, 'resources'), { recursive: true })
    writeFileSync(join(appDir, 'resources', 'app.asar'), 'fake asar')
    const execPathPrev = process.execPath
    process.execPath = join(appDir, 'CLWriting.exe')
    try {
      __setPendingUpdateForTest({ zipPath: 'C:/home/更新缓存/1.0.0/pkg.zip', sha256: ZIP_SHA, toVersion: '1.0.0' })
      armPendingUpdateIfAny()
      const stage = helperStageDir(M.userData, '1.0.0')
      // 助手从暂存副本运行（目标目录外的镜像——自镜像在目标内时目录改名必败 EPERM，
      // win 真机实测）
      expect(spawnSpy.calls).toHaveLength(1)
      const [exe, ...args] = spawnSpy.calls[0]!
      expect(exe).toBe(join(stage, 'CLWriting.exe'))
      expect(existsSync(join(stage, 'resources', 'app.asar'))).toBe(true) // 整棵复制
      expect(args).toContain('--apply-update')
      expect(args).toContain('--payload')
      expect(args[args.indexOf('--payload') + 1]).toBe('C:/home/更新缓存/1.0.0/pkg.zip')
      expect(args[args.indexOf('--target') + 1]).toBe(appDir) // 目标仍是真应用目录，不是暂存
      expect(args[args.indexOf('--pid') + 1]).toBe(String(process.pid))
      expect(args[args.indexOf('--from-version') + 1]).toBe(M.appVersion)
      expect(args[args.indexOf('--to-version') + 1]).toBe('1.0.0')
      expect(args[args.indexOf('--home') + 1]).toBe(M.userData)
      expect(args[args.indexOf('--sha256') + 1]).toBe(ZIP_SHA)
      expect(args.slice(args.indexOf('--dir'), args.indexOf('--dir') + 2)).toEqual(['--dir', 'D:/书库'])
      // 兑现即清（二次调用不得再拉起）
      expect(__getPendingUpdateForTest()).toBeNull()
      armPendingUpdateIfAny()
      expect(spawnSpy.calls).toHaveLength(1)
    } finally {
      process.execPath = execPathPrev
    }
  })

  it('暂存副本复制失败（源目录缺席）→ 不起进程、意图丢弃、错误+告警双留痕', () => {
    setPlatform('win32')
    const execPathPrev = process.execPath
    process.execPath = join(mkTmp('clw-upd-missing-app-'), 'nope', 'CLWriting.exe')
    try {
      __setPendingUpdateForTest({ zipPath: '/tmp/z.zip', sha256: null, toVersion: '1.0.0' })
      armPendingUpdateIfAny()
      expect(spawnSpy.calls).toHaveLength(0)
      expect(M.logErrors.some((w) => String((w as unknown[])[1] ?? '').includes('暂存副本复制失败'))).toBe(true)
      expect(M.logWarns.some((w) => String((w as unknown[])[1] ?? '').includes('暂存副本不可用'))).toBe(true)
      armPendingUpdateIfAny() // 意图已丢弃：再兑现一次也无声
      expect(spawnSpy.calls).toHaveLength(0)
    } finally {
      process.execPath = execPathPrev
    }
  })

  it('形态不支持（非 win/打包态）→ 意图丢弃 + 留痕，不起进程（不让退出链挂着）', () => {
    setPlatform('darwin') // 前提显式：宿主平台随机器（win 机上缺省即 win32，不再等于「非 win」）
    __setPendingUpdateForTest({ zipPath: '/tmp/z.zip', sha256: null, toVersion: '1.0.0' })
    armPendingUpdateIfAny()
    expect(spawnSpy.calls).toHaveLength(0)
    expect(__getPendingUpdateForTest()).toBeNull()
    expect(M.logWarns.some((w) => String((w as unknown[])[1] ?? '').includes('不支持自动安装'))).toBe(true)
  })

  it('无就绪态 → 空操作（普通退出零副作用）', () => {
    armPendingUpdateIfAny()
    expect(spawnSpy.calls).toHaveLength(0)
  })

  it('discardPendingUpdate：无意图 false / 有意图 true 且清位（退出取消路径）', () => {
    expect(discardPendingUpdate()).toBe(false)
    __setPendingUpdateForTest({ zipPath: '/tmp/z.zip', sha256: null, toVersion: '1.0.0' })
    expect(discardPendingUpdate()).toBe(true)
    expect(discardPendingUpdate()).toBe(false)
  })
})

describe('runUpdateMaintenance（启动维护清扫规则）', () => {
  it('应用目录旁的 -new-/.old- 残留清掉、无关兄弟目录不动', () => {
    const parent = mkTmp('clw-upd-apps-')
    const appDir = join(parent, 'CLWriting')
    const leftovers = [`${appDir}-new-1.0.0`, `${appDir}.old-1.0.0-rc.4`]
    for (const d of [appDir, ...leftovers, join(parent, 'CLWriting-other')]) mkdirSync(d, { recursive: true })
    runUpdateMaintenance({ appDir, homeDir: join(parent, 'home'), currentVersion: '1.0.0' })
    for (const d of leftovers) expect(existsSync(d)).toBe(false)
    expect(existsSync(appDir)).toBe(true)
    expect(existsSync(join(parent, 'CLWriting-other'))).toBe(true)
  })

  it('target 缺席（已改名未就位窗）→ 保留 .old- 回滚面，-new- 照清', () => {
    const parent = mkTmp('clw-upd-apps-')
    const appDir = join(parent, 'CLWriting') // 不建 appDir = target 缺席
    const newDir = `${appDir}-new-1.0.0`
    const oldDir = `${appDir}.old-1.0.0-rc.4`
    for (const d of [newDir, oldDir]) mkdirSync(d, { recursive: true })
    runUpdateMaintenance({ appDir, homeDir: join(parent, 'home'), currentVersion: '1.0.0' })
    expect(existsSync(oldDir)).toBe(true) // 唯一还原源，留给 recoverInterruptedSwap（擦了回滚能力永久消失）
    expect(existsSync(newDir)).toBe(false) // 未就位的新版无回滚价值，照清
  })

  it('缓存：不高于当前版本的目录清、更新版本与结果条留、.part 残迹清、非版本名目录不动', () => {
    const home = mkTmp('clw-upd-cache-')
    const root = updateCacheRoot(home)
    const oldDir = join(root, '1.0.0-rc.4')
    const newDir = join(root, '2.0.0')
    const weirdDir = join(root, 'not-a-version')
    for (const d of [oldDir, newDir, weirdDir]) mkdirSync(d, { recursive: true })
    writeFileSync(join(root, UPDATE_RESULT_FILENAME), '{}')
    writeFileSync(join(root, 'pkg.zip.part'), 'half')
    runUpdateMaintenance({ appDir: null, homeDir: home, currentVersion: '1.0.0' })
    expect(existsSync(oldDir)).toBe(false)
    expect(existsSync(newDir)).toBe(true)
    expect(existsSync(weirdDir)).toBe(true)
    expect(existsSync(join(root, UPDATE_RESULT_FILENAME))).toBe(true)
    expect(existsSync(join(root, 'pkg.zip.part'))).toBe(false)
  })

  it('缓存根不存在 → 空操作不抛（首启形态）', () => {
    const home = mkTmp('clw-upd-cache2-')
    expect(() => runUpdateMaintenance({ appDir: null, homeDir: home, currentVersion: '1.0.0' })).not.toThrow()
  })

  it('asar 叶容忍：Electron 层对含 resources/app.asar 的目录递归删必 EPERM，摘叶重试后清掉', async () => {
    const dir = mkTmp('clw-upd-asarleaf-')
    mkdirSync(join(dir, 'resources'), { recursive: true })
    writeFileSync(join(dir, 'resources', 'app.asar'), 'fake-asar')
    // 仿真 Electron asar 层（win 真机实测口径）：app.asar 在位时 rmSync 抛 EPERM、摘名后放行。
    // doMock + 动态导入取新实例：本文件其余用例走真实 fs，不能吃文件级桩。
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>()
      const out: Record<string, unknown> = { ...(actual as unknown as Record<string, unknown>) }
      out['rmSync'] = (p: unknown, o?: unknown): unknown => {
        if (existsSync(join(String(p), 'resources', 'app.asar'))) {
          throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
        }
        return (actual.rmSync as (...a: unknown[]) => unknown)(p, o)
      }
      return out as unknown as typeof actual
    })
    vi.resetModules()
    try {
      const fresh = await import('../../src/desktop/update-controller.js')
      fresh.rmDirQuietly(dir)
      expect(existsSync(dir)).toBe(false)
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }
  })
})

describe('createUpdateCheckHost（主进程检查宿主：延迟跑一次 + 结果下发子进程）', () => {
  let pushed: unknown[]

  beforeEach(() => {
    pushed = []
    __resetUpdateCheckForTest()
  })

  const host = (opts: { runCheck?: () => Promise<void>; pushOk?: boolean } = {}) =>
    createUpdateCheckHost({
      push: (message) => {
        pushed.push(message)
        return opts.pushOk ?? true
      },
      // 只在显式给桩时传 runCheck——缺省留空才走生产实现（net.fetch 腿）
      ...(opts.runCheck ? { runCheck: opts.runCheck } : {}),
      currentVersion: () => '1.0.0',
    })

  it('到点跑检查并把结果经下发通道送出（类型与载荷形状）', async () => {
    const h = host({
      runCheck: async () => {
        applyUpdateCheckResult({
          version: '1.2.3',
          url: 'https://github.com/Jevanzhu/CLWriting/releases/tag/v1.2.3',
          asset: null,
          checksumsUrl: null,
        })
      },
    })
    h.scheduleCheck(0)
    await vi.waitFor(() => expect(pushed).toHaveLength(1))
    expect(pushed[0]).toEqual({
      type: UPDATE_RESULT_MESSAGE_TYPE,
      result: {
        version: '1.2.3',
        url: 'https://github.com/Jevanzhu/CLWriting/releases/tag/v1.2.3',
        asset: null,
        checksumsUrl: null,
      },
    })
  })

  it('只排一次：重复 scheduleCheck（bootstrap 重跑形态）不二次出站', async () => {
    let runs = 0
    const h = host({
      runCheck: async () => {
        runs++
        applyUpdateCheckResult(null)
      },
    })
    h.scheduleCheck(0)
    h.scheduleCheck(0)
    await vi.waitFor(() => expect(pushed).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 5))
    expect(runs).toBe(1)
    expect(pushed).toHaveLength(1)
  })

  it('未到点/未跑完不下发：pushLastResult 返 false 且通道零调用', () => {
    const h = host()
    expect(h.pushLastResult()).toBe(false)
    expect(pushed).toHaveLength(0)
  })

  it('补发（child 重启后）：跑完后 pushLastResult 把同结果再送一次', async () => {
    const h = host({
      runCheck: async () => {
        applyUpdateCheckResult({
          version: '2.0.0',
          url: 'https://github.com/Jevanzhu/CLWriting/releases/tag/v2.0.0',
          asset: null,
          checksumsUrl: null,
        })
      },
    })
    h.scheduleCheck(0)
    await vi.waitFor(() => expect(pushed).toHaveLength(1))
    // 新 child 模块态是空的——补发把同结果再送一次（幂等，子进程侧只落态）
    expect(h.pushLastResult()).toBe(true)
    expect(pushed).toHaveLength(2)
    expect(pushed[1]).toEqual(pushed[0])
  })

  it('检查抛错不外溢（只留痕），也不下发', async () => {
    const h = host({ runCheck: () => Promise.reject(new Error('boom')) })
    h.scheduleCheck(0)
    await new Promise((r) => setTimeout(r, 10))
    expect(pushed).toHaveLength(0)
    expect(M.logWarns.length).toBeGreaterThan(0)
  })

  it('默认检查腿走 net.fetch（Chromium 网络栈受系统代理——与下载腿同通道）', async () => {
    // 全局 setup 置了不打网开关，本例要真跑一次默认检查腿（net.fetch 已假件，不出网）
    const saved = process.env['CLW_DISABLE_UPDATE_CHECK']
    delete process.env['CLW_DISABLE_UPDATE_CHECK']
    M.netFetchResponse = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: { cancel: async () => {} },
      json: async () => [{ tag_name: 'v9.9.9', draft: false }],
    }
    try {
      const h = host() // 不给 runCheck —— 走缺省实现
      h.scheduleCheck(0)
      await vi.waitFor(() => expect(pushed).toHaveLength(1))
      // 出站落 net.fetch 捕获面（全局 fetch 直连通道不参与——撤 netFetch 换回全局 fetch 即本断言红）
      expect(M.netFetchCalls.some((u) => u.includes('api.github.com'))).toBe(true)
      expect(pushed[0]).toMatchObject({ result: { version: '9.9.9' } })
    } finally {
      if (saved !== undefined) process.env['CLW_DISABLE_UPDATE_CHECK'] = saved
    }
  })
})

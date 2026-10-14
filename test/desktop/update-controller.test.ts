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
  discardPendingUpdate,
  prepareUpdateApply,
  runUpdateMaintenance,
  selfUpdateDownloadCapable,
  selfUpdateInstallCapable,
  startUpdateDownload,
  UPDATE_DEV_FORCE_ENV,
} from '../../src/desktop/update-controller.js'
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
const ASSET_URL = 'https://objects.test/CLWriting-1.0.0-x64.zip'

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
              { name: 'SHA256SUMS.txt', browser_download_url: 'https://objects.test/SHA256SUMS.txt' },
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

describe('prepareUpdateApply（四道闸）', () => {
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
  it('就绪 + win 打包态 → 拉起助手进程（argv 全量：payload/target/pid/版本/共享根/日志目录/--dir）', () => {
    setPlatform('win32')
    wd.workDir = 'D:/书库'
    __setPendingUpdateForTest({ zipPath: 'C:/home/更新缓存/1.0.0/pkg.zip', sha256: ZIP_SHA, toVersion: '1.0.0' })
    armPendingUpdateIfAny()
    expect(spawnSpy.calls).toHaveLength(1)
    const [exe, ...args] = spawnSpy.calls[0]!
    expect(exe).toBe(process.execPath)
    expect(args).toContain('--apply-update')
    expect(args).toContain('--payload')
    expect(args[args.indexOf('--payload') + 1]).toBe('C:/home/更新缓存/1.0.0/pkg.zip')
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
  })

  it('形态不支持（非 win/打包态）→ 意图丢弃 + 留痕，不起进程（不让退出链挂着）', () => {
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
})

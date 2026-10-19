/**
 * 阶段 55：自更新 IPC 五入口（能力 / 下载 / 取消 / 应用 / 打开所在文件夹）的契约面。
 *
 * 手法同 open-external-ipc：electron / windows / workdir-controller / user-data-path
 * 假件直驱 ipc.ts 注册面；更新控制器为真件（能力闸与下载编排的深处逻辑在
 * update-controller.test.ts 覆盖，这里只锁 IPC 层的信封、参数校验与副作用接线）。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { __setPendingUpdateForTest } from '../../src/desktop/update-controller.js'

const M = vi.hoisted(() => ({
  ipcHandle: {} as Record<string, (e: unknown, ...a: unknown[]) => unknown>,
  home: '',
  isPackaged: true,
  quitCalls: 0,
  revealed: [] as string[],
  logWarns: [] as string[],
  netFetchCalls: [] as string[],
  netFetchResponse: null as unknown,
}))

vi.mock('electron', () => ({
  app: {
    quit: (): void => {
      M.quitCalls++
    },
    getPath: (k: string) => (k === 'userData' ? join(M.home, 'instances', 'welcome') : `/fake/${k}`),
    getVersion: () => '1.0.0-rc.4',
    get isPackaged(): boolean {
      return M.isPackaged
    },
  },
  BrowserWindow: Object.assign(
    class {
      isDestroyed(): boolean {
        return false
      }
    },
    { fromWebContents: () => null, getAllWindows: () => [] },
  ),
  Menu: { buildFromTemplate: () => ({ popup: (): void => {} }), setApplicationMenu: (): void => {} },
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => {
      M.ipcHandle[ch] = fn
    },
    on: (): void => {},
  },
  nativeTheme: { themeSource: 'light' },
  shell: {
    showItemInFolder: (p: string): void => {
      M.revealed.push(p)
    },
    openPath: async () => '',
    openExternal: async (): Promise<void> => {},
  },
  net: {
    fetch: async (url: string) => {
      M.netFetchCalls.push(String(url))
      const canned = M.netFetchResponse
      if (typeof canned === 'function') return (canned as (u: string) => unknown)(String(url))
      return { ok: false, status: 503, headers: { get: () => null }, body: null }
    },
  },
  dialog: {},
}))
vi.mock('../../src/desktop/windows.js', () => ({
  wins: {},
  isTrustedSender: () => true,
  openShelfWindow: async (): Promise<unknown> => null,
  openLibraryWindow: async (): Promise<unknown> => null,
}))
vi.mock('../../src/desktop/workdir-controller.js', () => ({
  canSwitchLibraryDir: () => true,
  currentWorkDir: () => null,
  findBookEntry: () => undefined,
  isRelaunchPending: () => false,
  pickLibrary: async () => null,
  probeDirReachable: async () => 'ok',
  readStore: () => ({ current: null, recent: [] }),
  relaunch: (): void => {},
  resolveReachableWorkDir: async () => null,
  saveCurrentArmingRollback: () => null,
  warnIfCaseSensitive: async () => false,
}))
vi.mock('../../src/fs/user-data-path.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/fs/user-data-path.js')>()
  return {
    ...actual,
    appDataHomeDir: (): string => M.home,
    instanceKeyForDir: (dir?: string | null) => (dir ? `key-${dir.length}` : 'welcome'),
  }
})
vi.mock('font-list', () => ({ getFonts: async () => [] }))
vi.mock('../../src/log/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/log/index.js')>()
  return {
    ...actual,
    log: {
      ...actual.log,
      warn: (tag: string, msg: string): void => {
        M.logWarns.push(`${tag} ${msg}`)
      },
    },
  }
})

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

afterAll(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
})

/** 受信 sender 假件 + 事件出口捕获（进度推送面） */
function sender(): { sender: Record<string, unknown>; sent: Array<[string, ...unknown[]]>; destroy: () => void } {
  const sent: Array<[string, ...unknown[]]> = []
  let destroyed = false
  const wc = {
    sent,
    isDestroyed: () => destroyed,
    send: (ch: string, ...a: unknown[]) => {
      sent.push([ch, ...a])
    },
  }
  return { sender: wc, sent, destroy: () => (destroyed = true) }
}

const ZIP_BYTES = Buffer.from('zip-bytes-for-ipc-test')
const ZIP_SHA = createHash('sha256').update(ZIP_BYTES).digest('hex')
const ASSET_NAME = 'CLWriting-1.0.0-x64.zip'

function serveRelease(): void {
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
            assets: [
              {
                name: ASSET_NAME,
                // 规范地址（仓常量 + tag + 资产名）：下载链只放行这一条，见 update/download 头注
                browser_download_url: `https://github.com/Jevanzhu/CLWriting/releases/download/v1.0.0/${ASSET_NAME}`,
                size: ZIP_BYTES.length,
                digest: `sha256:${ZIP_SHA}`,
              },
            ],
          },
        ],
        body: { cancel: async () => {} },
      }
    }
    let sent = false
    return {
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? String(ZIP_BYTES.length) : null) },
      body: {
        getReader: () => ({
          read: async () =>
            sent
              ? { done: true, value: undefined }
              : ((sent = true), { done: false, value: new Uint8Array(ZIP_BYTES) }),
        }),
      },
    }
  }
}

beforeEach(async () => {
  M.home = mkdtempTracked('clw-upd-ipc-')
  M.isPackaged = true
  M.quitCalls = 0
  M.revealed.length = 0
  M.netFetchCalls.length = 0
  M.netFetchResponse = null
  __setPendingUpdateForTest(null)
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
  // 模块级注册只跑一次；ipcMain.handle 假件按 channel 覆盖写，重复注册幂等
  const { registerIpc } = await import('../../src/desktop/ipc.js')
  registerIpc()
})

describe('desktop:update-capability', () => {
  it('win + 打包态 → 双开；非 win → 双关（渲染层据此决定渲染哪个按钮）', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    expect(M.ipcHandle['desktop:update-capability']?.({}, undefined)).toEqual({ canDownload: true, canInstall: true })
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    expect(M.ipcHandle['desktop:update-capability']?.({}, undefined)).toEqual({ canDownload: false, canInstall: false })
  })
})

describe('desktop:update-download', () => {
  it('版本参数非法 → 契约化拒绝（不触网）', async () => {
    const r = await M.ipcHandle['desktop:update-download']?.({ sender: sender().sender }, 42)
    expect(r).toEqual({ ok: false, reason: '版本参数无效' })
    expect(M.netFetchCalls).toEqual([])
  })

  it('正常：解析→下载→校验落盘，进度经 desktop:update-progress 推给发起窗口', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    serveRelease()
    const s = sender()
    const r = await M.ipcHandle['desktop:update-download']?.({ sender: s.sender }, '1.0.0')
    expect(r).toEqual({ ok: true })
    expect(existsSync(join(M.home, '更新缓存', '1.0.0', ASSET_NAME))).toBe(true)
    const progressEvents = s.sent.filter(([ch]) => ch === 'desktop:update-progress')
    expect(progressEvents.length).toBeGreaterThan(0)
    expect(progressEvents.at(-1)?.[1]).toMatchObject({ received: ZIP_BYTES.length })
  })

  it('发起窗口已销毁 → 进度推送被吞（不抛；下载自身照常落定）', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    serveRelease()
    const s = sender()
    s.destroy()
    const r = await M.ipcHandle['desktop:update-download']?.({ sender: s.sender }, '1.0.0')
    expect(r).toEqual({ ok: true })
    expect(s.sent).toEqual([])
  })

  it('下载失败 → {ok:false, reason}（人话），不放行应用', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const r = (await M.ipcHandle['desktop:update-download']?.({ sender: sender().sender }, '1.0.0')) as {
      ok: boolean
      reason: string
    }
    expect(r.ok).toBe(false)
    expect(String(r.reason)).toContain('取不到发布信息')
  })
})

describe('desktop:update-cancel / reveal', () => {
  it('取消：无在途下载也回 {ok:true}（幂等，不留死按钮）', () => {
    expect(M.ipcHandle['desktop:update-cancel']?.({}, undefined)).toEqual({ ok: true })
  })

  it('打开所在文件夹：下载过 → shell.showItemInFolder 收到包路径；没下载过 → 静默留痕不抛', async () => {
    // 未下载过：no-op + 留痕
    expect(() => M.ipcHandle['desktop:update-reveal']?.({}, undefined)).not.toThrow()
    expect(M.revealed).toEqual([])
    expect(M.logWarns.some((m) => m.includes('无物可开'))).toBe(true)

    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    serveRelease()
    await M.ipcHandle['desktop:update-download']?.({ sender: sender().sender }, '1.0.0')
    M.ipcHandle['desktop:update-reveal']?.({}, undefined)
    expect(M.revealed).toEqual([join(M.home, '更新缓存', '1.0.0', ASSET_NAME)])
  })
})

describe('desktop:update-apply', () => {
  it('包未就绪 → 拒绝且不退出（不把应用卡在退出链上）', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const r = M.ipcHandle['desktop:update-apply']?.({}, '1.0.0') as { ok: boolean; reason: string }
    expect(r.ok).toBe(false)
    expect(String(r.reason)).toContain('尚未就绪')
    expect(M.quitCalls).toBe(0)
  })

  it('版本参数非法 → 拒绝', () => {
    expect(M.ipcHandle['desktop:update-apply']?.({}, '')).toEqual({ ok: false, reason: '版本参数无效' })
  })

  it('非 win/打包态 → 拒绝（文案指向平台限制），不退出', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true }) // 前提显式：宿主平台随机器（win 机缺省即 win32）
    __setPendingUpdateForTest({ zipPath: join(M.home, 'z.zip'), sha256: ZIP_SHA, toVersion: '1.0.0' })
    const r = M.ipcHandle['desktop:update-apply']?.({}, '1.0.0') as { ok: boolean; reason: string }
    expect(r.ok).toBe(false)
    expect(M.quitCalls).toBe(0)
  })

  it('就绪 + win 打包态 + 无他实例 → {ok:true} 且 app.quit 被调（意图退出，换目录在退出链兑现）', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    __setPendingUpdateForTest({ zipPath: join(M.home, 'z.zip'), sha256: ZIP_SHA, toVersion: '1.0.0' })
    const r = M.ipcHandle['desktop:update-apply']?.({}, '1.0.0')
    expect(r).toEqual({ ok: true })
    expect(M.quitCalls).toBe(1)
  })

  it('其他库实例在跑 → 拒绝且不退出（换目录会抽掉它们的底座）', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    __setPendingUpdateForTest({ zipPath: join(M.home, 'z.zip'), sha256: ZIP_SHA, toVersion: '1.0.0' })
    const lockDir = join(M.home, 'instances', 'otherlib')
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(join(lockDir, 'app-instance.lock'), JSON.stringify({ pid: process.pid, bootTime: Date.now() }))
    const r = M.ipcHandle['desktop:update-apply']?.({}, '1.0.0') as { ok: boolean; reason: string }
    expect(r.ok).toBe(false)
    expect(String(r.reason)).toContain('窗口')
    expect(M.quitCalls).toBe(0)
  })
})

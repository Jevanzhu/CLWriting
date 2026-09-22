/**
 * 阶段 53 S3：外链 IPC `desktop:open-external` 白名单（设计 D3/§3.4）。
 *
 * 安全缘起：URL 来自运行时数据（GitHub API 响应可被中间人/劫持 DNS 篡改），渲染层又
 * 把它交回主进程执行系统级打开动作——不做前缀校验等于把「在用户机器上打开任意网页/
 * 协议」的能力交给响应体。用例面 = 白名单内放行 + 五类拒绝（协议、host 后缀混淆、
 * host 前缀混淆、前缀陷阱、非字符串）+ shell 抛错契约化。
 *
 * 手法同 ipc-relaunch-delay-timer：electron / windows / workdir-controller 假件直驱
 * ipc.ts 注册面，shell.openExternal 换捕获件。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const M = vi.hoisted(() => ({
  ipcHandle: {} as Record<string, (e: unknown, ...a: unknown[]) => unknown>,
  opened: [] as string[],
  openExternalThrows: false,
  logWarns: [] as string[],
}))

vi.mock('electron', () => ({
  app: { quit: (): void => {}, getPath: (k: string) => `/fake/${k}` },
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
    showItemInFolder: (): void => {},
    openPath: async () => '',
    // 阶段 53 S3：外链捕获件（真实 Electron 返回 Promise）
    openExternal: async (url: string): Promise<void> => {
      if (M.openExternalThrows) throw new Error('no browser')
      M.opened.push(url)
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
  pickLibrary: async () => null,
  probeDirReachable: async () => 'ok',
  readStore: () => ({ current: null, recent: [] }),
  relaunch: (): void => {},
  resolveReachableWorkDir: async () => null,
  saveCurrentArmingRollback: () => null,
  warnIfCaseSensitive: async () => false,
}))
vi.mock('font-list', () => ({ getFonts: async () => [] }))
// warn 捕获：shell 失败分支不吃异常静默（ipc.ts 经 log.warn 留痕）
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

import { registerIpc, isAllowedExternalUrl } from '../../src/desktop/ipc.js'

const RELEASE_URL = 'https://github.com/Jevanzhu/CLWriting/releases/tag/v1.0.0'

function openExternal(url: unknown): Promise<unknown> {
  return Promise.resolve(M.ipcHandle['desktop:open-external']!({}, url))
}

beforeEach(() => {
  M.opened.length = 0
  M.openExternalThrows = false
  M.logWarns.length = 0
  registerIpc()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('阶段 53 S3：desktop:open-external 白名单', () => {
  it('白名单内放行：release tag 页（含 releases 根路径）→ shell.openExternal 调用 + {ok:true}', async () => {
    await expect(openExternal(RELEASE_URL)).resolves.toEqual({ ok: true })
    expect(M.opened).toEqual([RELEASE_URL])
    await expect(openExternal('https://github.com/Jevanzhu/CLWriting/releases')).resolves.toEqual({
      ok: true,
    })
    expect(M.opened).toHaveLength(2)
  })

  const rejects: Array<[string, unknown]> = [
    ['http 协议（非 https）', 'http://github.com/Jevanzhu/CLWriting/releases/tag/v1.0.0'],
    ['host 后缀混淆 github.com.evil.com', 'https://github.com.evil.com/Jevanzhu/CLWriting/releases'],
    ['host 前缀混淆 releases.evil.com', 'https://releases.evil.com/Jevanzhu/CLWriting/releases'],
    ['前缀陷阱 releasesx', 'https://github.com/Jevanzhu/CLWriting/releasesx'],
    ['他仓同形路径', 'https://github.com/other/Repo/releases/tag/v1.0.0'],
    ['非字符串（数字）', 42],
    ['非字符串（null）', null],
    ['非字符串（对象）', { url: RELEASE_URL }],
    ['不可解析串', 'not a url'],
    ['file 协议', 'file:///C:/Windows/System32/calc.exe'],
    ['javascript 协议', 'javascript:alert(1)'],
  ]

  for (const [name, url] of rejects) {
    it(`拒绝：${name} → {ok:false, reason} 且不触 shell`, async () => {
      const r = (await openExternal(url)) as { ok: boolean; reason?: string }
      expect(r.ok).toBe(false)
      expect(r.reason).toContain('GitHub 发布页')
      expect(r.reason).not.toContain('evil') // 不回显传入值（人话文案，防回显注入）
      expect(M.opened).toEqual([])
    })
  }

  it('shell 抛错 → 契约化失败（不抛给渲染层）+ warn 留痕', async () => {
    M.openExternalThrows = true
    const r = (await openExternal(RELEASE_URL)) as { ok: boolean; reason?: string }
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('复制链接')
    expect(M.logWarns.join('\n')).toContain('打开外部链接失败')
  })

  it('判定器直测（导出面）：只认本项目 release 前缀', () => {
    expect(isAllowedExternalUrl(RELEASE_URL)).toBe(true)
    expect(isAllowedExternalUrl('https://github.com/Jevanzhu/CLWriting/releases')).toBe(true)
    expect(isAllowedExternalUrl('https://github.com/other/Repo/releases')).toBe(false)
    expect(isAllowedExternalUrl(undefined)).toBe(false)
  })
})

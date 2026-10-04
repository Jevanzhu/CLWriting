/**
 * user-data-path.ts 单测——跨平台 APP 数据目录统一性（CLWriting 大写定值）。
 *
 * 核心回归：dev:app / 打包 / dev:api 三入口必须指向同一路径。
 * 若此路径再被改成跟随 app.name 的动态目录名，Linux（大小写敏感）上配置即分裂。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as os from 'node:os'
import { join } from 'node:path'
import {
  defaultUserDataPath,
  appDataHomeDir,
  instanceUserDataPath,
  libraryInstanceKey,
  WELCOME_INSTANCE_KEY,
  APP_DIR_NAME,
} from '../../src/fs/user-data-path.js'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: vi.fn(() => '/home/jevanzhu') }
})

const ORIG_PLATFORM = process.platform

function mockPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

afterEach(() => {
  mockPlatform(ORIG_PLATFORM)
  vi.unstubAllEnvs()
  vi.mocked(os.homedir).mockReset()
  vi.mocked(os.homedir).mockReturnValue('/home/jevanzhu')
})

describe('defaultUserDataPath 跨平台统一', () => {
  it('目录名恒为大写 CLWriting（不随 app.name）', () => {
    expect(APP_DIR_NAME).toBe('CLWriting')
  })

  it('darwin → ~/Library/Application Support/CLWriting', () => {
    mockPlatform('darwin')
    vi.mocked(os.homedir).mockReturnValue('/Users/jevanzhu')
    // Windows 无 POSIX 分隔：期望用 path.join 构造（与实现同源，win 下解析为反斜杠）
    expect(defaultUserDataPath()).toBe(join('/Users/jevanzhu', 'Library', 'Application Support', 'CLWriting'))
  })

  it('win32 无 APPDATA → AppData/Roaming/CLWriting（确定性回退）', () => {
    mockPlatform('win32')
    vi.stubEnv('APPDATA', '')
    vi.mocked(os.homedir).mockReturnValue('C:\\Users\\Jevan')
    expect(defaultUserDataPath()).toBe(join('C:\\Users\\Jevan', 'AppData', 'Roaming', 'CLWriting'))
  })

  it('R38-22: win32 有 APPDATA → $APPDATA/CLWriting（系统语义同源；域重定向场景不再脱节）', () => {
    mockPlatform('win32')
    vi.stubEnv('APPDATA', 'D:\\Redirected\\Roaming')
    vi.mocked(os.homedir).mockReturnValue('C:\\Users\\Jevan')
    expect(defaultUserDataPath()).toBe(join('D:\\Redirected\\Roaming', 'CLWriting'))
  })

  it('linux 无 XDG → ~/.config/CLWriting', () => {
    mockPlatform('linux')
    vi.stubEnv('XDG_CONFIG_HOME', '')
    vi.mocked(os.homedir).mockReturnValue('/home/jevanzhu')
    // Windows 无 POSIX 分隔：期望用 path.join 构造（与实现同源，win 下解析为反斜杠）
    expect(defaultUserDataPath()).toBe(join('/home/jevanzhu', '.config', 'CLWriting'))
  })

  it('linux 有 XDG_CONFIG_HOME → $XDG_CONFIG_HOME/CLWriting（Electron 同规则）', () => {
    mockPlatform('linux')
    vi.stubEnv('XDG_CONFIG_HOME', '/home/jevanzhu/.xdgconf')
    // Windows 无 POSIX 分隔：期望用 path.join 构造（与实现同源，win 下解析为反斜杠）
    expect(defaultUserDataPath()).toBe(join('/home/jevanzhu/.xdgconf', 'CLWriting'))
  })
})

// ── 多库多窗：共享根 / 实例目录 / instanceKey ──────────────

describe('多库多窗目录分工（共享根 vs 实例目录）', () => {
  it('appDataHomeDir = 缺省路径；CLW_SMOKE_USER_DATA 覆盖共享根（实例目录嵌套其下）', () => {
    mockPlatform('darwin')
    vi.mocked(os.homedir).mockReturnValue('/Users/jevanzhu')
    vi.stubEnv('CLW_SMOKE_USER_DATA', '')
    expect(appDataHomeDir()).toBe(defaultUserDataPath())
    expect(instanceUserDataPath('abc')).toBe(join(defaultUserDataPath(), 'instances', 'abc'))

    vi.stubEnv('CLW_SMOKE_USER_DATA', '/tmp/clw-smoke')
    expect(appDataHomeDir()).toBe('/tmp/clw-smoke')
    expect(instanceUserDataPath('abc')).toBe(join('/tmp/clw-smoke', 'instances', 'abc'))
  })

  it('welcome 固定 key 与库 key 不同形（不撞）', () => {
    expect(WELCOME_INSTANCE_KEY).toBe('welcome')
    expect(libraryInstanceKey('/libs/A')).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('libraryInstanceKey：折叠口径（大小写漂移归同 key，异库异 key）', () => {
  it('同库同 key；异库异 key', () => {
    mockPlatform('darwin')
    expect(libraryInstanceKey('/libs/A')).toBe(libraryInstanceKey('/libs/A'))
    expect(libraryInstanceKey('/libs/A')).not.toBe(libraryInstanceKey('/libs/B'))
  })

  it('darwin/win32：大小写漂移归同 key（盘符/目录大小写经启动器漂移不劈实例）', () => {
    mockPlatform('darwin')
    expect(libraryInstanceKey('/libs/Alpha')).toBe(libraryInstanceKey('/libs/alpha'))
    mockPlatform('win32')
    expect(libraryInstanceKey('C:\\Libs\\Alpha')).toBe(libraryInstanceKey('c:\\libs\\alpha'))
  })

  it('linux：大小写敏感——异名异 key（合法异名库共存不误并）', () => {
    mockPlatform('linux')
    expect(libraryInstanceKey('/libs/Alpha')).not.toBe(libraryInstanceKey('/libs/alpha'))
  })

  it('darwin：NFD/NFC 拼写归同 key（APFS 惯存分解形，与 samePath 同口径）', () => {
    mockPlatform('darwin')
    const nfc = '/libs/Caf\u00e9' // é 预组合
    const nfd = '/libs/Cafe\u0301' // e + 组合重音
    expect(nfd).not.toBe(nfc) // 前置：两串字节不同
    expect(libraryInstanceKey(nfd)).toBe(libraryInstanceKey(nfc))
  })

  it('win32/linux：不折叠 NFC/NFD（NTFS 与敏感 FS 上异形是不同目录）', () => {
    const nfd = '/libs/Cafe\u0301'
    const nfc = '/libs/Caf\u00e9'
    mockPlatform('win32')
    expect(libraryInstanceKey(nfd)).not.toBe(libraryInstanceKey(nfc))
    mockPlatform('linux')
    expect(libraryInstanceKey(nfd)).not.toBe(libraryInstanceKey(nfc))
  })
})

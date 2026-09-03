/**
 * user-data-path.ts 单测——跨平台 APP 数据目录统一性（CLWriting 大写定值）。
 *
 * 核心回归：dev:app / 打包 / dev:api 三入口必须指向同一路径。
 * 若此路径再被改成跟随 app.name 的动态目录名，Linux（大小写敏感）上配置即分裂。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as os from 'node:os'
import { join } from 'node:path'
import { defaultUserDataPath, APP_DIR_NAME } from '../../src/fs/user-data-path.js'

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
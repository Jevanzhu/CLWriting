/**
 * 0918三拍板批（KEK v2）回归：desktop OS 凭据通道 IKM 装置（loadOrGenerateOsKek）。
 *
 * 装置语义：safeStorage 只在主进程可用——main 生成/解锁 32 字节随机 IKM，密文落
 * userData/os-kek.json（safeStorage 加密 + 0600），明文经 env CLW_OS_KEK 注入 server
 * 子进程。不可用面统一回落 null（子进程 v1 内置通道语义，零悬崖）：
 * - isEncryptionAvailable false（linux 无钥匙串）
 * - decryptString 失败（Keychain 拒绝 / 跨账户恢复）且 providers.json 持 v2 凭据
 * 0918四轮修复批（C404）：①全失败路径 warn 留痕；②损坏自愈分档——providers.json
 * 无 v2 凭据（vault 不存在 / v1 内置通道，os IKM 零消费）→ 重建无损，重建成功；
 * 有 v2 凭据（或 providers.json 状态不明）→ 绝不重建（重建 = v2 凭据永久不可解），
 * null 回落 + 文件原字节保持 + warn 指引。
 *
 * 手法：vi.mock('electron') 假 safeStorage（可逆假加密：'enc:'+明文 base64）+
 * 真 fs 临时目录（atomicWriteFile 真链路）。生成→重载材料逐字节一致是安全面核心断言
 *（IKM 变了 = v2 vault 全部解不开）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// 可控开关（vi.mock 工厂提升作用域——vi.hoisted 共享可变槽位）；
// calls 计数（v1.0.0-rc.0 发布修复批）：守卫用例断言「翻译态早退不触任何 safeStorage
// 调用」——三个入口（isEncryptionAvailable/encryptString/decryptString）各计一槽
const safeState = vi.hoisted(() => ({ available: true, failDecrypt: false, calls: { avail: 0, enc: 0, dec: 0 } }))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => {
      safeState.calls.avail += 1
      return safeState.available
    },
    encryptString: (plainText: string) => {
      safeState.calls.enc += 1
      return Buffer.from(`enc:${plainText}`, 'utf8').toString('base64')
    },
    decryptString: (encrypted: Buffer) => {
      safeState.calls.dec += 1
      if (safeState.failDecrypt) throw new Error('Keychain 访问被拒绝（假件）')
      const raw = encrypted.toString('utf8')
      if (!raw.startsWith('enc:')) throw new Error('bad ciphertext（假件形态）')
      return raw.slice(4)
    },
  },
}))

import { isRosettaTranslated, loadOrGenerateOsKek } from '../../src/desktop/os-kek.js'

// 钥匙串通道搁置守卫（作者指令 2026-09-20）后，装置用例须显式关掉搁置开关才能
// 走真实生成/解锁通道；缺省（无 deps）形态由搁置守卫专属 describe 覆盖
const load = (ud: string, extra: { isRosetta?: () => boolean } = {}): Buffer | null =>
  loadOrGenerateOsKek(ud, { isShelved: () => false, ...extra })

const dirs: string[] = []

beforeEach(() => {
  safeState.available = true
  safeState.failDecrypt = false
  safeState.calls = { avail: 0, enc: 0, dec: 0 }
})

afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(): string {
  const d = mkdtempSync(join(tmpdir(), 'clw-oskek-'))
  dirs.push(d)
  return d
}

describe('KEK v2：loadOrGenerateOsKek 装置', () => {
  // Windows 无 POSIX 权限位（chmod/mode 为 no-op），仅 POSIX 断言 mode，守卫语义由 macOS/Linux CI 腿覆盖（CC-P2-3 先例 test/ai/calls.test.ts）
  it.skipIf(process.platform === 'win32')('无文件 → 生成：32 字节 IKM + os-kek.json 落盘（v1 形态 + 0600）', () => {
    const ud = setup()
    const kek = load(ud)
    expect(kek).not.toBeNull()
    expect(kek!.length).toBe(32)
    const fp = join(ud, 'os-kek.json')
    expect(existsSync(fp)).toBe(true)
    expect((statSync(fp).mode & 0o777).toString(8)).toBe('600')
    const raw = JSON.parse(readFileSync(fp, 'utf8')) as { v: number; sealed: string }
    expect(raw.v).toBe(1)
    expect(typeof raw.sealed).toBe('string')
  })

  it('生成 → 重载材料逐字节一致（IKM 变了 = v2 vault 全部解不开，安全面核心断言）', () => {
    const ud = setup()
    const first = load(ud)!
    const second = load(ud)!
    expect(Buffer.compare(first, second)).toBe(0)
  })

  it('isEncryptionAvailable false（linux 无钥匙串）→ null 且不落文件', () => {
    const ud = setup()
    safeState.available = false
    expect(load(ud)).toBeNull()
    expect(existsSync(join(ud, 'os-kek.json'))).toBe(false)
  })

  it('decryptString 失败（Keychain 拒绝/跨账户恢复）+ 无 v2 凭据 → 自愈重建出新 IKM（C404②）', () => {
    const ud = setup()
    const first = load(ud)!
    safeState.failDecrypt = true
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const second = load(ud)
    warnSpy.mockRestore()
    expect(second).not.toBeNull()
    expect(second!.length).toBe(32)
    expect(Buffer.compare(second!, first), '旧 IKM 零消费者（无 v2 vault），重建无损').not.toBe(0)
    // 重建后（假件解密恢复）新材料重载一致
    safeState.failDecrypt = false
    expect(Buffer.compare(load(ud)!, second!)).toBe(0)
  })

  it('decryptString 失败 + providers.json 持 v2 vault → null 回落且文件原字节保持（绝不重建）', () => {
    const ud = setup()
    load(ud)
    writeFileSync(
      join(ud, 'providers.json'),
      JSON.stringify({ vault: { v: 2, salt: 's', dek: { byOs: { iv: 'i', ct: 'c', tag: 't' } }, keys: {} } }),
      'utf8',
    )
    const sealedBefore = readFileSync(join(ud, 'os-kek.json'), 'utf8')
    safeState.failDecrypt = true
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(load(ud)).toBeNull()
      expect(readFileSync(join(ud, 'os-kek.json'), 'utf8'), 'v2 凭据在位：不重建（重建 = 永久不可解）').toBe(
        sealedBefore,
      )
      expect(warnSpy.mock.calls.some(([line]) => String(line).includes('不重建'))).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('文件损坏 / 形状不识别 + 无 v2 凭据 → 自愈重建成功（C404②）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ud = setup()
      writeFileSync(join(ud, 'os-kek.json'), '不是 JSON{{{', 'utf8')
      const kek = load(ud)
      expect(kek).not.toBeNull()
      expect(kek!.length).toBe(32)
      const raw = JSON.parse(readFileSync(join(ud, 'os-kek.json'), 'utf8')) as { v: number; sealed: string }
      expect(raw.v).toBe(1)
      expect(typeof raw.sealed).toBe('string')

      const ud2 = setup()
      writeFileSync(join(ud2, 'os-kek.json'), JSON.stringify({ v: 99, sealed: 'x' }), 'utf8')
      expect(load(ud2)).not.toBeNull()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('文件损坏 + providers.json 持 v2 vault → null 回落且文件原字节保持（绝不重建，C404②）', () => {
    const ud = setup()
    const broken = '不是 JSON{{{'
    writeFileSync(join(ud, 'os-kek.json'), broken, 'utf8')
    writeFileSync(
      join(ud, 'providers.json'),
      JSON.stringify({ vault: { v: 2, salt: 's', dek: { byOs: { iv: 'i', ct: 'c', tag: 't' } }, keys: {} } }),
      'utf8',
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(load(ud)).toBeNull()
      expect(readFileSync(join(ud, 'os-kek.json'), 'utf8'), '损坏文件保持原字节').toBe(broken)
      expect(warnSpy.mock.calls.some(([line]) => String(line).includes('不重建'))).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('文件损坏 + providers.json 解析失败（v2 存在与否不明）→ 保守不重建：null 且文件保持', () => {
    const ud = setup()
    const broken = '不是 JSON{{{'
    writeFileSync(join(ud, 'os-kek.json'), broken, 'utf8')
    writeFileSync(join(ud, 'providers.json'), '坏 JSON{{', 'utf8')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(load(ud)).toBeNull()
      expect(readFileSync(join(ud, 'os-kek.json'), 'utf8')).toBe(broken)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('文件损坏 + providers.json v1 vault（内置通道，os IKM 零消费）→ 自愈重建成功', () => {
    const ud = setup()
    writeFileSync(join(ud, 'os-kek.json'), JSON.stringify({ v: 99, sealed: 'x' }), 'utf8')
    writeFileSync(
      join(ud, 'providers.json'),
      JSON.stringify({ vault: { v: 1, salt: 's', dek: { byApp: { iv: 'i', ct: 'c', tag: 't' } }, keys: {} } }),
      'utf8',
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(load(ud)).not.toBeNull()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('文件缺失 + providers.json 持 v2 vault → null 回落且不落新文件（绝不重建，五轮重评修复批 D101 对称面）', () => {
    const ud = setup()
    writeFileSync(
      join(ud, 'providers.json'),
      JSON.stringify({ vault: { v: 2, salt: 's', dek: { byOs: { iv: 'i', ct: 'c', tag: 't' } }, keys: {} } }),
      'utf8',
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(load(ud)).toBeNull()
      // 原缺陷：缺失形态直达生成路径，新 IKM 静默落盘顶替（跨机迁移场景误导用户重配
      // key → saveProviders 覆盖 providers.json，可恢复凭据演化为永久丢失）
      expect(existsSync(join(ud, 'os-kek.json')), '缺失形态不得静默重建落新 IKM').toBe(false)
      expect(warnSpy.mock.calls.some(([line]) => String(line).includes('不重建'))).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('文件缺失 + providers.json v1 vault（os IKM 零消费）→ 首启新建语义不变（D101 不误伤零消费者）', () => {
    const ud = setup()
    writeFileSync(
      join(ud, 'providers.json'),
      JSON.stringify({ vault: { v: 1, salt: 's', dek: { byApp: { iv: 'i', ct: 'c', tag: 't' } }, keys: {} } }),
      'utf8',
    )
    const kek = load(ud)
    expect(kek).not.toBeNull()
    expect(kek!.length).toBe(32)
    expect(existsSync(join(ud, 'os-kek.json'))).toBe(true)
  })

  it('可用性翻转 false（已有文件）→ null；恢复 true → 材料不变', () => {
    const ud = setup()
    const first = load(ud)!
    safeState.available = false
    expect(load(ud)).toBeNull()
    safeState.available = true
    expect(Buffer.compare(load(ud)!, first)).toBe(0)
  })
})

describe('Rosetta 翻译态守卫（v1.0.0-rc.0 发布修复批）', () => {
  it('isRosettaTranslated 判据表：x64+任一 arm64 机型目录 → true；x64+Intel（无目录）→ false；arm64 原生（目录在）→ false', () => {
    // x64 进程 + /System/…/Rosetta 在（arm64 机型标志）→ 翻译态
    expect(
      isRosettaTranslated({
        arch: () => 'x64',
        exists: (p) => p === '/System/Library/CoreServices/Rosetta',
      }),
    ).toBe(true)
    // x64 进程 + 仅 /Library/Apple/usr/share/rosetta 在（备用路径同判）→ 翻译态
    expect(
      isRosettaTranslated({
        arch: () => 'x64',
        exists: (p) => p === '/Library/Apple/usr/share/rosetta',
      }),
    ).toBe(true)
    // x64 进程 + 仅 /Library/Apple/usr/libexec/oah 在（翻译运行时；macOS 26 实测
    // /System 族路径不落盘，/Library/Apple 族为稳态判据）→ 翻译态
    expect(
      isRosettaTranslated({
        arch: () => 'x64',
        exists: (p) => p === '/Library/Apple/usr/libexec/oah',
      }),
    ).toBe(true)
    // x64 进程 + 两路径皆无 → Intel 机型原生运行，不拦（Keychain 通道保持）
    expect(isRosettaTranslated({ arch: () => 'x64', exists: () => false })).toBe(false)
    // arm64 进程 + 目录在（arm64 Mac 常态）→ 原生进程，不拦
    expect(isRosettaTranslated({ arch: () => 'arm64', exists: () => true })).toBe(false)
  })

  it('翻译态 → null 回落、不落文件、不触任何 safeStorage 调用（守卫须先于死锁点）+ warn 留痕', () => {
    const ud = setup()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(load(ud, { isRosetta: () => true })).toBeNull()
      expect(existsSync(join(ud, 'os-kek.json'))).toBe(false)
      // 死锁点证明：isEncryptionAvailable/encryptString/decryptString 任一被调即可能挂
      //（实证栈是 SecItemAdd 写路径，但三入口同经 Security 框架，全零才是安全断言）
      expect(safeState.calls).toEqual({ avail: 0, enc: 0, dec: 0 })
      expect(warnSpy.mock.calls.some(([line]) => String(line).includes('Rosetta'))).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('非翻译态（isRosetta false）→ 正常生成通道不变（守卫不误伤）', () => {
    const ud = setup()
    const kek = load(ud, { isRosetta: () => false })
    expect(kek).not.toBeNull()
    expect(kek!.length).toBe(32)
    expect(existsSync(join(ud, 'os-kek.json'))).toBe(true)
    expect(safeState.calls.avail + safeState.calls.enc).toBeGreaterThan(0)
  })
})

describe('钥匙串通道搁置守卫（作者指令 2026-09-20「暂时搁置使用钥匙串的功能」）', () => {
  it('缺省（无 deps）→ null 回落、不落文件、不触任何 safeStorage 调用 + info 留痕（非 warn）', () => {
    const ud = setup()
    const infoSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(loadOrGenerateOsKek(ud)).toBeNull()
      expect(existsSync(join(ud, 'os-kek.json'))).toBe(false)
      // 守卫须先于一切 safeStorage 调用（搁置 = 弹窗面归零的安全断言，计数口径同 Rosetta 守卫）
      expect(safeState.calls).toEqual({ avail: 0, enc: 0, dec: 0 })
      // R0916-7-P3-18：搁置是发行期预期稳态（不是异常），日志降 info 且不带源码修改指引
      expect(infoSpy.mock.calls.some(([line]) => String(line).includes('钥匙串通道当前未启用'))).toBe(true)
      expect(warnSpy.mock.calls.some(([line]) => String(line).includes('搁置'))).toBe(false)
      // 内部指令不得出现在任何面向作者的出口（提示作者去改源码常量属开发指令泄漏）
      expect(infoSpy.mock.calls.some(([line]) => String(line).includes('OS_KEK_SHELVED'))).toBe(false)
    } finally {
      infoSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  it('isShelved false → 生成通道恢复（守卫不误伤，恢复面正向对照）', () => {
    const ud = setup()
    const kek = loadOrGenerateOsKek(ud, { isShelved: () => false })
    expect(kek).not.toBeNull()
    expect(kek!.length).toBe(32)
    expect(existsSync(join(ud, 'os-kek.json'))).toBe(true)
  })
})

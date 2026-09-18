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

// 可控开关（vi.mock 工厂提升作用域——vi.hoisted 共享可变槽位）
const safeState = vi.hoisted(() => ({ available: true, failDecrypt: false }))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => safeState.available,
    encryptString: (plainText: string) => Buffer.from(`enc:${plainText}`, 'utf8').toString('base64'),
    decryptString: (encrypted: Buffer) => {
      if (safeState.failDecrypt) throw new Error('Keychain 访问被拒绝（假件）')
      const raw = encrypted.toString('utf8')
      if (!raw.startsWith('enc:')) throw new Error('bad ciphertext（假件形态）')
      return raw.slice(4)
    },
  },
}))

import { loadOrGenerateOsKek } from '../../src/desktop/os-kek.js'

const dirs: string[] = []

beforeEach(() => {
  safeState.available = true
  safeState.failDecrypt = false
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
    const kek = loadOrGenerateOsKek(ud)
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
    const first = loadOrGenerateOsKek(ud)!
    const second = loadOrGenerateOsKek(ud)!
    expect(Buffer.compare(first, second)).toBe(0)
  })

  it('isEncryptionAvailable false（linux 无钥匙串）→ null 且不落文件', () => {
    const ud = setup()
    safeState.available = false
    expect(loadOrGenerateOsKek(ud)).toBeNull()
    expect(existsSync(join(ud, 'os-kek.json'))).toBe(false)
  })

  it('decryptString 失败（Keychain 拒绝/跨账户恢复）+ 无 v2 凭据 → 自愈重建出新 IKM（C404②）', () => {
    const ud = setup()
    const first = loadOrGenerateOsKek(ud)!
    safeState.failDecrypt = true
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const second = loadOrGenerateOsKek(ud)
    warnSpy.mockRestore()
    expect(second).not.toBeNull()
    expect(second!.length).toBe(32)
    expect(Buffer.compare(second!, first), '旧 IKM 零消费者（无 v2 vault），重建无损').not.toBe(0)
    // 重建后（假件解密恢复）新材料重载一致
    safeState.failDecrypt = false
    expect(Buffer.compare(loadOrGenerateOsKek(ud)!, second!)).toBe(0)
  })

  it('decryptString 失败 + providers.json 持 v2 vault → null 回落且文件原字节保持（绝不重建）', () => {
    const ud = setup()
    loadOrGenerateOsKek(ud)
    writeFileSync(
      join(ud, 'providers.json'),
      JSON.stringify({ vault: { v: 2, salt: 's', dek: { byOs: { iv: 'i', ct: 'c', tag: 't' } }, keys: {} } }),
      'utf8',
    )
    const sealedBefore = readFileSync(join(ud, 'os-kek.json'), 'utf8')
    safeState.failDecrypt = true
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(loadOrGenerateOsKek(ud)).toBeNull()
      expect(readFileSync(join(ud, 'os-kek.json'), 'utf8'), 'v2 凭据在位：不重建（重建 = 永久不可解）').toBe(sealedBefore)
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
      const kek = loadOrGenerateOsKek(ud)
      expect(kek).not.toBeNull()
      expect(kek!.length).toBe(32)
      const raw = JSON.parse(readFileSync(join(ud, 'os-kek.json'), 'utf8')) as { v: number; sealed: string }
      expect(raw.v).toBe(1)
      expect(typeof raw.sealed).toBe('string')

      const ud2 = setup()
      writeFileSync(join(ud2, 'os-kek.json'), JSON.stringify({ v: 99, sealed: 'x' }), 'utf8')
      expect(loadOrGenerateOsKek(ud2)).not.toBeNull()
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
      expect(loadOrGenerateOsKek(ud)).toBeNull()
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
      expect(loadOrGenerateOsKek(ud)).toBeNull()
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
      expect(loadOrGenerateOsKek(ud)).not.toBeNull()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('可用性翻转 false（已有文件）→ null；恢复 true → 材料不变', () => {
    const ud = setup()
    const first = loadOrGenerateOsKek(ud)!
    safeState.available = false
    expect(loadOrGenerateOsKek(ud)).toBeNull()
    safeState.available = true
    expect(Buffer.compare(loadOrGenerateOsKek(ud)!, first)).toBe(0)
  })
})

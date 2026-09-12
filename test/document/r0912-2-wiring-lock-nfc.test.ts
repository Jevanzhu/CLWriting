/**
 * 重评-0912-2 P2-3（2026-09-12 全量重评修复批）回归：布线锁键补 NFC 归一。
 *
 * 修复前：service wiringFileLockKey（保存链）/ lead-finalize wiringFileLockKeyOf
 * （终稿链）/ files.ts wiringLockKeyForPut（PUT 直写）三侧锁键都只过 platformCaseFold
 * （大小写折叠），而文档身份键 docJoinKey = relPathKey(toNfcName(p))（R41-2）叠加了
 * NFC——mac 上清单登记路径（NFC 为主）与磁盘扫描路径（NFD，外源工具常产）对同一
 * 布线文件派生两个不同 `.lock` 文件名，保存链与终稿链（锁内重读-合并-写回）互斥
 * 静默失效（丢失更新窗）。修复后：三侧统一「先 toNfcName 后 platformCaseFold」
 * （与 docJoinKey 同序）。
 *
 * 断言形态学 r45-casefold-keys.test.ts：service 私有方法 as unknown as 直调（全仓
 * 既有做法）；精确钉定键字节——NFC 输入键与修前逐位一致（R45-2 字节稳定不变量
 * 防回归），仅 NFD 输入键变化。行为级：真实跨进程文件锁——终稿链键（NFD 磁盘
 * 路径派生）持锁后，保存链键（NFC 清单 relPath 派生）请求同一锁文件自锁超时，
 * 互斥成立（修前两键相异则第二把锁直接得手，本用例红）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DocumentService } from '../../src/document/service.js'
import { wiringFileLockKeyOf } from '../../src/document/lead-finalize.js'
import { acquireCrossProcessLockWithTimeout } from '../../src/fs/cross-process-lock.js'

const ORIG_PLATFORM = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true })
})

/** 类私有方法测试直调形态（r45-casefold-keys 先例）。 */
type SvcWithWiringKey = { wiringFileLockKey(rel: string): string | null }

/** 布线文件 relPath（NFC 清单登记形态）：目录段与文件名段各含一个可分解字符
 *  （é U+00E9 / ü U+00FC），NFD 磁盘形态经 `normalize('NFD')` 逆构造（mac APFS
 *  惯存分解形，外源工具常产）；「布线」「悬念」等 CJK 无分解形，两形态同字节。 */
const NFC_REL = '布线/悬念/0001-café/线索-ü.md'
const NFD_REL = NFC_REL.normalize('NFD')

/** 两形态必须确属不同字节（构造自检——否则本文件全部断言退化空转）。 */
expect(NFD_REL).not.toBe(NFC_REL)

function withTempRoot(prefix: string, run: (root: string, svc: SvcWithWiringKey) => void): void {
  const root = mkdtempSync(join(tmpdir(), prefix))
  try {
    const svc = new DocumentService({ bookRoot: root }) as unknown as SvcWithWiringKey
    run(root, svc)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('重评-0912-2 P2-3: 布线锁键 NFC 归一（NFC 清单形态 vs NFD 磁盘形态同键）', () => {
  it('darwin / win32：service（NFC relPath）与 wiringFileLockKeyOf（同文件 NFD abs）逐位同键', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
      withTempRoot(`r0912-nfc-${platform}-`, (root, svc) => {
        const svcKey = svc.wiringFileLockKey(NFC_REL)
        const leadKey = wiringFileLockKeyOf(join(root, NFD_REL))
        expect(svcKey).not.toBeNull()
        // 核心断言：修前此两键相异（NFD 拆解字节直入键名）→ 互斥静默失效；修后并齐
        expect(svcKey).toBe(leadKey)
        // 键字节恰为 NFC 形态折叠值——NFD 输入被归一，而非各自保留形态
        expect(svcKey).toBe(`${join(root, NFC_REL).toLowerCase()}.lock`)
        // 保存链自身收到 NFD 扫描形态 relPath（树扫描入口）也同键
        expect(svc.wiringFileLockKey(NFD_REL)).toBe(svcKey)
        // 前缀过滤留调用点：非布线文件不加锁（归一不改前缀判定面）
        expect(svc.wiringFileLockKey(`写作/正文/0001-café.md`)).toBeNull()
      })
    }
  })

  it('linux 对照：不做大小写折叠但 toNfcName 无条件归一——NFD/NFC 输入仍同键', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    withTempRoot('r0912-nfc-linux-', (root, svc) => {
      const svcKey = svc.wiringFileLockKey(NFC_REL)
      expect(svcKey).toBe(wiringFileLockKeyOf(join(root, NFD_REL)))
      expect(svcKey).toBe(`${join(root, NFC_REL)}.lock`)
      // 仅 NFD 输入键变化（修前 linux 臂为 NFD 原样拼 .lock）的证据
      expect(svcKey).not.toBe(`${join(root, NFD_REL)}.lock`)
    })
  })
})

describe('重评-0912-2 P2-3: NFC 输入键字节不变（R45-2 字节稳定不变量防回归）', () => {
  it('win32 / darwin：NFC 输入键 = 折叠值 + .lock，与修前逐位一致', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
      withTempRoot(`r0912-nfc-stable-${platform}-`, (root, svc) => {
        const before = `${join(root, NFC_REL).toLowerCase()}.lock`
        expect(svc.wiringFileLockKey(NFC_REL)).toBe(before)
        expect(wiringFileLockKeyOf(join(root, NFC_REL))).toBe(before)
      })
    }
  })

  it('linux：NFC 输入键 = 原样 + .lock，与修前逐位一致（不折叠臂不受本修影响）', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    withTempRoot('r0912-nfc-stable-linux-', (root, svc) => {
      const before = `${join(root, NFC_REL)}.lock`
      expect(svc.wiringFileLockKey(NFC_REL)).toBe(before)
      expect(wiringFileLockKeyOf(join(root, NFC_REL))).toBe(before)
    })
  })
})

describe('重评-0912-2 P2-3: 行为级——保存链与终稿链物理互斥（真实跨进程锁）', () => {
  it('终稿链以 NFD 磁盘路径持锁后，保存链以 NFC 清单路径派生同键自锁超时', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    withTempRoot('r0912-nfc-behavior-', (root, svc) => {
      const nfdAbs = join(root, NFD_REL)
      const leadKey = wiringFileLockKeyOf(nfdAbs)
      const release = acquireCrossProcessLockWithTimeout(leadKey, 5_000)
      expect(release).not.toBeNull()
      try {
        // 保存链 executeSave 入口口径：NFC 清单形态 relPath 派生布线锁键
        const svcKey = svc.wiringFileLockKey(NFC_REL)
        expect(svcKey).toBe(leadKey) // 同一物理锁文件（盘上真实存在）
        expect(svcKey).not.toBeNull()
        const second = acquireCrossProcessLockWithTimeout(svcKey!, 150)
        expect(second).toBeNull() // 自锁超时 = 互斥成立（修前两键相异则此处直接得手）
      } finally {
        release!()
      }
    })
  })
})

describe('重评-0912-2 P2-3: files.ts PUT 侧同批修齐（模块私有，静态扫描先例锁定）', () => {
  const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

  /** 剥注释行后扫描（r45-casefold-keys / r38-batch-f 消费点扫描同款）。 */
  function codeOf(rel: string): string {
    return readFileSync(join(SRC_ROOT, rel), 'utf-8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n')
  }

  it('三侧键派生均为「platformCaseFold(toNfcName(…))」序（NFC 在折叠内，序不可倒置）', () => {
    expect(codeOf('document/service.ts')).toContain('platformCaseFold(toNfcName(key))')
    expect(codeOf('studio/server/api/files.ts')).toContain('platformCaseFold(toNfcName(key))')
    expect(codeOf('document/lead-finalize.ts')).toContain('platformCaseFold(toNfcName(absFile))')
  })
})

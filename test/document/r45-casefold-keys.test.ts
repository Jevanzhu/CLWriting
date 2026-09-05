/**
 * R45-2（四十五轮）回归：win32 大小写折叠口径六处收编 platformCaseFold 单源。
 *
 * 修复前全仓六处各自手写 win32 折叠（relPathKey / caseFoldKey / manifestLockKey /
 * service wiringFileLockKey / lead-finalize wiringFileLockKeyOf / files.ts
 * wiringLockKeyForPut），语义逐位一致但漂移无锁——某处漏折叠/多折叠即布线锁互斥
 * 静默失效或身份误判。收编后统一委托 safe-path.ts platformCaseFold（只折叠，不含
 * 分隔符归一 / NFC / resolve，各管线留在调用点）。硬性不变量：锁键派生磁盘真实
 * 锁文件名，键字节与收编前逐位一致（新旧版本进程混跑时锁互斥仍成立）。
 *
 * 可达性：service wiringFileLockKey 为类私有（as unknown as 直调，全仓既有做法）；
 * files.ts wiringLockKeyForPut 与 document manifestLockKey 为模块私有——前者按
 * r38-batch-f.test.ts 消费点静态扫描先例锁定委托；后者走 withManifestLock 重入
 * 行为面锚定（r35-manifest-lock-async 先例：重入键即 manifestLockKey 归一结果）。
 */
import { expect, afterEach, describe, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DocumentService } from '../../src/document/service.js'
import {
  withManifestLock,
  __setManifestLockTimeoutForTest,
  MANIFEST_LOCK_TIMEOUT_MS,
} from '../../src/document/manifest.js'
import { wiringFileLockKeyOf } from '../../src/document/lead-finalize.js'
import { relPathKey, platformCaseFold } from '../../src/fs/safe-path.js'
import { caseFoldKey } from '../../src/knowledge/manifest.js'

/** 物理取锁请求记录（r38-batch-f failState 同款 vi.hoisted 模式）。
 *  manifestLockKey 键折叠的行为面观测用——case 变体的物理锁文件在 mac 不敏感 FS 上
 *  与原路径同文件、在 linux 敏感 FS 上互异，「成功/自锁超时」两种结局随宿主漂移；
 *  而是否发起**第二次物理取锁请求**（vs 命中重入计数零取锁）在任一宿主都确定。 */
const lockState = vi.hoisted(() => ({ requests: [] as string[] }))
vi.mock('../../src/fs/cross-process-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/fs/cross-process-lock.js')>()
  return {
    ...actual,
    acquireCrossProcessLockWithTimeout: (path: string, ms: number) => {
      lockState.requests.push(path)
      return actual.acquireCrossProcessLockWithTimeout(path, ms)
    },
  }
})

const ORIG_PLATFORM = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true })
  __setManifestLockTimeoutForTest(MANIFEST_LOCK_TIMEOUT_MS)
})

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

/** 类私有方法测试直调形态（全仓既有 as unknown as 先例）。 */
type SvcWithWiringKey = { wiringFileLockKey(rel: string): string | null }

describe('R45-2: 三侧布线锁同键（win32 钉定）', () => {
  it('同一 rel 下 service / lead-finalize 产出同一锁文件名（字节逐位一致）', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const root = mkdtempSync(join(tmpdir(), 'r45-fold-'))
    try {
      const svc = new DocumentService({ bookRoot: root }) as unknown as SvcWithWiringKey
      const rel = '布线/悬念/0001-线索.md'
      const svcKey = svc.wiringFileLockKey(rel)
      const leadKey = wiringFileLockKeyOf(join(root, rel))
      expect(svcKey).not.toBeNull()
      expect(svcKey).toBe(leadKey)
      // 精确字节钉定：join(root, rel) 小写折叠 + '.lock'（与收编前手写实现逐位一致）
      expect(svcKey).toBe(`${join(root, rel).toLowerCase()}.lock`)
      // 前缀过滤留调用点：非布线文件不加锁（win32 下亦然）
      expect(svc.wiringFileLockKey('写作/正文/0001-章.md')).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('win32 折叠 + posix 对照（折叠原语只折叠、不归一）', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    expect(platformCaseFold('布线/X.MD')).toBe('布线/x.md')
    expect(platformCaseFold('布线\\X.MD')).toBe('布线\\x.md') // 反斜杠原样保留——分隔符归一不在单源内
    expect(relPathKey('布线/X.md')).toBe(relPathKey('布线/x.md'))
    expect(caseFoldKey('知识层/A.md')).toBe(caseFoldKey('知识层/a.md'))
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    expect(platformCaseFold('布线\\X.MD')).toBe('布线\\X.MD')
    expect(relPathKey('布线/X.md')).not.toBe(relPathKey('布线/x.md'))
    expect(caseFoldKey('知识层/A.md')).not.toBe(caseFoldKey('知识层/a.md'))
  })
})

describe('R45-2: manifestLockKey win32 折叠（行为面，r35 重入键先例）', () => {
  it('win32：case 变体重入命中同键——内层不发起第二次物理取锁（折叠生效）', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const root = mkdtempSync(join(tmpdir(), 'r45-mlock-'))
    __setManifestLockTimeoutForTest(50)
    try {
      mkdirSync(join(root, '项目'), { recursive: true })
      const outer = join(root, '项目', '文档清单.jsonl')
      const variant = join(root, '项目', '文档清单.JSONL') // 仅大小写异
      lockState.requests = []
      let innerRan = false
      withManifestLock(outer, () => {
        withManifestLock(variant, () => { innerRan = true })
      })
      expect(innerRan).toBe(true)
      // 折叠生效：内层命中重入计数，全程只有外层一次物理取锁
      //（回归手写/漏折叠 → 内层按「他锁」二次取锁，mac 不敏感 FS 上自锁超时抛错，均红）
      expect(lockState.requests).toEqual([`${outer}.lock`])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('posix 对照：不折叠 → case 变体是不同键，内层按「他锁」发起二次物理取锁', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const root = mkdtempSync(join(tmpdir(), 'r45-mlock-p-'))
    __setManifestLockTimeoutForTest(50)
    try {
      mkdirSync(join(root, '项目'), { recursive: true })
      const outer = join(root, '项目', '文档清单.jsonl')
      const variant = join(root, '项目', '文档清单.JSONL')
      lockState.requests = []
      // mac 不敏感 FS 上变体锁与外层持锁物理同文件 → 内层超时抛错；linux 上取到第二把
      // 锁成功——两种结局都证明内层未命中重入键（键不同），故吞抛只看取锁请求序列
      try {
        withManifestLock(outer, () => {
          withManifestLock(variant, () => { /* linux 腿在此执行；mac 腿自锁超时不达 */ })
        })
      } catch { /* 见上：自锁超时即「他锁」证据之一 */ }
      // 首次物理取锁 = 外层；其后全部为变体锁（mac 重试两轮 2 次、linux 1 次，≥1 即可）
      expect(lockState.requests[0]).toBe(`${outer}.lock`)
      expect(lockState.requests.length).toBeGreaterThanOrEqual(2)
      expect(new Set(lockState.requests.slice(1))).toEqual(new Set([`${variant}.lock`]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('R45-2: 收编面静态扫描（r38-batch-f 消费点扫描先例）', () => {
  const DELEGATING = [
    'knowledge/manifest.ts',
    'document/manifest.ts',
    'document/service.ts',
    'document/lead-finalize.ts',
    'studio/server/api/files.ts',
  ]
  /** 剥注释行后扫描（对齐 r38-batch-f R38-18 做法，注释提及不误报）。 */
  function codeOf(rel: string): string {
    return readFileSync(join(SRC_ROOT, rel), 'utf-8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n')
  }

  it('五处调用点委托 platformCaseFold，手写 win32 折叠归零', () => {
    for (const f of DELEGATING) {
      const code = codeOf(f)
      expect(code.includes('platformCaseFold('), `${f} 缺 platformCaseFold 委托`).toBe(true)
      expect(code.includes("process.platform === 'win32'"), `${f} 残留手写 win32 折叠`).toBe(false)
    }
  })

  it('单源 safe-path.ts 恰存一处 win32 判定（platformCaseFold 本体）', () => {
    const code = codeOf('fs/safe-path.ts')
    expect(code.split("process.platform === 'win32'").length - 1).toBe(1)
    expect(code.includes('platformCaseFold(key: string)')).toBe(true)
  })
})

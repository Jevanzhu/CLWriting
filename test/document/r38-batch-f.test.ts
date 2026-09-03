/**
 * R38-13/R38-14/R38-18（三十八轮批 F）回归。
 *
 * R38-13：migrateVersionsDir（.snapshots → .版本）收编 renameWithRetry——win 瞬时
 * 占用（杀软/索引器/同步盘）整目录 rename EPERM 不再直接失败（退避自愈，失败语义
 * 不变：warn + false 幂等重试）。
 * R38-14：数据面路径身份比较折叠——relPathKey（分隔符归一 + win32 大小写折叠）单测
 * 锚定平台语义；service/export/overview 消费点以静态扫描防回退。
 * R38-18：启动迁移链（migrate-layout v2/v3）rename 全量收编 renameWithRetry（静态
 * 站点扫描，扩展 test/fs/mp2-3-rename-retry-sites 先例）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const failState = vi.hoisted(() => ({
  /** 命中即抛一次 EPERM 后放行（瞬时锁形态）。 */
  failWhen: null as ((from: string, to: string) => boolean) | null,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (failState.failWhen?.(from, to)) {
        failState.failWhen = null
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' })
      }
      return actual.renameSync(from, to)
    },
  }
})

import { migrateVersionsDir } from '../../src/document/version.js'
import { relPathKey } from '../../src/fs/safe-path.js'

const ORIG_PLATFORM = process.platform
afterEach(() => {
  failState.failWhen = null
  Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true })
})

describe('R38-13: migrateVersionsDir 穿透 win 瞬时锁', () => {
  it('整目录 rename 撞一次 EPERM → 退避后迁移成功（.snapshots → .版本）', () => {
    const root = mkdtempSync(join(tmpdir(), 'r38-vmig-'))
    try {
      const legacy = join(root, '工作区', '.snapshots')
      const target = join(root, '工作区', '.版本')
      mkdirSync(legacy, { recursive: true })
      writeFileSync(join(legacy, 'a.json'), '{}', 'utf-8')
      failState.failWhen = (from) => from === legacy

      expect(migrateVersionsDir(root)).toBe(true)
      expect(existsSync(target)).toBe(true)
      expect(existsSync(legacy)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('R38-14: relPathKey 平台语义', () => {
  it('posix：分隔符归一为 /，大小写保持', () => {
    // R40-3（四十轮）：posix 语义须显式钉平台——原无守卫，win 宿主上按 win32 折叠
    // 语义跑「大小写保持」断言恒红（四十轮门禁基线唯一确定性败；对齐下方 win32 用例同款 mock）
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    expect(relPathKey('写作\\正文\\01-章.md')).toBe('写作/正文/01-章.md')
    expect(relPathKey('写作/正文/01-章.md')).toBe('写作/正文/01-章.md')
    expect(relPathKey('写作/A.md')).not.toBe('写作/a.md')
  })

  it('win32：大小写折叠（外部 case-only 改名后身份相等）', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    expect(relPathKey('写作/正文/01-章.md')).toBe(relPathKey('写作\\正文\\01-章.MD'))
    expect(relPathKey('布线/悬念/X.md')).toBe(relPathKey('布线/悬念/x.md'))
  })
})

describe('R38-18: 启动迁移链退避收编（静态站点扫描）', () => {
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
  it('migrate-layout v2/v3 零裸 renameSync 调用', () => {
    for (const f of ['install/migrate-layout-v2.ts', 'install/migrate-layout-v3.ts']) {
      const src = readFileSync(join(srcRoot, f), 'utf-8')
      const code = src
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n')
      expect(code.includes('renameSync('), `${f} 存在裸 renameSync`).toBe(false)
      expect(code.includes('renameWithRetry('), `${f} 缺 renameWithRetry`).toBe(true)
    }
  })

  it('R38-14 消费点静态扫描：service/export/overview 身份比较走折叠键（R41-2 起为 docJoinKey）', () => {
    // R41-2（四十一轮）契约演进：三处身份比较由 relPathKey 升 docJoinKey
    //（relPathKey 折叠 + NFC 归一，safe-path.ts 单源）——静态断言随行改扫 docJoinKey
    for (const f of ['document/service.ts', 'export/index.ts', 'studio/server/api/overview.ts']) {
      const src = readFileSync(join(srcRoot, f), 'utf-8')
      expect(src.includes('docJoinKey'), `${f} 缺 docJoinKey 收编`).toBe(true)
    }
  })
})

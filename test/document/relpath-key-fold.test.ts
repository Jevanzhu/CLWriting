/**
 * R38-13/R38-14/R38-18（三十八轮批 F）回归。
 *
 * R38-13：migrateVersionsDir（.snapshots → .版本）收编 renameWithRetry——win 瞬时
 * 占用（杀软/索引器/同步盘）整目录 rename EPERM 不再直接失败（退避自愈，失败语义
 * 不变：warn + false 幂等重试）。
 * R38-14：数据面路径身份比较折叠——relPathKey / docJoinKey（分隔符归一 + win32 大小写
 * 折叠 + NFC）以表驱动钉平台语义；消费点（service/export/overview 身份比较）行为面见
 * test/document/join-keys.test.ts、casefold-keys.test.ts、trash-fold-copy-prefix.test.ts。
 * R38-18：启动迁移链（migrate-layout v2/v3）rename 全量收编 renameWithRetry——目录级
 * 扫描 src/install/**.ts（新增文件自动在射程内，不再逐点列举）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdirSync, readdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempTracked } from '../helpers/temp-dir.js'

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
import { docJoinKey, relPathKey } from '../../src/fs/safe-path.js'

const ORIG_PLATFORM = process.platform
afterEach(() => {
  failState.failWhen = null
  Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true })
})

describe('R38-13: migrateVersionsDir 穿透 win 瞬时锁', () => {
  it('整目录 rename 撞一次 EPERM → 退避后迁移成功（.snapshots → .版本）', () => {
    const root = mkdtempTracked(join(tmpdir(), 'r38-vmig-'))
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
  it('posix：分隔符保持字面（`\\` 是合法文件名字符——复审-0913-mac适配 P3-2），大小写保持', () => {
    // R40-3（四十轮）：posix 语义须显式钉平台——原无守卫，win 宿主上按 win32 折叠
    // 语义跑「大小写保持」断言恒红（四十轮门禁基线唯一确定性败；对齐下方 win32 用例同款 mock）
    // 复审-0913-mac适配 P3-2：分隔符归一收窄 win32-only——R38-14 时点的 posix 臂
    // 「`\` 归一为 /」不再成立，字面 `\` 保留（win 历史遗留反斜杠清单路径的归一
    // 兼容由 win32 臂承担）
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    expect(relPathKey('写作\\正文\\01-章.md')).toBe('写作\\正文\\01-章.md')
    expect(relPathKey('写作/正文/01-章.md')).toBe('写作/正文/01-章.md')
    expect(relPathKey('写作/A.md')).not.toBe('写作/a.md')
  })

  it('win32：大小写折叠（外部 case-only 改名后身份相等）', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    expect(relPathKey('写作/正文/01-章.md')).toBe(relPathKey('写作\\正文\\01-章.MD'))
    expect(relPathKey('布线/悬念/X.md')).toBe(relPathKey('布线/悬念/x.md'))
  })
})

describe('R38-18: 启动迁移链退避收编（目录级机制扫描）', () => {
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

  /** 逐行剥注释后的代码文本（注释里的提法不算调用点）。 */
  const codeOf = (src: string): string =>
    src
      .split(String.fromCharCode(10))
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join(String.fromCharCode(10))

  it('install/ 全目录零裸 renameSync 调用（目录级扫描——新增文件自动在射程内）', () => {
    const dir = join(srcRoot, 'install')
    const files = (readdirSync(dir, { recursive: true, encoding: 'utf-8' }) as string[]).filter((f) => f.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0) // 扫描面非空（防目录改名后断言空转）
    for (const f of files) {
      const code = codeOf(readFileSync(join(dir, f), 'utf-8'))
      expect(code.includes('renameSync('), `install/${f} 存在裸 renameSync`).toBe(false)
    }
    // 迁移链本体确已委托退避原语（防「删掉调用」式假绿）
    const v2 = readFileSync(join(dir, 'migrate-layout-v2.ts'), 'utf-8')
    const v3 = readFileSync(join(dir, 'migrate-layout-v3.ts'), 'utf-8')
    expect(v2.includes('renameWithRetry(')).toBe(true)
    expect(v3.includes('renameWithRetry(')).toBe(true)
  })
})

describe('R38-14/R41-2: docJoinKey 折叠键机制单源（表驱动）', () => {
  it.each([
    ['win32', '写作/正文/01-章.md', String.raw`写作\正文\01-章.MD`, true],
    ['win32', '布线/悬念/X.md', '布线/悬念/x.md', true],
    ['win32', '写作/正文/Ａ.md', '写作/正文/A.md', false], // 全角不折叠（只做 toLowerCase）
    ['linux', '写作/正文/01-章.md', '写作/正文/01-章.md', true],
    ['linux', '写作/正文/01-章.md', '写作/正文/01-章.MD', false],
  ] as const)('platform=%s：docJoinKey(%j) 与 %j 的同键判定=%s', (platform, a, b, same) => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    expect(docJoinKey(a) === docJoinKey(b)).toBe(same)
  })

  it('NFC 归一叠加在折叠之上（NFD 文件名与 NFC 登记路径同键）', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const nfc = '写作/正文/01-é.md' // é = U+00E9
    const nfd = '写作/正文/01-é.md' // e + U+0301 组合音符
    expect(docJoinKey(nfc)).toBe(docJoinKey(nfd))
  })
})

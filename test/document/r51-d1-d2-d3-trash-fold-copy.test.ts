/**
 * R51-D-1 / D-2 / D-3（五十一轮）回归——路径身份域三修。
 *
 * D-1：restore/purge 的 `.trash/` 前缀校验从原始串 startsWith 改为 resolveWithinRoot
 *   的**规范化 rel**——`工作区/.trash/../../写作/正文/x.md` 穿越形态原词法前缀命中、
 *   `.abs` 消解 `..` 后落书内任意路径（篡改 trash-manifest 可 purge 书内任意文件，
 *   Y-18/R27-49 防线失效）；.trash 内 symlink 指书内他处同被 realpath 识破。
 * D-2：platformCaseFold / samePath 折叠面 win32 → win32+darwin（单源同批同口径）——
 *   mac 默认卷 APFS 大小写不敏感，posix 臂不折叠使清单锁键/docJoinKey 对 case 变体
 *   失明（R26-6 族 lost update 在 mac 复现）；行为面以 withManifestLock case 变体
 *   重入锁定（r45-2 win32 用例的 darwin 孪生，是否发起第二次物理取锁任一宿主确定）。
 * D-3：doCopy 目录段「已存在则原样保留」分支对 `a/..` 恒命中（existsSync(join(root,
 *   'a','..')) 即 root 本身），`..` 段原文进入清单登记 → 物理落位（归一）与登记
 *   （原文）不一致，docId 身份分裂、保存恒 REVISION_CONFLICT；前置拒绝（doCreate
 *   原始 relPath PATH_ESCAPE 前置同口径）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { restoreTrash, purgeTrash, appendTrashEntry } from '../../src/document/trash.js'
import { DocumentService } from '../../src/document/service.js'
import { legacyId } from '../../src/document/stable-id.js'
import {
  withManifestLock,
  __setManifestLockTimeoutForTest,
  MANIFEST_LOCK_TIMEOUT_MS,
} from '../../src/document/manifest.js'
import { platformCaseFold, relPathKey } from '../../src/fs/safe-path.js'
import { samePath } from '../../src/fs/user-data-path.js'

/** 物理取锁请求记录（r45-casefold-keys 同款 vi.hoisted 模式）——重入键命中与否
 *  的行为面观测：case 变体的物理锁文件在 mac 不敏感 FS 上与原路径同文件、在 linux
 *  敏感 FS 上互异，「成功/自锁超时」随宿主漂移；是否发起**第二次物理取锁请求**
 *  （vs 命中重入计数零取锁）在任一宿主都确定。 */
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
  vi.restoreAllMocks()
})

function makeBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'clw-r51-d-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '0001-开篇.md'), '正文内容', 'utf-8')
  return root
}

describe('R51-D-1: trash 前缀校验施加于规范化 rel（穿越/symlink 变体识别）', () => {
  it('restore：trashedPath 带 `.trash/../..` 穿越段 → NOT_FOUND，正文不被搬走', async () => {
    const root = makeBook()
    try {
      appendTrashEntry(root, {
        id: 'doc_evil',
        originalPath: '素材/目标.md',
        trashedPath: '工作区/.trash/../../写作/正文/0001-开篇.md',
        trashedAt: '2026-08-24T00:00:00Z',
        role: 'chapter',
      })
      const r = await restoreTrash(root, 'doc_evil')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('NOT_FOUND')
      // 原实现：词法前缀命中 + .abs 消解 .. 落正文 → 正文被 rename 走（回归红）
      expect(existsSync(join(root, '写作', '正文', '0001-开篇.md'))).toBe(true)
      expect(existsSync(join(root, '素材', '目标.md'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('purge：同形态 → NOT_FOUND，正文不被物理删除', async () => {
    const root = makeBook()
    try {
      appendTrashEntry(root, {
        id: 'doc_evil',
        originalPath: '写作/正文/0001-开篇.md',
        trashedPath: '工作区/.trash/../../写作/正文/0001-开篇.md',
        trashedAt: '2026-08-24T00:00:00Z',
        role: 'chapter',
      })
      const r = await purgeTrash(root, 'doc_evil')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('NOT_FOUND')
      expect(existsSync(join(root, '写作', '正文', '0001-开篇.md'))).toBe(true)
      expect(readFileSync(join(root, '写作', '正文', '0001-开篇.md'), 'utf-8')).toBe('正文内容')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('purge：.trash 内 symlink 指书内正文 → realpath 归一后 rel 不在 .trash，拒', async () => {
    const root = makeBook()
    try {
      mkdirSync(join(root, '工作区', '.trash'), { recursive: true })
      symlinkSync(
        join(root, '写作', '正文', '0001-开篇.md'),
        join(root, '工作区', '.trash', 'doc_link-开篇.md'),
      )
      appendTrashEntry(root, {
        id: 'doc_link',
        originalPath: '写作/正文/0001-开篇.md',
        trashedPath: '工作区/.trash/doc_link-开篇.md',
        trashedAt: '2026-08-24T00:00:00Z',
        role: 'chapter',
      })
      const r = await purgeTrash(root, 'doc_link')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('NOT_FOUND')
      // 原实现：.abs 走 realpath 落正文本体 → 正文被物理删（回归红）
      expect(existsSync(join(root, '写作', '正文', '0001-开篇.md'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('R51-D-2: 折叠面扩至 darwin（platformCaseFold / samePath / 清单锁重入）', () => {
  it('darwin 臂：platformCaseFold / relPathKey / samePath 全折叠；linux 对照不折叠', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    expect(platformCaseFold('布线/X.MD')).toBe('布线/x.md')
    expect(relPathKey('写作/正文/A.md')).toBe(relPathKey('写作/正文/a.md'))
    expect(samePath('/Lib/MyBook', '/lib/mybook')).toBe(true)
    expect(samePath('/Lib/MyBook', '/Lib/Other')).toBe(false)
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    expect(platformCaseFold('布线/X.MD')).toBe('布线/X.MD')
    expect(relPathKey('写作/正文/A.md')).not.toBe(relPathKey('写作/正文/a.md'))
    expect(samePath('/Lib/MyBook', '/lib/mybook')).toBe(false)
  })

  it('darwin：清单锁 case 变体重入命中同键——不发起第二次物理取锁（r45-2 win32 孪生）', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const root = mkdtempSync(join(tmpdir(), 'clw-r51-d2-mlock-'))
    __setManifestLockTimeoutForTest(50)
    try {
      mkdirSync(join(root, '项目'), { recursive: true })
      const outer = join(root, '项目', '文档清单.jsonl')
      const variant = join(root, '项目', '文档清单.JSONL') // 仅大小写异（mac APFS 物理 同文件）
      lockState.requests = []
      let innerRan = false
      withManifestLock(outer, () => {
        withManifestLock(variant, () => { innerRan = true })
      })
      expect(innerRan).toBe(true)
      // 折叠生效：内层命中重入计数，全程只有外层一次物理取锁
      //（回归：posix 臂不折叠 → 内层按「他锁」二次取锁；mac 不敏感 FS 上自锁超时抛错）
      expect(lockState.requests).toEqual([`${outer}.lock`])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('R51-D-3: doCopy `..` 目录段前置拒绝', () => {
  it('relPath 带 `..` 段（已存在目录使「原样保留」分支命中）→ PATH_ESCAPE，不落盘', async () => {
    const root = makeBook()
    try {
      const svc = new DocumentService({ bookRoot: root })
      const r = await svc.copyDocument({
        docId: legacyId('写作/正文/0001-开篇.md'),
        relPath: '写作/正文/../设定/拷贝.md',
      })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('PATH_ESCAPE')
      // 原实现：`..` 段 existsSync 命中原样保留 → 物理落位在归一位置「写作/设定/」，
      // 清单登记原文「写作/正文/../设定/拷贝.md」→ 身份分裂（回归红）
      expect(existsSync(join(root, '写作', '设定'))).toBe(false)
      expect(existsSync(join(root, '设定'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('对照：合法 relPath 复制不受影响', async () => {
    const root = makeBook()
    try {
      const svc = new DocumentService({ bookRoot: root })
      const r = await svc.copyDocument({
        docId: legacyId('写作/正文/0001-开篇.md'),
        relPath: '设定/拷贝.md',
      })
      expect(r.ok).toBe(true)
      expect(existsSync(join(root, '设定', '拷贝.md'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

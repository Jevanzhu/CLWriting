/**
 * 0917清库修复批（件1）回归：rename 微任务残窗——executeSave 落盘前书注册重验。
 *
 * 登记原文「rename 微任务残窗：单元首行重验后微任务窗残留（files.ts R70-6 架构同源，
 * 彻底闭合 = 重验下沉 DocumentService.executeSave）」。单元首行书注册重验
 * （R1010b-SRV-P2-1 面 A，studio 层 runBookScopedOp 首行 bookMovedFailure）通过到
 * executeSave 落盘之间隔着排队/保存锁/清单锁多个让出点，窗内书注册被改签/搬走时，
 * appendPending/atomicWriteFile 的 mkdir recursive 会对旧捕获 bookRoot 重建孤儿目录树
 * ——且清单随书搬走后 lookupPathByDocId 按「未登记」放行新建语义，既有 strict 读防线
 * 被旁路。修复 = executeSave 锁内复核之后、首笔写入之前按 books.jsonl 登记复核捕获书根
 * 仍注册在册（bookMovedGuardFailure，二道防线；失败即拒绝不落盘，文案单源
 * BOOK_MOVED_REASON 与 studio 首行重验同文）。
 *
 * 手法：持清单锁把保存悬在 pre-lock lookup 的 withManifestLockAsync 让出点（真实悬持，
 * 非 sleep 赌时序，r1010b waitForBodyArmed 同思路），悬持窗内改签 books.jsonl 登记，
 * 放行后保存携旧世界继续走链——确定性问题复现，钉「重验失败不落盘」。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { DocumentService } from '../../src/document/service.js'
import { BOOK_MOVED_REASON } from '../../src/document/service-guards.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { computeRevisionBytes } from '../../src/document/revision.js'
import { encodeDocDirName } from '../../src/document/version.js'
import { acquireCrossProcessLockAsync } from '../../src/fs/cross-process-lock.js'

const REL = '写作/正文/0001-章.md'
const DOC_ID = 'doc_guard1'

interface Rig {
  workDir: string
  bookRoot: string
  manifestPath: string
  svc: DocumentService
  /** 预置已登记章稿并返回其磁盘 revision。 */
  seed: () => `sha256:${string}`
  /** books.jsonl 登记改签（书目录不动——登记态单独漂移即守卫判定面）。 */
  rebindRegistry: (to: string) => void
}

function makeRig(withRegistry: boolean): Rig {
  const workDir = mkdtempTracked(join(tmpdir(), 'clw-book-guard-'))
  const bookRoot = join(workDir, '长篇', '甲')
  if (withRegistry) {
    mkdirSync(join(workDir, '.clwriting'), { recursive: true })
    writeFileSync(
      join(workDir, '.clwriting', 'books.jsonl'),
      JSON.stringify({ name: '甲', path: '长篇/甲', kind: 'long' }) + '\n',
      'utf-8',
    )
  }
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  mkdirSync(dirname(join(bookRoot, REL)), { recursive: true })
  mkdirSync(join(bookRoot, '工作区', '.journal'), { recursive: true })
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  upsertEntry(m, { id: DOC_ID, nodeType: 'document', path: REL, parentId: null })
  writeManifest(manifestPath, m)
  return {
    workDir,
    bookRoot,
    manifestPath,
    svc: new DocumentService({ bookRoot }),
    seed: () => {
      writeFileSync(join(bookRoot, REL), '第一版', 'utf-8')
      return computeRevisionBytes(Buffer.from('第一版', 'utf-8'))
    },
    rebindRegistry: (to) => {
      writeFileSync(
        join(workDir, '.clwriting', 'books.jsonl'),
        JSON.stringify({ name: '甲', path: `长篇/${to}`, kind: 'long' }) + '\n',
        'utf-8',
      )
    },
  }
}

const rigs: Rig[] = []
function makeTracked(withRegistry: boolean): Rig {
  const r = makeRig(withRegistry)
  rigs.push(r)
  return r
}
afterEach(() => {
  for (const r of rigs.splice(0)) rmSync(r.workDir, { recursive: true, force: true })
})

function save(svc: DocumentService, expectedRevision: `sha256:${string}`) {
  return svc.save(DOC_ID, REL, {
    content: '第二版',
    expectedRevision,
    operationId: 'op-guard-1',
    origin: 'manual',
  })
}

describe('0917清库修复批（件1）/ executeSave 落盘前书注册重验', () => {
  it('保存链让出窗内书注册被改签 → BOOK_MOVED 拒绝且不落盘（残窗二道防线）', async () => {
    const rig = makeTracked(true)
    const rev = rig.seed()
    // 持清单锁：保存的 pre-lock lookup（lookupPathByDocIdAdoptAsync → withManifestLockAsync）
    // 悬在该让出点——正是被修的「首行重验通过 → 落盘」微任务窗的确定性构造
    const release = await acquireCrossProcessLockAsync(`${rig.manifestPath}.lock`, 1_000)
    expect(release).not.toBeNull()
    let released = false
    try {
      const pending = save(rig.svc, rev)
      // 悬持窗内改签登记（books.ts 改名完成态的登记半边；守卫判定面即登记解析）
      rig.rebindRegistry('乙')
      released = true
      release!()
      const r = await pending
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.code).toBe('BOOK_MOVED')
        expect(r.reason).toBe(BOOK_MOVED_REASON)
      }
      // 不落盘：正文与基线未动、journal pending 未写、改签后新根无任何写入
      expect(readFileSync(join(rig.bookRoot, REL), 'utf-8')).toBe('第一版')
      expect(computeRevisionBytes(readFileSync(join(rig.bookRoot, REL)))).toBe(rev)
      expect(existsSync(join(rig.bookRoot, '工作区', '.journal', `${encodeDocDirName(DOC_ID)}.jsonl`))).toBe(false)
      expect(existsSync(join(rig.workDir, '长篇', '乙'))).toBe(false)
    } finally {
      if (!released) release?.()
    }
  })

  it('登记在册且未变 → 守卫放行，保存照常成功', async () => {
    const rig = makeTracked(true)
    const rev = rig.seed()
    const r = await save(rig.svc, rev)
    expect(r.ok).toBe(true)
    expect(readFileSync(join(rig.bookRoot, REL), 'utf-8')).toBe('第二版')
  })

  it('无登记语境（无 .clwriting）→ 守卫放行不误伤（测试夹具/裸目录兼容档）', async () => {
    const rig = makeTracked(false)
    const rev = rig.seed()
    const r = await save(rig.svc, rev)
    expect(r.ok).toBe(true)
    expect(readFileSync(join(rig.bookRoot, REL), 'utf-8')).toBe('第二版')
  })

  it('登记文件在盘但已除名（末书删除完成态：空表）→ BOOK_MOVED 拒绝不落盘', async () => {
    const rig = makeTracked(true)
    const rev = rig.seed()
    // 除名登记（books.ts 删书「移 books.jsonl 登记」完成态；书目录不动同上——守卫判定面即登记）
    writeFileSync(join(rig.workDir, '.clwriting', 'books.jsonl'), '', 'utf-8')
    const r = await save(rig.svc, rev)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('BOOK_MOVED')
      expect(r.reason).toBe(BOOK_MOVED_REASON)
    }
    expect(readFileSync(join(rig.bookRoot, REL), 'utf-8')).toBe('第一版')
    expect(existsSync(join(rig.bookRoot, '工作区', '.journal', `${encodeDocDirName(DOC_ID)}.jsonl`))).toBe(false)
  })

  it('文案单源锚：BOOK_MOVED_REASON 与 studio 首行重验（book-context.ts）逐字同文', () => {
    // 保留理由：studio 侧（book-context.ts）持内联同文文案，document 域无法从行为面触达
    // studio 的首行重验分支（需起 studio server 且触达跨域拒绝路径）；两侧文案漂移只能靠
    // 字面比对发现。studio 触达批改引本常量后本锚继续成立（字面仍在测试断言内自洽）。
    const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
    const studioSrc = readFileSync(join(srcRoot, 'studio', 'server', 'book-context.ts'), 'utf-8')
    expect(studioSrc).toContain(BOOK_MOVED_REASON)
    expect(BOOK_MOVED_REASON).toBe('书已改名或已删除，本次操作已取消——请重新打开本书后再试')
  })
})

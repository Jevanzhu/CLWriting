/**
 * R73-32（二十一轮 C-1）回归：saveDraft 复用保存协议并发纪律。
 *
 * 此前 saveDraft（/draft-save 端点、chat 改写工具、self-heal 三路共用）游离于保存协议外：
 * 不取 per-doc 保存锁、不写 journal、不记字数日记、新文件不登记 manifest。修复后对齐
 * DocumentService.executeSave（R72-1 同款锁 + journal + manifest 登记 + 字数日记）。
 *
 * 本文件验证：
 * 1. 新建草稿：journal pending+settled、manifest 登记、字数日记 delta、锁释放干净；
 * 2. 覆盖已有草稿：journal baseRevision 非空、snapshotted=true、字数日记记差值；
 * 3. 双进程竞态：他进程「存活」持保存锁 → 上抛拒绝且文件未被写（不得静默覆盖）；
 * 4. 崩溃残留锁（死 pid）→ stale 接管照常成功。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveDraft, __setDraftSaveLockTimeoutForTest } from '../../src/process/draft-pipeline.js'
import { readManifest } from '../../src/document/manifest.js'
import { findUnsettled } from '../../src/document/journal.js'
import { readTodayDelta, todayDate } from '../../src/document/words-diary.js'
import { legacyId } from '../../src/document/stable-id.js'
import { encodeDocDirName } from '../../src/document/version.js'
import { processBootTime } from '../../src/fs/cross-process-lock.js'
import { countWords } from '../../src/format/words.js'
import { bodyOf } from '../../src/format/frontmatter.js'

const OLD = '---\n章号: 5\n标题: 旧稿\n---\n\n旧正文一共四个字。'
const NEW = '---\n章号: 5\n标题: 新稿\n---\n\n新正文内容六个字。'

describe('R73-32 / saveDraft 保存协议纪律', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'r73-draft-'))
    mkdirSync(join(root, '写作', '正文'), { recursive: true })
    __setDraftSaveLockTimeoutForTest(120) // 缩短锁等待保测试快
  })
  afterEach(() => {
    __setDraftSaveLockTimeoutForTest(5_000)
    rmSync(root, { recursive: true, force: true })
  })

  function journalPathOf(relPath: string): string {
    return join(root, '工作区', '.journal', `${encodeDocDirName(legacyId(relPath))}.jsonl`)
  }

  it('新建草稿：journal pending+settled、manifest 登记、字数日记记账、锁释放干净', () => {
    const r = saveDraft(root, 5, NEW)
    expect(r.relPath).toBe('写作/正文/第一卷/0005-新稿.md')
    expect(r.docId).toBe(legacyId(r.relPath))
    expect(r.snapshotted).toBe(false)
    expect(existsSync(join(root, r.relPath))).toBe(true)

    // journal：无悬置 pending（已 settled），且两类行都在
    const jp = journalPathOf(r.relPath)
    expect(existsSync(jp)).toBe(true)
    expect(findUnsettled(jp)).toEqual([])
    const raw = readFileSync(jp, 'utf-8')
    expect(raw).toContain('"pending"')
    expect(raw).toContain('"settled"')
    // journal 行是 JSON 编码（换行转义），全文快照断言用转义形态
    expect(raw).toContain(JSON.stringify(NEW).slice(1, -1)) // pending 含全文快照（防丢字）

    // manifest：新文件已登记（R73-32 前不入清单）
    const entry = readManifest(join(root, '项目', '文档清单.jsonl')).entries.get(r.docId)
    expect(entry?.path).toBe(r.relPath)

    // 字数日记：新建 delta = 正文全字数
    expect(readTodayDelta(root, todayDate())).toBe(r.words)
    expect(r.words).toBeGreaterThan(0)

    // 锁文件不残留
    expect(existsSync(`${jp}.save.lock`)).toBe(false)
  })

  it('覆盖已有草稿：journal 记基线、留底生效、字数日记记差值', () => {
    writeFileSync(join(root, '写作', '正文', '0005-旧稿.md'), OLD, 'utf-8')
    const r = saveDraft(root, 5, NEW)
    expect(r.snapshotted).toBe(true)
    const jp = join(root, '工作区', '.journal', `${encodeDocDirName(legacyId('写作/正文/0005-旧稿.md'))}.jsonl`)
    expect(findUnsettled(jp)).toEqual([])
    // baseRevision 非空（覆盖场景记旧内容指纹）
    expect(readFileSync(jp, 'utf-8')).toContain('"baseRevision":"sha256:')
    // 字数日记：delta = 新旧正文差值（剥 fm 口径）
    const expected = countWords(bodyOf(NEW)) - countWords(bodyOf(OLD))
    expect(readTodayDelta(root, todayDate())).toBe(expected)
  })

  it('双进程竞态：他进程存活持保存锁 → 上抛拒绝，文件未被写（不静默覆盖）', () => {
    writeFileSync(join(root, '写作', '正文', '0005-旧稿.md'), OLD, 'utf-8')
    const relPath = '写作/正文/0005-旧稿.md'
    const lockPath = `${journalPathOf(relPath)}.save.lock`
    // 预置「活进程」锁（pid = 本进程必然存活，与 r72-save-lock 同款注入）
    mkdirSync(join(root, '工作区', '.journal'), { recursive: true })
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, bootTime: processBootTime() }), 'utf-8')
    expect(() => saveDraft(root, 5, NEW)).toThrow(/另一进程正在保存/)
    // 拒绝路径：目标文件字节不变、无 journal 半态、他人在位锁未被删
    expect(readFileSync(join(root, relPath), 'utf-8')).toBe(OLD)
    expect(existsSync(lockPath)).toBe(true)
    expect(existsSync(journalPathOf(relPath))).toBe(false)
  })

  it('崩溃残留锁（死 pid）→ stale 接管，保存照常成功', () => {
    const relPath = '写作/正文/第一卷/0005-新稿.md'
    const lockPath = `${journalPathOf(relPath)}.save.lock`
    mkdirSync(join(root, '工作区', '.journal'), { recursive: true })
    writeFileSync(lockPath, JSON.stringify({ pid: 4_194_999, bootTime: processBootTime() }), 'utf-8')
    const r = saveDraft(root, 5, NEW)
    expect(existsSync(join(root, r.relPath))).toBe(true)
    expect(existsSync(lockPath)).toBe(false)
  })
})

/**
 * R-4（第十六轮复审）回归——备料失败不沿用旧材料 + 溯源不虚报。
 *
 * 此前 prepareChapterMaterials 的 promptFiles 无条件含 工作区/本章写作材料.md：
 * 备料抛错时（a）buildDraftPrompt 会读到上一章残留的旧材料文件静默注入本章，
 * （b）promptMeta.files 登记了一个实际未注入（应无备料段）的文件。修复后：
 * - 备料失败：best-effort 删除旧材料文件（读不到 = 无备料段，设计内降级），
 *   promptFiles 不含该路径；
 * - 备料成功：材料文件在盘 + promptFiles 含该路径（原行为保持）。
 *
 * 用 vi.mock 隔离 prepareMaterials（控成败）与 runSpec（观察 promptFiles）；
 * 其余链路（rebuild/机检替身/落盘替身）与 self-heal-f2.test.ts 同款。
 */
import { test, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { makeDualTrackWorkdir, LONG_BOOK } from './fixtures.js'
import { runSelfHeal, type SelfHealOpts } from '../../src/ai/orchestrate/self-heal.js'
import { prepareMaterials } from '../../src/process/materials.js'
import { runSpec } from '../../src/ai/tasks/spec.js'
import type { CheckOutcome } from '../../src/studio/server/api/check.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/index.js'
import type { saveDraft } from '../../src/studio/server/api/draft.js'

vi.mock('../../src/process/materials.js', () => ({ prepareMaterials: vi.fn() }))
vi.mock('../../src/ai/tasks/spec.js', () => ({ runSpec: vi.fn() }))

const FM_CH5 = '---\n章号: 5\n标题: 第五章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文内容：山门外玉佩轻响。'

function greenOutcome(): CheckOutcome {
  return {
    ok: true,
    report: { sections: [] },
    hasRed: false,
    chapter: { 章号: 5, 标题: '第五章', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫' },
    body: '正文',
  }
}

function makeEmitDriver(emitted: DriverEvent[]): StudioDriver {
  return {
    async startSession(cwd: string): Promise<Session> { return { id: 'mock', cwd, closed: false } },
    async *stream(): AsyncGenerator<DriverEvent> {},
    dispose(): void {},
    emit(_s, ev): void { emitted.push(ev) },
  }
}

function setup(): { opts: SelfHealOpts; workDir: string; bookRoot: string } {
  const workDir = makeDualTrackWorkdir()
  const bookRoot = join(workDir, '长篇', LONG_BOOK)
  const emitted: DriverEvent[] = []
  const save: typeof saveDraft = async (_root, _ch, _content) => ({
    relPath: '写作/正文/0005-第五章.md',
    docId: 'doc-r4-5',
    words: 10,
    snapshotted: false,
  })
  const opts: SelfHealOpts = {
    driver: makeEmitDriver(emitted),
    mainSession: { id: 'main', cwd: workDir, closed: false },
    userDataPath: mkdtempSync(join(tmpdir(), 'clw-r4-appdata-')),
    cwd: workDir,
    bookRoot,
    bookName: LONG_BOOK,
    chapter: 5, // 新章（fixture 章 3/4 有定稿基线，避开覆盖定稿闸）
    check: () => greenOutcome(),
    save,
  }
  return { opts, workDir, bookRoot }
}

beforeEach(() => {
  vi.mocked(runSpec).mockReset()
  vi.mocked(runSpec).mockResolvedValue({
    ok: true,
    data: { input: undefined, text: FM_CH5, stopReason: 'tool_use' },
    ctrl: new AbortController(),
    usage: null,
    runId: 'r4',
    model: null,
  })
  vi.mocked(prepareMaterials).mockReset()
})

test('R-4: 备料失败 → 旧材料文件被清 + promptFiles 不含材料路径', async () => {
  const { opts, workDir, bookRoot } = setup()
  try {
    // 预置上一章残留的旧材料（此前会被静默沿用注入本章）
    mkdirSync(join(bookRoot, '工作区'), { recursive: true })
    writeFileSync(join(bookRoot, '工作区', '本章写作材料.md'), '上一章的旧材料内容', 'utf-8')
    vi.mocked(prepareMaterials).mockRejectedValue(new Error('RAG 召回彻底失败'))

    const r = await runSelfHeal(opts)
    expect(r.outcome).toBe('pass')

    // (a) 旧材料不沿用：文件被清（buildDraftPrompt 读不到 = 无备料段，设计内降级）
    expect(existsSync(join(bookRoot, '工作区', '本章写作材料.md'))).toBe(false)

    // (b) 溯源不虚报：首稿 runSpec 的 promptFiles 不含材料路径
    const first = vi.mocked(runSpec).mock.calls.find((c) => (c[1] as { promptFiles?: string[] }).promptFiles !== undefined)
    expect(first).toBeDefined()
    const pf = (first![1] as { promptFiles?: string[] }).promptFiles
    expect(pf).not.toContain('工作区/本章写作材料.md')
  } finally {
    rmSync(workDir, { recursive: true, force: true })
    rmSync(opts.userDataPath, { recursive: true, force: true })
  }
})

test('R-4: 备料成功 → 材料落盘 + promptFiles 含材料路径（原行为保持）', async () => {
  const { opts, workDir, bookRoot } = setup()
  try {
    vi.mocked(prepareMaterials).mockResolvedValue({ text: '本章备料材料', injectedSummaryFiles: [] } as never)
    const r = await runSelfHeal(opts)
    expect(r.outcome).toBe('pass')
    expect(readFileSync(join(bookRoot, '工作区', '本章写作材料.md'), 'utf-8')).toBe('本章备料材料')
    const first = vi.mocked(runSpec).mock.calls.find((c) => (c[1] as { promptFiles?: string[] }).promptFiles !== undefined)
    expect(first).toBeDefined()
    expect((first![1] as { promptFiles?: string[] }).promptFiles).toContain('工作区/本章写作材料.md')
  } finally {
    rmSync(workDir, { recursive: true, force: true })
    rmSync(opts.userDataPath, { recursive: true, force: true })
  }
})

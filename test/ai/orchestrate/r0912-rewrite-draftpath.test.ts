/**
 * R0912-2（2026-09-11 修复批）回归：重写循环 draftPath 与最新稿同步 + 异章号防线。
 *
 * 背景：loop.draftPath 仅首稿设定、重写落盘后不回写——tool_use 未命中降级自由文本
 * 且 AI 自带异章号 front matter 时，resolveDraftPath（format/draft.ts 只读接口）按
 * 章号失配新建孤儿文件，而机检恒打首稿路径（ctx.check(loop.draftPath)），红项永不
 * 收敛。修复：rewriteOnce 落盘后以 saveDraft 返回的真实 relPath 刷新 loop.draftPath
 *（与首稿路径取自 save 返回值同口径）；另在落盘处加防线——内容章号 ≠ 编排章号时
 * log.warn 留痕（不阻断，保持现行为）。
 *
 * 两臂（沿用 rereview2-self-heal-abort-progress 的 stub 驱动方式，save 桩按调用序
 * 返回不同 relPath 使刷新可观测）：
 * 1. 正常刷新：第二次机检收到重写稿真实落盘路径（修复前 = 首稿路径，确定性红）；
 * 2. 异章号警告：重写稿 fm 章号 999 ≠ 编排章号 1 → warn 留痕、编排照常 pass。
 */
import { test, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSelfHeal, type SelfHealOpts } from '../../../src/ai/orchestrate/self-heal.js'
import { log } from '../../../src/log/index.js'
import { SHORT_BOOK } from '../../studio/fixtures.js'
import { makeFakeDriver } from '../fake-driver.js'
import type { CheckOutcome } from '../../../src/studio/server/api/check.js'
import type { ChapterMeta } from '../../../src/format/types.js'
import type { saveDraft } from '../../../src/studio/server/api/draft.js'

const META: ChapterMeta = {
  章号: 1,
  标题: '测试章',
  钩子类型: '悬念钩',
  钩子强弱: '中',
  情绪定位: '铺垫',
}

const FM1 = '---\n章号: 1\n标题: 测试章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n'
const FM999 = '---\n章号: 999\n标题: 幻觉章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n'

function greenOutcome(): CheckOutcome {
  return { ok: true, report: { sections: [] }, hasRed: false, chapter: META, body: '正文' }
}

/** 红项报告：evaluateRetry 判 retry（attempt 0 < maxAttempts 3）→ 进 rewriteOnce */
function redOutcome(): CheckOutcome {
  return {
    ok: true,
    report: { sections: [{ name: '机检', items: [{ checkId: 'c1', level: 'red', message: '红项：测试' }] }] },
    hasRed: true,
    chapter: META,
    body: '正文',
  }
}

/** save 桩：按调用序返回不同 relPath（首稿 → 重写稿 → 终稿），使 draftPath 刷新可观测 */
function makeSaveStub(): { save: typeof saveDraft; relPaths: string[] } {
  const relPaths = ['写作/正文/0001-首稿.md', '写作/正文/0001-重写稿.md', '写作/正文/0001-终稿.md']
  let calls = 0
  const save: typeof saveDraft = async (_root, _ch, content) => {
    const relPath = relPaths[Math.min(calls, relPaths.length - 1)]!
    calls++
    return { relPath, docId: `doc-${calls}`, words: content.length, snapshotted: false }
  }
  return { save, relPaths }
}

function makeBookRoot(): { workDir: string; ud: string; bookRoot: string } {
  const workDir = mkdtempSync(join(tmpdir(), 'clw-r0912-rewrite-'))
  const ud = mkdtempSync(join(tmpdir(), 'clw-r0912-rewrite-ud-'))
  return { workDir, ud, bookRoot: join(workDir, '短篇', SHORT_BOOK) }
}

test('R0912-2: 重写落盘后以 saveDraft 真实 relPath 刷新 draftPath——第二次机检打最新稿', async () => {
  const { workDir, ud, bookRoot } = makeBookRoot()
  const checkedPaths: string[] = []
  const { save } = makeSaveStub()
  const check = (p: string): CheckOutcome => {
    checkedPaths.push(p)
    return checkedPaths.length === 1 ? redOutcome() : greenOutcome()
  }
  let genCalls = 0
  const genFn: NonNullable<SelfHealOpts['genFn']> = async (_prompt, _kind, _signal, onText) => {
    genCalls++
    const text = genCalls === 1 ? FM1 + '首稿正文' : FM1 + '重写稿正文'
    onText?.(text)
    return text
  }
  try {
    const r = await runSelfHeal({
      driver: makeFakeDriver(),
      mainSession: { id: 'main', cwd: workDir, closed: false },
      userDataPath: ud,
      cwd: workDir,
      bookRoot,
      bookName: SHORT_BOOK,
      chapter: 1,
      check,
      save,
      genFn,
    })
    expect(r.outcome).toBe('pass')
    // 首检打首稿路径；重写落盘后机检必须打 save 返回的重写稿真实路径
    // （修复前 checkedPaths[1] === 首稿路径，重写稿对机检不可见 → 红项永不收敛）
    expect(checkedPaths).toHaveLength(2)
    expect(checkedPaths[0]).toBe(join(bookRoot, '写作/正文/0001-首稿.md'))
    expect(checkedPaths[1]).toBe(join(bookRoot, '写作/正文/0001-重写稿.md'))
    expect(checkedPaths[1]).not.toBe(checkedPaths[0])
  } finally {
    rmSync(workDir, { recursive: true, force: true })
    rmSync(ud, { recursive: true, force: true })
  }
})

test('R0912-2: 重写稿 front matter 异章号（999 ≠ 1）→ log.warn 留痕，编排不阻断照常收口', async () => {
  const { workDir, ud, bookRoot } = makeBookRoot()
  const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
  const checkedPaths: string[] = []
  const { save } = makeSaveStub()
  const check = (p: string): CheckOutcome => {
    checkedPaths.push(p)
    return checkedPaths.length === 1 ? redOutcome() : greenOutcome()
  }
  let genCalls = 0
  const genFn: NonNullable<SelfHealOpts['genFn']> = async (_prompt, _kind, _signal, onText) => {
    genCalls++
    // 第二次产出（重写）自带异章号 front matter——tool_use 未命中降级自由文本的窄触发形态
    const text = genCalls === 1 ? FM1 + '首稿正文' : FM999 + '重写稿正文'
    onText?.(text)
    return text
  }
  try {
    const r = await runSelfHeal({
      driver: makeFakeDriver(),
      mainSession: { id: 'main', cwd: workDir, closed: false },
      userDataPath: ud,
      cwd: workDir,
      bookRoot,
      bookName: SHORT_BOOK,
      chapter: 1,
      check,
      save,
      genFn,
    })
    // 防线不阻断：编排照常 pass 收口（保持现行为）
    expect(r.outcome).toBe('pass')
    // warn 留痕：内容含异章号 999 与「章号」语义（log.warn('self-heal', msg) 形态）
    const warned = warnSpy.mock.calls.some(
      (c) => typeof c[1] === 'string' && c[1].includes('999') && c[1].includes('章号') && c[1].includes('不一致'),
    )
    expect(warned).toBe(true)
    // 刷新照常发生：机检打重写稿落盘路径（防线与刷新相互独立）
    expect(checkedPaths[1]).toBe(join(bookRoot, '写作/正文/0001-重写稿.md'))
  } finally {
    warnSpy.mockRestore()
    rmSync(workDir, { recursive: true, force: true })
    rmSync(ud, { recursive: true, force: true })
  }
})

// @vitest-environment happy-dom
/**
 * RC 源码重审 B-1（Opus-5.5 轮）回归：doc store 保存前字节预检。
 *
 * 规模假设不一致的旧形态：服务端保存端点沿用 1MB 默认档，而编辑器对 >1M 字符文档照常
 * 可编辑（dirty-mirror 还专设了分档节流）——超限后 autosave 每 30s 把整篇重传一次再被
 * 413 拒，作者只见「请求体过大」，切书只剩「丢弃并切换」。
 * 修复：doSave 前按 UTF-8 字节预检（shared/save-limits 单源，与服务端常量等值由
 * test/studio/save-content-body-limit.test.ts 钉住），超限不发请求、给出拆分出路、
 * 置 tooLarge 旗停掉 autosave 重试；内容再变（patch）即复位复检。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const getContent = vi.hoisted(() => vi.fn())
const saveContent = vi.hoisted(() => vi.fn())
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent,
  getContentPayload: vi.fn(async (...a: Parameters<typeof getContent>) => ({ content: await getContent(...a) })),
  saveContent,
  finalizeDoc: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return { ...actual, getToken: vi.fn(() => 'test-token') }
})

import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import {
  exceedsSaveBodyLimit,
  SAVE_TOO_LARGE_MESSAGE,
  MAX_SAVE_BODY_BYTES,
} from '../../../src/studio/web-next/src/shared/save-limits'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const OK = { ok: true as const, revision: 'sha256:x' as const, superseded: false }
/** 超限正文：中文 3 字节/字，5.6M 字 ≈ 16.8MB > 16MB 档（比 16M 个 ASCII 字符省内存）。 */
const HUGE = '汉'.repeat(5_600_000)

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.mocked(getContent).mockResolvedValue('a')
  vi.mocked(saveContent).mockResolvedValue(OK)
})

async function openDoc(): Promise<ReturnType<typeof useDocStore>> {
  const doc = useDocStore()
  doc.setBook('test-book')
  await doc.open({
    path: '写作/正文/第1章.md',
    name: '第1章.md',
    isDirectory: false,
    role: 'chapter',
    docId: 'd1',
    children: [],
  } as TreeNode)
  return doc
}

describe('save-limits 预检纯函数', () => {
  it('普通文档不超限；超 16MB 中文正文超限；ASCII 上界快路径不误判', () => {
    expect(exceedsSaveBodyLimit('短正文')).toBe(false)
    expect(exceedsSaveBodyLimit(HUGE)).toBe(true)
    // 快路径上界：5.6M 字符 ASCII = 5.6MB < 上限 → 免全量编码即判否
    expect(exceedsSaveBodyLimit('x'.repeat(5_000_000))).toBe(false)
    expect(HUGE.length * 3).toBeGreaterThan(MAX_SAVE_BODY_BYTES) // 确认本用例真走精确测量支
  })
})

describe('RC 源码重审 B-1：超限正文的保存行为', () => {
  it('autosave：不发请求、状态条给出拆分出路、tooLarge 旗停掉后续节拍重试', async () => {
    const doc = await openDoc()
    doc.patch('d1', HUGE)

    expect(await doc.save('d1', 'autosave')).toBe(false)
    expect(saveContent).not.toHaveBeenCalled() // 预检拦在请求之前（旧形态：每拍 16MB 白传一次）
    const e = doc.get('d1')!
    expect(e.error).toBe(SAVE_TOO_LARGE_MESSAGE)
    expect(e.error).toContain('拆分')
    expect(e.tooLarge).toBe(true)
    expect(e.dirty).toBe(true) // 未落盘编辑保持（不清 dirty）

    // 下一拍 autosave：tooLarge 短路，仍不发请求（也不刷屏）
    expect(await doc.save('d1', 'autosave')).toBe(false)
    expect(saveContent).not.toHaveBeenCalled()
  })

  it('手动保存：同样拦下（不发请求）+ toast 出出路', async () => {
    const doc = await openDoc()
    doc.patch('d1', HUGE)
    const toast = vi.spyOn(useUiStore(), 'toast')

    expect(await doc.save('d1')).toBe(false)
    expect(saveContent).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(SAVE_TOO_LARGE_MESSAGE, 'error')
  })

  it('内容再变即复位：拆到上限内后 autosave 恢复落盘', async () => {
    const doc = await openDoc()
    doc.patch('d1', HUGE)
    await doc.save('d1', 'autosave')
    expect(doc.get('d1')!.tooLarge).toBe(true)

    doc.patch('d1', '拆好的正文') // patch 复位 tooLarge（不复位则拆完也永远不再自动保存）
    expect(doc.get('d1')!.tooLarge).toBe(false)
    expect(await doc.save('d1', 'autosave')).toBe(true)
    expect(saveContent).toHaveBeenCalledTimes(1)
    expect(doc.get('d1')!.dirty).toBe(false)
  })
})

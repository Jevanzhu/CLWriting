/**
 * R29-3（二十九轮）：book.yaml 解析失败 RAG 静默套全局默认——「配置损坏」与「未设段」
 * 分岔回归。
 *
 * 修复前：`!cfg.ok || !cfg.config.rag` 同路——损坏书被全局默认 ragEnabled 拉去建索引/
 * 召回（对着残缺配置烧 embedding 费）。修复后：损坏 → fail-closed 禁用 + log.warn 带
 * 解析错误；未设段维持全局托底口径不变。
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readRagConfig } from '../../src/rag/config.js'

const GLOBAL_ON = { ragEnabled: true, ragProvider: 'rag-global-x' }

/** 造 userData（global.json 全局默认：RAG 开 + 指定服务商） */
function makeUserData(withGlobal: boolean): string {
  const ud = join(tmpdir(), `r29-rag-ud-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(ud, { recursive: true })
  if (withGlobal) writeFileSync(join(ud, 'global.json'), JSON.stringify(GLOBAL_ON), 'utf-8')
  return ud
}

/** 合法 book.yaml（无 rag 段——「未设段」形态，同 test/rag/rag.test.ts 基线内容） */
const BOOK_NO_RAG = 'spec_version: 1\n\nbook:\n  title: 测试\n  genre: 玄幻\n\nleads:\n  enabled: [主线]\n'

describe('R29-3：book.yaml 损坏 ≠ 未设段', () => {
  const roots: string[] = []
  const track = (p: string): string => {
    roots.push(p)
    return p
  }

  const cleanup = (): void => {
    for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true })
  }

  it('损坏（book.yaml 读不出）+ 全局默认开启 → fail-closed 禁用，不被全局拉去建索引，warn 带错误', () => {
    const bookRoot = track(join(tmpdir(), `r29-rag-book-${Date.now()}-${Math.random().toString(36).slice(2)}`))
    mkdirSync(bookRoot, { recursive: true })
    // book.yaml 用目录占位 → readFileSync EISDIR，readBookConfig ok:false（读取失败）
    mkdirSync(join(bookRoot, 'book.yaml'))
    const ud = track(makeUserData(true))

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const cfg = readRagConfig(bookRoot, ud)
      expect(cfg).toEqual({ enabled: false }) // 不含全局 provider，完全禁用
      const hits = warn.mock.calls.filter((c) => String(c[0]).includes('RAG 对本书禁用'))
      expect(hits).toHaveLength(1)
      expect(String(hits[0]![0])).toContain('book.yaml')
    } finally {
      warn.mockRestore()
    }
    cleanup()
  })

  it('未设段（rag 键缺席）+ 同一全局默认 → 托底口径维持不变（enabled/provider 回落 global）', () => {
    const bookRoot = track(join(tmpdir(), `r29-rag-book-${Date.now()}-${Math.random().toString(36).slice(2)}`))
    mkdirSync(bookRoot, { recursive: true })
    writeFileSync(join(bookRoot, 'book.yaml'), BOOK_NO_RAG, 'utf-8')
    const ud = track(makeUserData(true))

    expect(readRagConfig(bookRoot, ud)).toEqual({ enabled: true, provider: 'rag-global-x' })
    cleanup()
  })

  it('损坏 + 无全局默认 → 禁用（与既有「无托底即关」口径一致）', () => {
    const bookRoot = track(join(tmpdir(), `r29-rag-book-${Date.now()}-${Math.random().toString(36).slice(2)}`))
    mkdirSync(bookRoot, { recursive: true })
    mkdirSync(join(bookRoot, 'book.yaml'))
    const ud = track(makeUserData(false))

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(readRagConfig(bookRoot, ud)).toEqual({ enabled: false })
    } finally {
      warn.mockRestore()
    }
    cleanup()
  })
})

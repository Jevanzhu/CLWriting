/**
 * 结构操作三测试（structure-merge/split/crash）共用 helper —— 在库复审-0913-结构 P2-2 收编。
 *
 * 三份逐字重复的 chapterContent / createChapter / structureEvents（split 名 splitEvents）
 * 单源化；BOOK 与 studio harness 各文件不同 → bindStructureHelpers 工厂参数化（thunk 延迟
 * 取 beforeAll 赋值后的模块级变量），调用方解构后原调用面零漂移。
 */
import { expect } from 'vitest'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import type { StudioHarness } from './studio-server.js'

/** 章 md 内容：fm（章号/标题 + 可选附加 fm 行）+ 空行 + 正文。 */
export function chapterContent(no: number, title: string, body: string, extraFm = ''): string {
  return `---\n章号: ${no}\n标题: ${title}\n${extraFm}---\n\n${body}`
}

/** 绑定各测试文件的 studio harness / 书名 / userDataPath，产出 createChapter + structureEvents。 */
export function bindStructureHelpers(opts: { studio: () => StudioHarness; book: string; userDataPath: () => string }): {
  createChapter: (rel: string, content: string) => Promise<string>
  structureEvents: (type: string) => Array<Record<string, unknown>>
} {
  async function createChapter(rel: string, content: string): Promise<string> {
    const r = await opts.studio().req('POST', `/api/books/${encodeURIComponent(opts.book)}/documents`, {
      relPath: rel,
      content,
    })
    expect(r.status).toBe(201)
    return (r.json as { docId: string }).docId
  }

  /** workspace 事件库里某类型的全部 data（读侧 open/close 引用计数安全）。 */
  function structureEvents(type: string): Array<Record<string, unknown>> {
    const store = openSessionStore(opts.userDataPath(), opts.studio().bookRoot)
    if (!store) return []
    try {
      const out: Array<Record<string, unknown>> = []
      for (const ev of store.iterateEvents(bookHash(opts.studio().bookRoot), undefined, type as never)) {
        out.push(ev.data as Record<string, unknown>)
      }
      return out
    } finally {
      store.close()
    }
  }

  return { createChapter, structureEvents }
}

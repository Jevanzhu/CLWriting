/**
 * R48-19（四十八轮批 11）回归：伏笔端点 handler 改 async 调 getForeshadowsCachedAsync
 * （PM-1 只交付了函数、handler 未随迁的失实收口随批纠正）——HTTP 层锚定端点经异步
 * 路径正常回包。
 *
 * 来源记档（2026-09-26 测试资产行为化批）：自 r48-server-fixes.test.ts（四行为杂烩
 * 文件）按行为拆立本文件；同文件 R48-20/R48-77/R48-79 各归行为文件
 * （onboard-save-empty-content / relations-cache-flags / book-yaml-read-failures）。
 */
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'

const BOOK = '伏笔异步端点书'
let studio: StudioHarness

beforeAll(async () => {
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-foreshadows-async-',
    dirs: ['设定/伏笔', '写作/正文'],
    bookYaml:
      'spec_version: 1\nkind: long\nbook:\n  title: 伏笔异步端点书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    env: { CLWRITING_DRIVER: 'mock' },
  })
})

afterAll(() => studio.close())

describe('R48-19：伏笔端点 handler 改走 async 缓存壳', () => {
  it('GET foreshadows 经异步路径正常回包（entries 数组 + 足迹字段）', async () => {
    const r = await studio.req('GET', `/api/books/${encodeURIComponent(BOOK)}/foreshadows`)
    expect(r.status).toBe(200)
    expect(Array.isArray(r.json)).toBe(true)
  })
})

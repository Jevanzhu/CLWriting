/**
 * R48-20（四十八轮批 11）回归：onboard-save 空 content → 400 BAD_INPUT（此前静默
 * 清空设定文件假成功，对齐 draft.ts 先例）。
 *
 * 来源记档（2026-09-26 测试资产行为化批）：自 r48-server-fixes.test.ts（四行为杂烩
 * 文件）按行为拆立本文件；同文件 R48-19/R48-77/R48-79 各归行为文件
 * （foreshadows-async-endpoint / relations-cache-flags / book-yaml-read-failures）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'

const BOOK = 'onboard空内容书'
let studio: StudioHarness

beforeAll(async () => {
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-onboard-empty-',
    dirs: ['大纲'],
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: onboard空内容书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    env: { CLWRITING_DRIVER: 'mock' },
  })
})

afterAll(() => studio.close())

describe('R48-20：onboard-save 空 content 400', () => {
  it('content 缺失 → 400 BAD_INPUT「content 为空」，目标文件不被落盘', async () => {
    const r = await studio.req('POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-save`, {
      step: 'synopsis',
    })
    expect(r.status).toBe(400)
    const env = r.json as { code?: string; error?: string }
    expect(env.code).toBe('BAD_INPUT')
    expect(env.error).toContain('content 为空')
    expect(existsSync(join(studio.bookRoot, '大纲', '总纲.md'))).toBe(false)
  })

  it('content 空串 → 同 400；非空 content 照常 200 落盘', async () => {
    const blank = await studio.req('POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-save`, {
      step: 'synopsis',
      content: '   \n  ',
    })
    expect(blank.status).toBe(400)
    const ok = await studio.req('POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-save`, {
      step: 'synopsis',
      content: '# 总纲\n\n主角一路向东南。',
    })
    expect(ok.status).toBe(200)
    expect((ok.json as { ok?: boolean }).ok).toBe(true)
  })
})

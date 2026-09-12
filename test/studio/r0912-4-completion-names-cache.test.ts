/**
 * 重评-0912-4 批并修 deepseek-P2-2（2026-09-12）回归：completion-names 缓存壳。
 *
 * 修复前：GET /completion-names 每请求同步整读 设定/角色 + 设定/物品 全部 md 解 fm
 * （readFmNames 逐文件 readFile），编辑器补全高频调用同步阻塞事件循环 ~80-200ms。
 * 修复后照抄 R46-16 settings 壳（目录指纹 + 纯 TTL + FIFO 上限 + forgetSettingsCache
 * 书键挂点），响应形状 {characters, items} 不变；TTL 测试钩子与 settings 壳共用。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import {
  getCompletionNamesCached,
  forgetSettingsCache,
  __setSettingsCacheTtlForTest,
  __completionNamesScanCountForTest,
  __resetCompletionNamesScanCountForTest,
} from '../../src/studio/server/api/settings.js'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'

const BOOK = '补全缓存测试书'
let studio: StudioHarness

beforeAll(async () => {
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-r0912-4-names-',
    dirs: ['设定/角色', '设定/物品'],
    files: [{ rel: '设定/角色/林远.md', content: '---\n姓名: 林远\n---\n\n主角。' }],
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: 补全缓存测试书\n  genre: 玄幻\nhost: cc\n',
  })
})

afterAll(async () => {
  __setSettingsCacheTtlForTest(null) // TTL 注入还原（与 settings 壳共用钩子）
  await studio.close()
})

describe('重评-0912-4 deepseek-P2-2: completion-names 缓存壳', () => {
  it('连续请求 → 一次全量扫描（TTL+指纹命中），响应形状不变；端点走同一壳', async () => {
    __resetCompletionNamesScanCountForTest()
    const a = getCompletionNamesCached(studio.bookRoot) as { characters: string[]; items: string[] }
    const b = getCompletionNamesCached(studio.bookRoot) as { characters: string[]; items: string[] }
    expect(a).toEqual({ characters: ['林远'], items: [] })
    expect(b).toEqual(a)
    expect(__completionNamesScanCountForTest()).toBe(1)
    // HTTP 端点与直调共壳：命中不再重算
    const r = await studio.req('GET', `/api/books/${encodeURIComponent(BOOK)}/completion-names`)
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ characters: ['林远'], items: [] })
    expect(__completionNamesScanCountForTest()).toBe(1)
  })

  it('角色目录 mtime 变化（新建角色卡）→ 指纹失配重算，新名可见', async () => {
    writeFileSync(join(studio.bookRoot, '设定', '角色', '赵衡.md'), '---\n姓名: 赵衡\n---\n\n反派。', 'utf-8')
    const r = getCompletionNamesCached(studio.bookRoot) as { characters: string[] }
    expect(r.characters).toEqual(expect.arrayContaining(['林远', '赵衡']))
    expect(__completionNamesScanCountForTest()).toBe(2)
  })

  it('forgetSettingsCache（删书/改名挂点）同清两壳 → 下次请求重算', async () => {
    __resetCompletionNamesScanCountForTest()
    forgetSettingsCache(studio.bookRoot)
    getCompletionNamesCached(studio.bookRoot)
    expect(__completionNamesScanCountForTest()).toBe(1)
  })
})

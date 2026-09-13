/**
 * R0912-ds41（重评-deepseek-v4.1-flash P2-2）回归锚：completion-names 缓存壳。
 *
 * 修复前三观感：handler 同步阻塞事件循环、无任何缓存键（每次请求两遍全目录扫描）、
 * 整文件读（角色卡正文全进 IO 面，只用 fmRaw）。修复后：读面异步化 + fm 头读
 * （frontmatter.ts readFileFmOnly）+「目录指纹 + TTL + FIFO」缓存壳（手法照抄同
 * 文件 R46-16 settings 壳）。断言用 MISS 计数观测口（__completionNamesScanCount
 * ForTest），时钟注入走 vi.useFakeTimers({toFake:['Date']})（先例 r0912-ttl-write
 * -clock：TTL 到期即时推走，不付真实睡眠）；目录 mtime 变化臂写真实文件，跨同毫秒
 * 档的 5ms sleep 为 r44-rhythm-cache 先例手法。无平台门，三平台同跑。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { sleep } from '../helpers/wait-for.js'
import {
  __setCompletionNamesCacheTtlForTest,
  __completionNamesScanCountForTest,
  __resetCompletionNamesScanCountForTest,
} from '../../src/studio/server/api/settings.js'

const BOOK = 'R0912补全名单缓存书'
let studio: StudioHarness
const NAMES_PATH = `/api/books/${encodeURIComponent(BOOK)}/completion-names`

interface NamesBody {
  characters: string[]
  items: string[]
}

beforeAll(async () => {
  // 只接管 Date（TTL 判定读 Date.now()）；HTTP 服务器/真实 I/O 照常（先例 r0912-ttl-write-clock）
  vi.useFakeTimers({ toFake: ['Date'] })
  __setCompletionNamesCacheTtlForTest(1000)
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-r0912-ds41-cnames-',
    env: { CLWRITING_DRIVER: 'mock' },
    files: [
      // 角色：fm 姓名字段 + 无 fm 旧卡（兜底名 = 文件名词干）两种形态
      { rel: '设定/角色/林远.md', content: '---\n姓名: 林远\n身份: 主角\n---\n\n少年入宗门，身负血仇。' },
      { rel: '设定/角色/无名片.md', content: '没有 front matter 的旧卡正文' },
      { rel: '设定/物品/玄天剑.md', content: '---\n名称: 玄天剑\n品阶: 灵器\n---\n\n本命佩剑。' },
    ],
  })
})

afterAll(async () => {
  vi.useRealTimers()
  __setCompletionNamesCacheTtlForTest(null) // 恢复默认 TTL，避免污染同进程其它测试
  await studio.close()
})

beforeEach(async () => {
  // 上一用例留下的缓存条目推过注入 TTL（必然过期）+ 计数复位 → 各用例首查必为 MISS
  vi.advanceTimersByTime(2000)
  __resetCompletionNamesScanCountForTest()
})

describe('R0912-ds41：completion-names 缓存壳', () => {
  it('响应契约 { characters, items }：fm 字段名 + 无 fm 词干兜底', async () => {
    const r = await studio.req('GET', NAMES_PATH)
    expect(r.status).toBe(200)
    const body = r.json as NamesBody
    expect(Object.keys(body)).toEqual(['characters', 'items'])
    expect(body.characters).toContain('林远')
    expect(body.characters).toContain('无名片')
    expect(body.items).toEqual(['玄天剑'])
  })

  it('MISS → TTL 内 HIT：第二次请求不再扫盘（计数钩子不变），响应一致', async () => {
    const first = await studio.req('GET', NAMES_PATH)
    expect(first.status).toBe(200)
    expect(__completionNamesScanCountForTest()).toBe(1)
    vi.advanceTimersByTime(500) // < 注入 TTL 1000
    const second = await studio.req('GET', NAMES_PATH)
    expect(__completionNamesScanCountForTest()).toBe(1) // 命中：未重扫
    expect(second.json).toEqual(first.json)
  })

  it('目录新增文件 → 指纹失配 → TTL 内也重扫（新物品可见）', async () => {
    await studio.req('GET', NAMES_PATH)
    expect(__completionNamesScanCountForTest()).toBe(1)
    await sleep(5) // r44-rhythm-cache 先例：让目录 mtime 跨过同毫秒档，指纹必然失配
    writeFileSync(join(studio.bookRoot, '设定', '物品', '青莲灯.md'), '---\n名称: 青莲灯\n---\n\n照明法宝。')
    const second = await studio.req('GET', NAMES_PATH) // 时钟未推进，仅指纹变化
    expect(__completionNamesScanCountForTest()).toBe(2)
    expect((second.json as NamesBody).items).toContain('青莲灯')
    expect((second.json as NamesBody).items).toContain('玄天剑')
  })

  it('TTL 过期 → 重扫（注入 TTL 瞬时走完，不付真实睡眠）', async () => {
    const first = await studio.req('GET', NAMES_PATH)
    expect(__completionNamesScanCountForTest()).toBe(1)
    vi.advanceTimersByTime(1000 + 1) // 严格越界（先例 r47：TTL+1 即时过期）
    const second = await studio.req('GET', NAMES_PATH)
    expect(__completionNamesScanCountForTest()).toBe(2)
    expect(second.json).toEqual(first.json) // 盘上无变化 → 结果仍一致（证明确为缓存命中臂而非数据差）
  })
})

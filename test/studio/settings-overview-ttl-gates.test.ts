/**
 * R0912-ds41（重评-deepseek-v4.1-flash P3-2）回归门：settings / overview 两个缓存壳
 * 的注入式 TTL 三态（命中 / 过期 / 指纹失效）。
 *
 * 评审登记：settings（R46-16 壳）与 overview（R47-7 壳）的 TTL 语义此前缺注入式回
 * 归门——本测试补门收编：TTL 短档经组装根 overrides 注入（R0916-7-P3-6 起原模块级
 * __set*ForTest setter 与扫描计数钩子已删，MISS 次数读 settingsCache/overviewCache
 * 的 stats().misses），两壳 resetStats() 在 beforeEach 复位；forgetSettings
 * Cache / forgetOverviewCache（books.ts forgetBookKeyedCaches 既有挂点）做用例间缓
 * 存隔离。时钟注入同 ttl-window-from-write-time 手法（toFake:['Date']，过期臂即时推走不
 * 付真实睡眠）；指纹臂写真实文件（rhythm-cache 先例 5ms sleep 跨同毫秒档）。
 * 无平台门，三平台同跑。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { sleep } from '../helpers/wait-for.js'
import {
  settingsCache,
  forgetSettingsCache,
  completionNamesCache,
} from '../../src/studio/server/api/settings.js'
import { overviewCache, forgetOverviewCache } from '../../src/studio/server/api/overview.js'

const BOOK = 'R0912缓存门书'
let studio: StudioHarness
let chainStudio: StudioHarness // 回落链专用实例（组装根只注 settings 档）
const SETTINGS_PATH = `/api/books/${encodeURIComponent(BOOK)}/settings`
const OVERVIEW_PATH = `/api/books/${encodeURIComponent(BOOK)}/overview`
const NAMES_PATH = `/api/books/${encodeURIComponent(BOOK)}/completion-names`

beforeAll(async () => {
  // 只接管 Date（两级缓存 TTL 判定全读 Date.now()）；worker 重建/HTTP/真实 I/O 照常
  vi.useFakeTimers({ toFake: ['Date'] })
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-r0912-ds41-gates-',
    env: { CLWRITING_DRIVER: 'mock' },
    // 两壳 TTL 短档经组装根 overrides 注入（原模块级 setter 已删）
    overrides: { settingsTtlMs: 1000, overviewTtlMs: 1000 },
    // book.yaml title 必须与书名一致：启动段 repairBooks 以 title 覆写登记名
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: R0912缓存门书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    dirs: ['设定/角色', '写作/正文'],
    files: [
      // settings 指纹面：设定/时间线 目录须存在（指纹失效臂往里写文件）
      { rel: '设定/时间线/开篇.md', content: '# 开篇\n主角登场。\n' },
    ],
  })
})

afterAll(async () => {
  vi.useRealTimers()
  await studio.close()
})

beforeEach(async () => {
  // 上一用例留下的缓存条目推过注入 TTL（必然过期）+ 计数复位 + 双壳 forget → 首查必 MISS
  vi.advanceTimersByTime(2000)
  settingsCache.resetStats()
  overviewCache.resetStats()
  forgetSettingsCache(studio.bookRoot)
  forgetOverviewCache(studio.bookRoot)
})

describe('R0912-ds41：settings 缓存壳 TTL 门（P3-2 补门收编）', () => {
  it('TTL 命中：窗口内第二次 GET 不重扫，响应一致', async () => {
    const first = await studio.req('GET', SETTINGS_PATH)
    expect(first.status).toBe(200)
    expect(settingsCache.stats().misses).toBe(1)
    vi.advanceTimersByTime(500) // < 注入 TTL 1000
    const second = await studio.req('GET', SETTINGS_PATH)
    expect(settingsCache.stats().misses).toBe(1) // 命中：未重扫
    expect(second.json).toEqual(first.json)
  })

  it('TTL 过期：推过注入 TTL 即重扫（不付真实睡眠）', async () => {
    await studio.req('GET', SETTINGS_PATH)
    expect(settingsCache.stats().misses).toBe(1)
    vi.advanceTimersByTime(1000 + 1) // 严格越界（先例 r47：TTL+1 即时过期）
    await studio.req('GET', SETTINGS_PATH)
    expect(settingsCache.stats().misses).toBe(2)
  })

  it('指纹失效：设定/时间线 新增文件 → TTL 内也重扫', async () => {
    await studio.req('GET', SETTINGS_PATH)
    expect(settingsCache.stats().misses).toBe(1)
    await sleep(5) // rhythm-cache 先例：让目录 mtime 跨过同毫秒档，指纹必然失配
    writeFileSync(join(studio.bookRoot, '设定', '时间线', '新增卡.md'), '新增卡\n时间线条目。\n')
    await studio.req('GET', SETTINGS_PATH)
    expect(settingsCache.stats().misses).toBe(2)
  })
})

describe('R0912-ds41：overview 缓存壳 TTL 门（P3-2 补门收编）', () => {
  it('TTL 命中：窗口内第二次 GET 不重扫，响应一致', async () => {
    const first = await studio.req('GET', OVERVIEW_PATH)
    expect(first.status).toBe(200)
    expect(overviewCache.stats().misses).toBe(1)
    vi.advanceTimersByTime(500)
    const second = await studio.req('GET', OVERVIEW_PATH)
    expect(overviewCache.stats().misses).toBe(1) // 命中：未重扫
    expect(second.json).toEqual(first.json)
  })

  it('TTL 过期：推过注入 TTL 即重扫（不付真实睡眠）', async () => {
    await studio.req('GET', OVERVIEW_PATH)
    expect(overviewCache.stats().misses).toBe(1)
    vi.advanceTimersByTime(1000 + 1)
    await studio.req('GET', OVERVIEW_PATH)
    expect(overviewCache.stats().misses).toBe(2)
  })

  it('指纹失效：写作/正文 新增章 → TTL 内也重扫', async () => {
    await studio.req('GET', OVERVIEW_PATH)
    expect(overviewCache.stats().misses).toBe(1)
    await sleep(5)
    writeFileSync(
      join(studio.bookRoot, '写作', '正文', '0001-开篇.md'),
      '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n主角登场。\n',
    )
    await studio.req('GET', OVERVIEW_PATH)
    expect(overviewCache.stats().misses).toBe(2)
  })
})

// win 合并批复核批（2026-09-13）钉链：completion-names 壳 TTL 生效值链 =
// ctx.completionNamesTtlMs ?? ctx.settingsTtlMs ?? 常量（handler 回落链）。中间档
//（settings 档回落）此前零回归覆盖——本例钉死：组装根只注 settings 档、不注 completion
// 自有档时，settings 档短档 TTL 对 completion-names 端点生效（窗内命中 / 越窗重扫），
// 防链被静默简化后全绿照旧。
describe('R0912-ds41：TTL 生效值链中间档（completion 壳自有档缺省 → settings 档回落生效）', () => {
  it('settings 档 300ms → completion-names 端点窗内命中、越窗重扫（completion 默认档 5000 远未到）', async () => {
    // 专用实例：组装根只注 settingsTtlMs（completion 自有档缺省 → 走回落链中间档）
    chainStudio = await bootStudio({
      book: BOOK,
      prefix: 'clw-r0912-ds41-gates-chain-',
      env: { CLWRITING_DRIVER: 'mock' },
      overrides: { settingsTtlMs: 300 },
      bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: R0912缓存门书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
      dirs: ['设定/角色', '写作/正文'],
      files: [{ rel: '设定/时间线/开篇.md', content: '# 开篇\n主角登场。\n' }],
    })
    completionNamesCache.resetStats()
    forgetSettingsCache(chainStudio.bookRoot)
    try {
      const first = await chainStudio.req('GET', NAMES_PATH)
      expect(first.status).toBe(200)
      expect(completionNamesCache.stats().misses).toBe(1)
      vi.advanceTimersByTime(100) // < 300：settings 中间档窗内
      await chainStudio.req('GET', NAMES_PATH)
      expect(completionNamesCache.stats().misses).toBe(1) // 命中：未重扫
      vi.advanceTimersByTime(201) // 累计 301 > 300（若误走默认档 5000，此臂不会重扫）
      const third = await chainStudio.req('GET', NAMES_PATH)
      expect(completionNamesCache.stats().misses).toBe(2) // 中间档过期 → 重扫
      expect(third.json).toEqual(first.json) // 盘上无变化 → 结果仍一致（证明确为 TTL 臂而非数据差）
    } finally {
      await chainStudio.close()
    }
  })
})

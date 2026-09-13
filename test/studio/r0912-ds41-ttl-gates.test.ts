/**
 * R0912-ds41（重评-deepseek-v4.1-flash P3-2）回归门：settings / overview 两个缓存壳
 * 的注入式 TTL 三态（命中 / 过期 / 指纹失效）。
 *
 * 评审登记：settings（R46-16 壳）与 overview（R47-7 壳）的 TTL 语义此前缺注入式回
 * 归门，5 个 ForTest 钩子零引用、2 组扫描计数器只写不读——本测试补门收编：__set
 * SettingsCacheTtlForTest / __setOverviewCacheTtlForTest（后者既有消费者 r0912-ttl
 * -write-clock 不受影响）注入短档 TTL，__settingsScanCountForTest / __overviewScan
 * CountForTest 断言 MISS 次数，__reset*ForTest 在 beforeEach 复位；forgetSettings
 * Cache / forgetOverviewCache（books.ts forgetBookKeyedCaches 既有挂点）做用例间缓
 * 存隔离。时钟注入同 r0912-ttl-write-clock 手法（toFake:['Date']，过期臂即时推走不
 * 付真实睡眠）；指纹臂写真实文件（r44-rhythm-cache 先例 5ms sleep 跨同毫秒档）。
 * 无平台门，三平台同跑。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { sleep } from '../helpers/wait-for.js'
import {
  __setSettingsCacheTtlForTest,
  __settingsScanCountForTest,
  __resetSettingsScanCountForTest,
  forgetSettingsCache,
} from '../../src/studio/server/api/settings.js'
import {
  __setOverviewCacheTtlForTest,
  __overviewScanCountForTest,
  __resetOverviewScanCountForTest,
  forgetOverviewCache,
} from '../../src/studio/server/api/overview.js'

const BOOK = 'R0912缓存门书'
let studio: StudioHarness
const SETTINGS_PATH = `/api/books/${encodeURIComponent(BOOK)}/settings`
const OVERVIEW_PATH = `/api/books/${encodeURIComponent(BOOK)}/overview`

beforeAll(async () => {
  // 只接管 Date（两级缓存 TTL 判定全读 Date.now()）；worker 重建/HTTP/真实 I/O 照常
  vi.useFakeTimers({ toFake: ['Date'] })
  __setSettingsCacheTtlForTest(1000)
  __setOverviewCacheTtlForTest(1000)
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-r0912-ds41-gates-',
    env: { CLWRITING_DRIVER: 'mock' },
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
  __setSettingsCacheTtlForTest(null) // 恢复默认 TTL，避免污染同进程其它测试
  __setOverviewCacheTtlForTest(null)
  await studio.close()
})

beforeEach(async () => {
  // 上一用例留下的缓存条目推过注入 TTL（必然过期）+ 计数复位 + 双壳 forget → 首查必 MISS
  vi.advanceTimersByTime(2000)
  __resetSettingsScanCountForTest()
  __resetOverviewScanCountForTest()
  forgetSettingsCache(studio.bookRoot)
  forgetOverviewCache(studio.bookRoot)
})

describe('R0912-ds41：settings 缓存壳 TTL 门（P3-2 补门收编）', () => {
  it('TTL 命中：窗口内第二次 GET 不重扫，响应一致', async () => {
    const first = await studio.req('GET', SETTINGS_PATH)
    expect(first.status).toBe(200)
    expect(__settingsScanCountForTest()).toBe(1)
    vi.advanceTimersByTime(500) // < 注入 TTL 1000
    const second = await studio.req('GET', SETTINGS_PATH)
    expect(__settingsScanCountForTest()).toBe(1) // 命中：未重扫
    expect(second.json).toEqual(first.json)
  })

  it('TTL 过期：推过注入 TTL 即重扫（不付真实睡眠）', async () => {
    await studio.req('GET', SETTINGS_PATH)
    expect(__settingsScanCountForTest()).toBe(1)
    vi.advanceTimersByTime(1000 + 1) // 严格越界（先例 r47：TTL+1 即时过期）
    await studio.req('GET', SETTINGS_PATH)
    expect(__settingsScanCountForTest()).toBe(2)
  })

  it('指纹失效：设定/时间线 新增文件 → TTL 内也重扫', async () => {
    await studio.req('GET', SETTINGS_PATH)
    expect(__settingsScanCountForTest()).toBe(1)
    await sleep(5) // r44-rhythm-cache 先例：让目录 mtime 跨过同毫秒档，指纹必然失配
    writeFileSync(join(studio.bookRoot, '设定', '时间线', '新增卡.md'), '新增卡\n时间线条目。\n')
    await studio.req('GET', SETTINGS_PATH)
    expect(__settingsScanCountForTest()).toBe(2)
  })
})

describe('R0912-ds41：overview 缓存壳 TTL 门（P3-2 补门收编）', () => {
  it('TTL 命中：窗口内第二次 GET 不重扫，响应一致', async () => {
    const first = await studio.req('GET', OVERVIEW_PATH)
    expect(first.status).toBe(200)
    expect(__overviewScanCountForTest()).toBe(1)
    vi.advanceTimersByTime(500)
    const second = await studio.req('GET', OVERVIEW_PATH)
    expect(__overviewScanCountForTest()).toBe(1) // 命中：未重扫
    expect(second.json).toEqual(first.json)
  })

  it('TTL 过期：推过注入 TTL 即重扫（不付真实睡眠）', async () => {
    await studio.req('GET', OVERVIEW_PATH)
    expect(__overviewScanCountForTest()).toBe(1)
    vi.advanceTimersByTime(1000 + 1)
    await studio.req('GET', OVERVIEW_PATH)
    expect(__overviewScanCountForTest()).toBe(2)
  })

  it('指纹失效：写作/正文 新增章 → TTL 内也重扫', async () => {
    await studio.req('GET', OVERVIEW_PATH)
    expect(__overviewScanCountForTest()).toBe(1)
    await sleep(5)
    writeFileSync(
      join(studio.bookRoot, '写作', '正文', '0001-开篇.md'),
      '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n主角登场。\n',
    )
    await studio.req('GET', OVERVIEW_PATH)
    expect(__overviewScanCountForTest()).toBe(2)
  })
})

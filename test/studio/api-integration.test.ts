/**
 * API 集成测(横切 P1 e2e 第一刀):启动 studio server + 临时工作目录 fixture,
 * 端到端验证 GUI 后端 API 链(不涉 driver/大模型,守护已上线功能)。
 *
 * 覆盖:书架 → 设定台(P2 角色卡读写 + 境界写回 + 防穿越)→ 配置。
 * router 全局 routes 靠 vitest module isolate(每文件独立 routes 实例)。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { startServerSafe } from '../helpers/safe-port.js'
import { readBooks } from '../../src/install/books.js'

const BOOK = '测试书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-api-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '大纲'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nbook:\n  title: 测试书\n  genre: 仙侠\nkind: long\nhost: cc\n',
  )
  writeFileSync(join(bookRoot, '大纲', '总纲.md'), '# 总纲\n仙侠:林远/旧案反转')
  mkdirSync(join(bookRoot, '设定', '角色'), { recursive: true })
  writeFileSync(
    join(bookRoot, '设定', '角色', '林远.md'),
    '---\n姓名: 林远\n身份: 弟子\n目标: 旧案\n境界: 练气\n---\n性格沉稳。',
  )
  writeFileSync(
    join(bookRoot, '设定', '境界体系.md'),
    '---\n体系:\n  - 名称: 修真\n    序列: [炼气, 筑基, 金丹]\n---\n境界说明',
  )
  // X-P2-14 用：一章正文（GET 可读 / PUT 拒绝）
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(bookRoot, '写作', '正文', '0001-初入宗门.md'),
    '---\n章号: 1\n标题: 初入宗门\n---\n\n林远踏入宗门。',
  )

  server = await startServerSafe({ port: 0, workDir })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const bootR = await fetch(`${baseUrl}/api/boot`)
  token = ((await bootR.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('GUI API 集成链(设定台 P2)', () => {
  it('CC-P2-13: 非回环 host 启动即拒（fail-fast，不再全请求 403 的静默陷阱）', () => {
    expect(() => startServer({ port: 0, workDir, host: '0.0.0.0' })).toThrow('非回环')
  })

  it('GET /api/books 书架含测试书', async () => {
    const r = await fetch(`${baseUrl}/api/books`)
    expect(r.ok).toBe(true)
    const d = (await r.json()) as { books: { name: string }[] }
    expect(d.books.some((b) => b.name === BOOK)).toBe(true)
  })

  it('POST /api/books 新建短篇落到短篇/二级目录', async () => {
    const r = await fetch(`${baseUrl}/api/books`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Studio-Token': token },
      body: JSON.stringify({ name: 'API短篇', genre: '悬疑', kind: 'short' }),
    })
    expect(r.ok).toBe(true)
    const d = (await r.json()) as { name: string; kind: string; path: string }
    expect(d).toMatchObject({ name: 'API短篇', kind: 'short', path: '短篇/API短篇' })
    expect(existsSync(join(workDir, '短篇', 'API短篇', 'book.yaml'))).toBe(true)
    expect(readBooks(workDir)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'API短篇', kind: 'short', path: '短篇/API短篇' }),
    ]))
  })

  it('POST /api/books 路径穿越书名 → 400（禁 / \\ . ..）', async () => {
    const r = await fetch(`${baseUrl}/api/books`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Studio-Token': token },
      body: JSON.stringify({ name: '../evil' }),
    })
    expect(r.status).toBe(400)
  })

  it('POST 畸形 JSON body → 400 + 提示不合法（readJson 不再吞成 {}）', async () => {
    const r = await fetch(`${baseUrl}/api/books`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Studio-Token': token },
      body: '{bad json',
    })
    expect(r.status).toBe(400)
    const d = (await r.json()) as { error: string }
    expect(d.error).toContain('JSON') // 修复前 readJson 吞成 {} → error 是「书名不能为空」
  })

  it('GET /api/books/:name/settings 设定台读角色 + 境界', async () => {
    const r = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/settings`)
    const d = (await r.json()) as {
      kind: string
      characters: { 姓名: string; 境界: string }[]
      realm: { 体系: { 名称: string; 序列: string[] }[] } | null
    }
    expect(d.kind).toBe('long')
    const 林远 = d.characters.find((c) => c.姓名 === '林远')
    expect(林远?.境界).toBe('练气')
    expect(d.realm?.体系[0]?.名称).toBe('修真')
    expect(d.realm?.体系[0]?.序列).toEqual(['炼气', '筑基', '金丹'])
  })

  it('GET /api/books/:name/config 配置读回(kind + title)', async () => {
    const r = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/config`)
    const d = (await r.json()) as { config: { kind: string; book: { title: string } } }
    expect(d.config.kind).toBe('long')
    expect(d.config.book.title).toBe('测试书')
  })

  // Q-15（第十五轮）：含换行/控制字符的标题 400 拒收——落盘会破坏 book.yaml 行结构
  // （回读静默丢键/错键），入口 fail-fast
  it('PUT /api/books/:name/config 标题含换行/控制字符 → 400', async () => {
    for (const bad of ['双行\n标题', '带\r回车', '带\t制表', '带\x00空字节']) {
      const r = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'X-Studio-Token': token },
        body: JSON.stringify({ config: { spec_version: 1, book: { title: bad }, leads: { enabled: [] }, budget: {}, growth: {} } }),
      })
      expect(r.status).toBe(400)
      expect(((await r.json()) as { error: string }).error).toContain('控制字符')
    }
  })

  // R34D-25（三十四轮）：GG-P2-7 乐观锁——GET 随配置回传内容指纹 revision（book.yaml
  // 是作者手写文件，指纹而非 prefs 式内嵌计数键）；PUT 带可选 expectedRevision 比对，
  // 失配 409（双标签页后写者不再静默覆盖先写者），缺省直通（旧客户端向后兼容）。
  it('R34D-25: config 乐观锁——GET 回传指纹；PUT 失配 409 / 匹配 200 / 缺省直通', async () => {
    const cfgUrl = `${baseUrl}/api/books/${encodeURIComponent(BOOK)}/config`
    const put = (body: unknown) =>
      fetch(cfgUrl, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'X-Studio-Token': token },
        body: JSON.stringify(body),
      })

    const g0 = (await (await fetch(cfgUrl)).json()) as { revision: number }
    expect(typeof g0.revision).toBe('number')

    // 失配（模拟另一标签页已写入后的旧指纹）→ 409 REVISION_CONFLICT
    const stale = await put({
      config: { spec_version: 1, book: { title: '测试书' }, leads: { enabled: [] }, budget: {}, growth: {} },
      expectedRevision: g0.revision === 0 ? 1 : 0,
    })
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as { error: string }).error).toContain('已在其他窗口被修改')

    // 匹配 → 200 回传写入后指纹；真实写入（改 title）使指纹变化，GET 回读一致
    const ok = await put({
      config: { spec_version: 1, book: { title: '测试书改' }, leads: { enabled: [] }, budget: {}, growth: {} },
      expectedRevision: g0.revision,
    })
    expect(ok.status).toBe(200)
    const next = ((await ok.json()) as { revision: number }).revision
    expect(next).not.toBe(g0.revision)
    const g1 = (await (await fetch(cfgUrl)).json()) as { revision: number }
    expect(g1.revision).toBe(next)

    // 缺省直通（不带 expectedRevision）→ 200；写回原标题恢复现场
    const bare = await put({
      config: { spec_version: 1, book: { title: '测试书' }, leads: { enabled: [] }, budget: {}, growth: {} },
    })
    expect(bare.status).toBe(200)
  })

  it('GET /file 只允许读可编辑 Markdown，拒绝 book.yaml', async () => {
    const ok = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/file?file=${encodeURIComponent('大纲/总纲.md')}`)
    expect(ok.ok).toBe(true)
    const okD = (await ok.json()) as { content: string }
    expect(okD.content).toContain('# 总纲')

    const blocked = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/file?file=${encodeURIComponent('book.yaml')}`)
    expect(blocked.status).toBe(400)
  })

  it('PUT /file 只允许写可编辑 Markdown，拒绝 book.yaml', async () => {
    const ok = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/file?file=${encodeURIComponent('大纲/总纲.md')}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'X-Studio-Token': token },
      body: JSON.stringify({ content: '# 总纲\n已更新' }),
    })
    expect(ok.ok).toBe(true)

    const blocked = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/file?file=${encodeURIComponent('book.yaml')}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'X-Studio-Token': token },
      body: JSON.stringify({ content: 'broken: true\n' }),
    })
    expect(blocked.status).toBe(400)
  })

  it('X-P2-14: PUT /file 拒绝正文（走文档保存协议）；GET 正文仍可读（doc store 按路径开 tab）', async () => {
    const chapter = '写作/正文/0001-初入宗门.md'
    // 读侧开放（编辑器开 tab 用）
    const read = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/file?file=${encodeURIComponent(chapter)}`)
    expect(read.ok).toBe(true)
    // 写侧拒绝：正文 PUT 旁路会绕过乐观锁 + journal + 快照协议
    const blocked = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/file?file=${encodeURIComponent(chapter)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'X-Studio-Token': token },
      body: JSON.stringify({ content: '# 篡改\n' }),
    })
    expect(blocked.status).toBe(400)
    const d = (await blocked.json()) as { error: string }
    expect(d.error).toContain('正文请走文档保存协议')
  })

  // ── M-3（第六轮）：PUT /file 可选乐观锁（对齐 /documents 的 revision 协议）──

  it('M-3: GET /file 附带 revision；PUT 带匹配基线 → 200 回新指纹', async () => {
    const f = '大纲/总纲.md'
    const g = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/file?file=${encodeURIComponent(f)}`)
    expect(g.ok).toBe(true)
    const gd = (await g.json()) as { content: string; revision: string }
    expect(gd.revision).toMatch(/^sha256:/)

    const ok = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/file?file=${encodeURIComponent(f)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'X-Studio-Token': token },
      body: JSON.stringify({ content: '# 总纲\nM-3 乐观锁写入', expectedRevision: gd.revision }),
    })
    expect(ok.status).toBe(200)
    const od = (await ok.json()) as { revision: string }
    expect(od.revision).toMatch(/^sha256:/)
    expect(od.revision).not.toBe(gd.revision)
  })

  it('M-3: PUT 基线不符（他窗已改）→ 409 REVISION_CONFLICT，文件一字不动', async () => {
    const f = '大纲/总纲.md'
    const g = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/file?file=${encodeURIComponent(f)}`)
    const gd = (await g.json()) as { revision: string }
    // 他窗先改了文件
    await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/file?file=${encodeURIComponent(f)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'X-Studio-Token': token },
      body: JSON.stringify({ content: '# 总纲\n他窗的新内容' }),
    })
    const stale = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/file?file=${encodeURIComponent(f)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'X-Studio-Token': token },
      body: JSON.stringify({ content: '# 总纲\n本窗的旧基线内容', expectedRevision: gd.revision }),
    })
    expect(stale.status).toBe(409)
    const sd = (await stale.json()) as { code: string; error: string }
    expect(sd.code).toBe('REVISION_CONFLICT')
    // 文件保持他窗内容（本窗写入被拒）
    const after = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/file?file=${encodeURIComponent(f)}`)
    const ad = (await after.json()) as { content: string }
    expect(ad.content).toContain('他窗的新内容')
    expect(ad.content).not.toContain('本窗的旧基线内容')
  })

  it('M-3: 缺省 expectedRevision → 旧「后写为准」语义（存量调用方零改动）', async () => {
    const f = '大纲/总纲.md'
    const ok = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/file?file=${encodeURIComponent(f)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'X-Studio-Token': token },
      body: JSON.stringify({ content: '# 总纲\n无基线直写' }),
    })
    expect(ok.status).toBe(200)
  })

  it('GET /api/books/:name/search?q= 全书扫描 + 行级匹配（W2A 收尾）', async () => {
    const r = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/search?q=${encodeURIComponent('林远')}`)
    const d = (await r.json()) as { results: { path: string; matches: { line: number; text: string }[] }[] }
    expect(d.results.length).toBeGreaterThan(0)
    expect(
      d.results.some((it) => it.path.includes('林远') || it.matches.some((m) => m.text.includes('林远'))),
    ).toBe(true)
  })

  it('GET /search?scope=设定 限定范围（只搜设定/）', async () => {
    const r = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/search?q=${encodeURIComponent('林远')}&scope=${encodeURIComponent('设定')}`)
    const d = (await r.json()) as { results: { path: string }[] }
    expect(d.results.length).toBeGreaterThan(0)
    expect(d.results.every((it) => it.path.startsWith('设定/'))).toBe(true)
  })
})

// ── V-P2-25：搜索不进 .版本/.trash/导出（快照与回收站不得污染结果）──────

describe('搜索范围卫生（V-P2-25）', () => {
  it('历史快照 / 回收站 / 导出副本中的关键词不进结果', async () => {
    const bookRoot = join(workDir, BOOK)
    // 造三处含关键词的「不该被搜到」文件
    mkdirSync(join(bookRoot, '工作区', '.版本', 'doc_hist'), { recursive: true })
    writeFileSync(join(bookRoot, '工作区', '.版本', 'doc_hist', 'v1.md'), '旧版本里的林远')
    mkdirSync(join(bookRoot, '工作区', '.trash'), { recursive: true })
    writeFileSync(join(bookRoot, '工作区', '.trash', 'doc_dead-旧章.md'), '回收站里的林远')
    mkdirSync(join(bookRoot, '工作区', '导出'), { recursive: true })
    writeFileSync(join(bookRoot, '工作区', '导出', '全本-测试书.md'), '导出副本里的林远')
    // 一处「该被搜到」的工作区正文
    writeFileSync(join(bookRoot, '工作区', '笔记.md'), '工作区笔记提到林远')

    const r = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/search?q=${encodeURIComponent('林远')}`)
    const d = (await r.json()) as { results: { path: string }[] }
    const paths = d.results.map((it) => it.path)
    expect(paths.some((p) => p.includes('笔记'))).toBe(true)
    expect(paths.some((p) => p.includes('.版本'))).toBe(false)
    expect(paths.some((p) => p.includes('.trash'))).toBe(false)
    expect(paths.some((p) => p.includes('导出'))).toBe(false)
  })
})

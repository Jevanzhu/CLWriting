/**
 * POST /api/books/:name/documents/:docId/check 机检端点集成测（M12 块3 B3.1）。
 * 验证：正文文档 → 200 + CheckReport；非章节文档 → NOT_CHAPTER；未登记 docId → NOT_FOUND。
 * 另覆盖误报标记的消费侧：标记后重查该条消失（suppressedCount 计数可观察），
 * 只作用于「本章该 checkId」，无事件库时 fail-open 全返。
 */
import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../../helpers/studio-server.js'
import { generateDocId } from '../../../src/document/stable-id.js'

const BOOK = '机检测试书'
/** 命中 body-parts（眼睛×15 > 默认阈值 5）的正文（同句重复 → 顺带命中复读/意象，
 *  让误报剔除的对照面「其余 checkId 仍在」非空）。标记/过滤两态都以此为可观察锚。 */
const BODY_PARTS_BODY = '她的眼睛望着他，眼睛里映着火光，眼睛发烫。'.repeat(5)
let studio: StudioHarness
let userDataDir = ''
let chapterDocId = ''
let chapter2DocId = ''
let nonChapterDocId = ''

function post(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(studio.baseUrl)
    const payload = JSON.stringify(body)
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method: 'POST',
        headers: {
          'x-studio-token': studio.token,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf-8')))
        res.on('end', () => {
          let json: unknown = null
          try {
            json = JSON.parse(data)
          } catch {
            /* 非 JSON 响应留 null */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

/** 机检响应形状（两段被测行为共用）：报告 + 剔除计数 */
interface CheckBody {
  ok: boolean
  report: { sections: Array<{ items: Array<{ checkId: string; message: string; chapter?: number }> }> }
  hasRed: boolean
  suppressedCount?: number
}

function flatItems(j: CheckBody): Array<{ checkId: string; message: string }> {
  return j.report.sections.flatMap((s) => s.items)
}

/** 机检 + 误报标记两端的路径 */
function checkPath(docId: string): string {
  return `/api/books/${encodeURIComponent(BOOK)}/documents/${docId}/check`
}
function flagPath(docId: string): string {
  return `/api/books/${encodeURIComponent(BOOK)}/documents/${docId}/check-false-positive`
}

beforeAll(async () => {
  // 事件库落点：误报标记读侧要读该书 workspace 会话的 check/false-positive 事件
  userDataDir = mkdtempSync(join(tmpdir(), 'clwriting-check-api-ud-'))
  // manifest 登记 docId——须经 files 选项随起服前置盘：启动迁移会把未定稿书的
  // 定稿/ 文件按清单挪回 写作/ 并改写清单路径（起服后再写清单拿不到迁移）
  chapterDocId = generateDocId()
  chapter2DocId = generateDocId()
  nonChapterDocId = generateDocId()
  const manifest =
    '{"version":1,"type":"header"}\n' +
    JSON.stringify({ id: chapterDocId, nodeType: 'document', path: '定稿/正文/0001-开篇.md', parentId: null }) +
    '\n' +
    JSON.stringify({ id: chapter2DocId, nodeType: 'document', path: '定稿/正文/0002-第二章.md', parentId: null }) +
    '\n' +
    JSON.stringify({ id: nonChapterDocId, nodeType: 'document', path: '定稿/设定/角色.md', parentId: null }) +
    '\n'
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clwriting-check-api-',
    userDataPath: userDataDir,
    dirs: ['定稿/正文', '定稿/设定', '大纲/悬念', '项目'],
    bookYaml:
      'spec_version: 1\nkind: long\nbook:\n  title: 机检测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    files: [
      // 正文文档（完整章节 fm）——两章同款命中，用于锚「其余章不受本章标记影响」
      {
        rel: '定稿/正文/0001-开篇.md',
        content: `---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n${BODY_PARTS_BODY}\n`,
      },
      {
        rel: '定稿/正文/0002-第二章.md',
        content: `---\n章号: 2\n标题: 第二章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n${BODY_PARTS_BODY}\n`,
      },
      // 非章节文档（设定，fm 无章号/钩子字段）
      { rel: '定稿/设定/角色.md', content: '---\n标题: 角色\n---\n\n主角信息。\n' },
      { rel: '项目/文档清单.jsonl', content: manifest },
    ],
  })
})

afterAll(async () => {
  await studio.close()
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('POST /documents/:docId/check 机检（M12 块3 B3.1）', () => {
  it('正文文档 → 200 + CheckReport（含 sections）', async () => {
    const r = await post(checkPath(chapterDocId), {})
    expect(r.status).toBe(200)
    const j = r.json as CheckBody
    expect(j.ok).toBe(true)
    expect(Array.isArray(j.report.sections)).toBe(true)
    expect(j.report.sections.length).toBeGreaterThan(0)
    // hasRed 是布尔（无论红黄）
    expect(typeof j.hasRed).toBe('boolean')
  })

  it('非章节文档（设定，fm 无章号/钩子）→ 400 NOT_CHAPTER', async () => {
    const r = await post(checkPath(nonChapterDocId), {})
    expect(r.status).toBe(400)
    // N-2（第十二轮）：机检错误信封收编 replyError——{code,error} 无 ok 冗余位
    const j = r.json as { code: string }
    expect(j).not.toHaveProperty('ok')
    expect(j.code).toBe('NOT_CHAPTER')
  })

  it('未登记 docId → 404 NOT_FOUND', async () => {
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/documents/doc_${'0'.repeat(26)}/check`, {})
    expect(r.status).toBe(404)
    const j = r.json as { ok: boolean; code: string }
    expect(j.code).toBe('NOT_FOUND')
  })
})

// 误报标记的消费侧：标记端点落事件、机检端点返回前剔除。断言面只走 HTTP
//（响应字段 + suppressedCount），不锚事件库内部形状。
describe('POST /documents/:docId/check 误报标记消费（本章该 checkId 剔除）', () => {
  it('无标记 → 原样全返且 suppressedCount 为 0', async () => {
    const r = await post(checkPath(chapterDocId), {})
    expect(r.status).toBe(200)
    const j = r.json as CheckBody
    expect(j.suppressedCount).toBe(0)
    expect(flatItems(j).some((i) => i.checkId === 'body-parts')).toBe(true)
  })

  it('标记后重查 → 该 checkId 的命中消失、suppressedCount 计 1、其余 checkId 不受影响', async () => {
    const before = (await post(checkPath(chapterDocId), {})).json as CheckBody
    const baseline = flatItems(before)
    // 前置确认夹具本身可辨：被标类恰 1 条，且报告里确有别的 checkId（对照非空）
    expect(baseline.filter((i) => i.checkId === 'body-parts')).toHaveLength(1)
    expect(baseline.some((i) => i.checkId !== 'body-parts')).toBe(true)

    const flag = await post(flagPath(chapterDocId), { checkId: 'body-parts' })
    expect(flag.status).toBe(200)

    const after = (await post(checkPath(chapterDocId), {})).json as CheckBody
    // 该项整类消失（同 checkId 的命中可多条，逐条剔除）
    expect(flatItems(after).some((i) => i.checkId === 'body-parts')).toBe(false)
    expect(after.suppressedCount).toBe(1)
    // 其余 checkId 的命中逐条仍在（只剔除被标记的那一类）
    const rest = flatItems(after)
    for (const item of baseline.filter((i) => i.checkId !== 'body-parts')) {
      expect(rest).toContainEqual(item)
    }
  })

  it('同 checkId 别的章仍在（标记只作用于被标章）', async () => {
    const r = await post(checkPath(chapter2DocId), {})
    expect(r.status).toBe(200)
    const j = r.json as CheckBody
    expect(flatItems(j).some((i) => i.checkId === 'body-parts')).toBe(true)
    expect(j.suppressedCount).toBe(0)
  })

  it('重复标记同一 checkId → 仍 200 且重查照旧剔除该条（append 累积不改判据）', async () => {
    const flag = await post(flagPath(chapterDocId), { checkId: 'body-parts' })
    expect(flag.status).toBe(200)
    const r = await post(checkPath(chapterDocId), {})
    const j = r.json as CheckBody
    expect(flatItems(j).some((i) => i.checkId === 'body-parts')).toBe(false)
    expect(j.suppressedCount).toBe(1) // 每次重查都按同一判据剔除同一条命中
  })

  it('未标记的检查项照旧全返（只删被标 checkId，不动别类）', async () => {
    // 对照项：标记 body-parts 后，别的 checkId 的命中数与前测基线逐条一致
    const r = await post(checkPath(chapterDocId), {})
    const j = r.json as CheckBody
    const rest = flatItems(j)
    expect(rest.length).toBeGreaterThan(0)
    expect(rest.every((i) => i.checkId !== 'body-parts')).toBe(true)
  })
})

// fail-open：判据不可得时照原样返回全部命中、计数归零——过滤能力失效不得静默
//（服务端 log.warn 留痕；测试不锚日志文本，只锚两条降级路径的响应面）。
describe('POST /documents/:docId/check 判据不可得 fail-open', () => {
  let bare: StudioHarness
  let bareDocId = ''
  let brokenStore: StudioHarness
  let brokenDocId = ''
  let brokenUserDir = ''
  let brokenBook = ''

  beforeAll(async () => {
    bareDocId = generateDocId()
    // 路径一：无 userDataPath——服务端本就没有事件库可读（CLI/未注入形态）
    bare = await bootStudio({
      book: '无事件库机检书',
      prefix: 'clwriting-check-api-bare-',
      dirs: ['定稿/正文', '大纲/悬念', '项目'],
      bookYaml:
        'spec_version: 1\nkind: long\nbook:\n  title: 无事件库机检书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
      files: [
        {
          rel: '定稿/正文/0001-开篇.md',
          content: `---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n${BODY_PARTS_BODY}\n`,
        },
        {
          rel: '项目/文档清单.jsonl',
          content:
            '{"version":1,"type":"header"}\n' +
            JSON.stringify({ id: bareDocId, nodeType: 'document', path: '定稿/正文/0001-开篇.md', parentId: null }) +
            '\n',
        },
      ],
    })

    // 路径二：userDataPath 在场但事件库不可读——把 'clwriting' 段占成普通文件，
    // 首开建目录必失败（ENOTDIR）→ 读判据抛错 → 走 catch + warn 的 fail-open 支
    brokenDocId = generateDocId()
    brokenUserDir = mkdtempSync(join(tmpdir(), 'clwriting-check-api-broken-'))
    writeFileSync(join(brokenUserDir, 'clwriting'), 'x')
    brokenBook = '事件库损坏机检书'
    brokenStore = await bootStudio({
      book: brokenBook,
      prefix: 'clwriting-check-api-broken-',
      userDataPath: brokenUserDir,
      dirs: ['定稿/正文', '大纲/悬念', '项目'],
      bookYaml: `spec_version: 1\nkind: long\nbook:\n  title: ${brokenBook}\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n`,
      files: [
        {
          rel: '定稿/正文/0001-开篇.md',
          content: `---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n${BODY_PARTS_BODY}\n`,
        },
        {
          rel: '项目/文档清单.jsonl',
          content:
            '{"version":1,"type":"header"}\n' +
            JSON.stringify({ id: brokenDocId, nodeType: 'document', path: '定稿/正文/0001-开篇.md', parentId: null }) +
            '\n',
        },
      ],
    })
  })

  afterAll(async () => {
    await bare.close()
    await brokenStore.close()
    rmSync(brokenUserDir, { recursive: true, force: true })
  })

  it('无 userDataPath → 全量返回且 suppressedCount 为 0', async () => {
    const r = await bare.req(
      'POST',
      `/api/books/${encodeURIComponent('无事件库机检书')}/documents/${bareDocId}/check`,
      {},
    )
    expect(r.status).toBe(200)
    const j = r.json as CheckBody
    expect(flatItems(j).some((i) => i.checkId === 'body-parts')).toBe(true)
    expect(j.suppressedCount).toBe(0)
  })

  it('事件库不可读（userData 下 clwriting 被文件占位）→ 仍 200 全量返回、计数 0', async () => {
    const r = await brokenStore.req(
      'POST',
      `/api/books/${encodeURIComponent(brokenBook)}/documents/${brokenDocId}/check`,
      {},
    )
    expect(r.status).toBe(200)
    const j = r.json as CheckBody
    expect(flatItems(j).some((i) => i.checkId === 'body-parts')).toBe(true)
    expect(j.suppressedCount).toBe(0)
  })
})

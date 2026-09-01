/**
 * GG-P2-5 回归：状态机入口（GET /api/books/:name/state）的全局托底链。
 *
 * 场景：书级 book.yaml 不配 volume_size、global.json 配 defaultVolumeSize=10、
 * 正文写到第 20 章。前后对比：
 * - 前（对照）：内核 enter() 自读原始 book.yaml 不过链——卷大小回落硬编码 50，
 *   20 % 50 ≠ 0 → 态 7（起草新章）；
 * - 后（接线）：/state 路由把 config 过 applyGlobalDefaults——卷大小取 global 层 10，
 *   20 % 10 === 0 → 态 5（卷末）。
 * 两态之差即证明状态机入口吃到的是书库级默认而非硬编码。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { enter } from '../../src/state/state.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { computeRevision } from '../../src/document/revision.js'

const BOOK = 'GG卷末测试书'
const CHAPTERS = 20
const GLOBAL_VOLUME_SIZE = 10

let workDir = ''
let userDataPath = ''
let bookRoot = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

function get(path: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const req = http.request(
      { host: u.hostname, port: u.port, path, method: 'GET', headers: { 'x-studio-token': token } },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf-8')))
        res.on('end', () => {
          let json: unknown = null
          try {
            json = JSON.parse(data)
          } catch {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-gg25-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  bookRoot = join(workDir, BOOK)
  mkdirSync(bookRoot, { recursive: true })
  // GG-P2-5 断链条件：书级不配 volume_size（genre 等其余键也走同一托底链）
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: GG卷末测试书\n  genre: 玄幻\nhost: cc\n',
  )
  // 布线（长篇轨道：rebuild → index.db → 卷判定走这条路径）+ 1 条悬念让 rebuild 有内容
  mkdirSync(join(bookRoot, '布线', '悬念'), { recursive: true })
  writeFileSync(
    join(bookRoot, '布线', '悬念', '悬念-001-玉佩.md'),
    '---\n编号: 悬念-001\n标题: 玉佩\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n## 履历\n- 第1章 埋下：「玉佩发光」\n',
  )
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
  // 正文 20 章（章号 1..20）：global 卷大小 10 时 20 % 10 === 0 → 卷末。
  // 逐章登记 manifest 定稿基线（= 当前指纹）——否则正文全算未定稿草稿，先落态 4
  // （照 test/helpers/book.ts makeGitBookWithChapters 的造态方式，免 git）
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  for (let n = 1; n <= CHAPTERS; n++) {
    const rel = `写作/正文/${String(n).padStart(4, '0')}-第${n}章.md`
    const abs = join(bookRoot, rel)
    writeFileSync(
      abs,
      `---\n章号: ${n}\n标题: 第${n}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文第${n}章内容。\n`,
      'utf8',
    )
    upsertEntry(m, {
      id: generateDocId(), nodeType: 'document', path: rel, parentId: null,
      finalizedRevision: computeRevision(abs), finalizedAt: new Date().toISOString(),
    })
  }
  writeManifest(manifestPath, m)
  // 书库级 global.json（三层链第二层）：defaultVolumeSize=10
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-gg25-ud-'))
  writeFileSync(
    join(userDataPath, 'global.json'),
    JSON.stringify({ defaultVolumeSize: GLOBAL_VOLUME_SIZE }),
    'utf8',
  )

  server = await startServerSafe({ port: 0, workDir, userDataPath })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  // T2-3：GET 读端点要求 token（boot 取）
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

describe('GG-P2-5：状态机入口的全局托底（enter 前后对比）', () => {
  it('前（对照）：内核 enter() 用原始 config——卷大小回落 50，第 20 章非卷末 → 态 7', async () => {
    const r = await enter(bookRoot)
    expect(r.detected.state).toBe(7)
    expect(r.detected).toMatchObject({ state: 7, nextChapter: CHAPTERS + 1 })
  })

  it('后（接线）：/state 过 applyGlobalDefaults——卷大小取 global 层 10，第 20 章整除 → 态 5 卷末', async () => {
    const r = await get(`/api/books/${encodeURIComponent(BOOK)}/state`)
    expect(r.status).toBe(200)
    const j = r.json as {
      state: number
      stateName: string
      action: string
      kind: string
      nextChapter: number
    }
    expect(j.state).toBe(5)
    expect(j.stateName).toBe('卷末')
    expect(j.action).toBe('volume-review')
    expect(j.kind).toBe('long')
    expect(j.nextChapter).toBe(CHAPTERS + 1)
  })
})

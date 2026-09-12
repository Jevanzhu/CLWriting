/**
 * 低级项（第六轮）回归：总览写作热力只统计已定稿章。
 * 写作中的草稿保存也刷 mtime，原先被计入「定稿产出」（热力图/连续天数虚高）。
 * 通过 manifest finalizedRevision 区分：定稿章计数、草稿章不计数；无清单保持全量。
 *
 * 测试精简批（2026-09-12）：启动样板收编 bootStudio（manifest 定稿指纹经 files
 * 预置）；get 走裸 node:http 形态保留本地，改绑 studio.baseUrl/studio.token。
 */
import http from 'node:http'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'

const BOOK = '热力定稿测试书'
let studio: StudioHarness

function get(path: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(studio.baseUrl)
    const req = http.request(
      { host: u.hostname, port: u.port, path, method: 'GET', headers: { 'x-studio-token': studio.token } },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf8')))
        res.on('end', () => {
          let json: any = null
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
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clwriting-heat-',
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: 热力定稿测试书\n  genre: 玄幻\nhost: cc\n',
    dirs: ['写作/正文', '项目'],
    files: [
      // 两章正文：0001 已定稿（manifest 有 finalizedRevision）、0002 草稿（无）
      { rel: '写作/正文/0001-开篇.md', content: '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n定稿正文\n' },
      { rel: '写作/正文/0002-草稿.md', content: '---\n章号: 2\n标题: 草稿\n---\n\n草稿正文（未定稿）\n' },
      // manifest：header + 两条目（0001 带定稿指纹，0002 无）
      {
        rel: '项目/文档清单.jsonl',
        content:
          [
            JSON.stringify({ version: 1, type: 'header' }),
            JSON.stringify({
              id: 'doc_0001', nodeType: 'document', path: '写作/正文/0001-开篇.md', parentId: null,
              finalizedRevision: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              finalizedAt: '2026-08-21T00:00:00.000Z',
            }),
            JSON.stringify({ id: 'doc_0002', nodeType: 'document', path: '写作/正文/0002-草稿.md', parentId: null }),
          ].join('\n') + '\n',
      },
    ],
  })
})

afterAll(() => studio.close())

describe('总览热力图：只统计已定稿章', () => {
  it('草稿章不计入 timeline / streak（即便 mtime 同日）', async () => {
    const r = await get(`/api/books/${encodeURIComponent(BOOK)}/overview`)
    expect(r.status).toBe(200)
    const timeline: { date: string; count: number }[] = r.json.timeline ?? []
    const total = timeline.reduce((sum, t) => sum + t.count, 0)
    expect(total).toBe(1) // 只有 0001 定稿章；0002 草稿不计数
  })
})

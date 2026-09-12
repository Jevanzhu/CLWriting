/**
 * kk-P1-4 回归：GET /api/books/:name/state 透传 batchPause（连写暂停元状态）。
 *
 * 状态机 buildRecap 早已叠加 batchPause（state.ts），但 API 层 reply 白名单漏带——
 * 前端 WorkbenchView 的「连写暂停在第 N 章」提示永不可达。本测用最小书仓库 +
 * 手落 .auto-batch.json 暂停记录，验证：有记录 → 响应带 batchPause 原样字段；
 * 无记录 → 响应不带该键（条件展开口径）。
 *
 * 测试精简批（2026-09-12）：启动样板收编 bootStudio（get 走裸 http.request，保留本地）。
 */
import http from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
// R75-D-P3b（批 D）：/state 已有 5s TTL 结果缓存——本测验证「落暂停记录后立即可见」，
// 注入 TTL=0 关缓存保住原即时语义（缓存三态由 r75-state-tree-issues-ttl.test.ts 覆盖）
import { __setStateTtlForTest } from '../../src/studio/server/api/state.js'

const BOOK = '暂停透传测试书'

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
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) })
          } catch (e) {
            reject(e)
          }
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

beforeAll(async () => {
  __setStateTtlForTest(0) // R75-D-P3b：关 TTL 缓存（it1→it2 落盘后需立即可见）
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-kk14-',
    dirs: ['工作区/待定稿'],
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: 暂停透传测试书\nhost: cc\n',
  })
})

afterAll(async () => {
  __setStateTtlForTest(null) // 恢复默认 TTL，避免污染同进程其它测试
  await studio.close()
})

describe('kk-P1-4: /state 透传 batchPause', () => {
  it('无暂停记录 → 响应不带 batchPause 键', async () => {
    const r = await get(`/api/books/${encodeURIComponent(BOOK)}/state`)
    expect(r.status).toBe(200)
    expect(r.json.batchPause).toBeUndefined()
  })

  it('有暂停记录 → 原样透传 {atChapter, reason, detail}', async () => {
    writeFileSync(
      join(studio.bookRoot, '工作区', '待定稿', '.auto-batch.json'),
      JSON.stringify({ paused: { at_chapter: 3, reason: 'escalate', detail: '第 3 章三审超阈值，上交裁决' } }),
      'utf8',
    )
    const r = await get(`/api/books/${encodeURIComponent(BOOK)}/state`)
    expect(r.status).toBe(200)
    expect(r.json.batchPause).toEqual({
      atChapter: 3,
      reason: 'escalate',
      detail: '第 3 章三审超阈值，上交裁决',
    })
  })
})

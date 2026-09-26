/**
 * R51-G-1（五十一轮）回归：prefs 双端点同一失败形态错误码统一。
 *
 * 原漂移：书级 PUT /api/books/:name/prefs 写失败 500 IO_ERROR，全局 PUT
 * /api/library/prefs 写失败 500 ERROR——同一「落盘 IO 异常」双端点码面分叉，前端按
 * 码分类的降级/提示路径不一致。修复后统一 IO_ERROR。
 *
 * 测试精简批（2026-09-12）：启动样板收编 bootStudio（空书架形态；裸 http.request 定制 putGlobalPrefs 保留本地仅改绑定）。
 */
import http from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'

let studio: StudioHarness
let userDataPath = ''
let baseUrl = ''
let token = ''

function putGlobalPrefs(): Promise<{ status: number; json: { code?: string; error?: string } }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const body = JSON.stringify({ prefs: { theme: 'dark' } })
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: '/api/library/prefs',
        method: 'PUT',
        headers: { 'x-studio-token': token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf-8')))
        res.on('end', () => {
          let json: { code?: string; error?: string } = {}
          try {
            json = JSON.parse(data)
          } catch {
            /* 非 JSON 体 */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    r.on('error', reject)
    r.write(body)
    r.end()
  })
}

beforeAll(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-r51-g1-ud-'))
  studio = await bootStudio({ prefix: 'clwriting-r51-g1-', userDataPath })
  baseUrl = studio.baseUrl
  token = studio.token
})

afterAll(async () => {
  await studio.close()
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

describe('R51-G-1: 全局 prefs 写失败错误码统一 IO_ERROR', () => {
  it('global.json 落盘失败（同名目录占位）→ 500 IO_ERROR（原 ERROR——回归红）', async () => {
    // global.json 做成目录：读侧形状兜底吞掉 EISDIR，写侧 atomicWriteFile 必败
    rmSync(join(userDataPath, 'global.json'), { force: true })
    mkdirSync(join(userDataPath, 'global.json'))
    const r = await putGlobalPrefs()
    expect(r.status).toBe(500)
    expect(r.json.code).toBe('IO_ERROR')
    expect(r.json.error).toContain('写全局偏好失败')
  })
})

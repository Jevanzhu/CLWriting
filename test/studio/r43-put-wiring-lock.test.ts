/**
 * R43-1（四十三轮）回归：PUT /file 布线/关系线文件取同名布线锁。
 *
 * 修复前 PUT 白名单放行 布线/、大纲/关系线/ 但临界段不取锁——跨进程下与
 * lead-finalize 持锁 RMW / executeSave（save 锁内再取布线锁）交错即丢更新：
 * 定稿链读到旧内容 C0 → PUT 落 C1 → writeLead 以 C0+履历行覆盖，C1 无痕丢失。
 * 修复后 PUT 取同口径锁（join(bookRoot, rel) + win32 折叠 + 前缀过滤），
 * 锁被占 → 409 WRITE_ERROR fail-closed 可重试；锁空闲 → 正常直写。
 *
 * 测试精简批（2026-09-12）：启动样板收编 bootStudio（样板转换参照件）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { acquireCrossProcessLockWithTimeout } from '../../src/fs/cross-process-lock.js'

const BOOK = '布线锁测试书'
const LEAD_Q = encodeURIComponent('布线/悬念/0001-测试.md')
let studio: StudioHarness

beforeAll(async () => {
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-r43-wiring-',
    dirs: ['布线/悬念'],
    files: [{ rel: '布线/悬念/0001-测试.md', content: '---\n编号: 0001\n---\n旧线索' }],
  })
})

afterAll(() => studio.close())

describe('R43-1: PUT /file 布线锁互斥', () => {
  it('布线锁被他进程持有 → PUT 409 WRITE_ERROR（fail-closed 可重试，不裸写）', async () => {
    const lockKey = `${join(studio.bookRoot, '布线/悬念/0001-测试.md')}.lock`
    const release = acquireCrossProcessLockWithTimeout(lockKey, 1000)
    expect(release).not.toBeNull()
    try {
      const r = await studio.req('PUT', `/api/books/${encodeURIComponent(BOOK)}/file?file=${LEAD_Q}`, {
        content: '---\n编号: 0001\n---\n被锁期写入',
      })
      expect(r.status).toBe(409)
      expect((r.json as { code?: string }).code).toBe('WRITE_ERROR')
      // 盘上内容未被覆盖（锁语义成立）
      expect(readFileSync(join(studio.bookRoot, '布线/悬念/0001-测试.md'), 'utf8')).toContain('旧线索')
    } finally {
      release!()
    }
  })

  it('锁释放后 PUT 正常直写（不误伤主路径）', async () => {
    const r = await studio.req('PUT', `/api/books/${encodeURIComponent(BOOK)}/file?file=${LEAD_Q}`, {
      content: '---\n编号: 0001\n---\n新线索',
    })
    expect(r.status).toBe(200)
    expect(readFileSync(join(studio.bookRoot, '布线/悬念/0001-测试.md'), 'utf8')).toContain('新线索')
  })
})

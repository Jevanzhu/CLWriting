/**
 * 低-6（第十轮）：删书清史失败降级留痕走 logger——此前 books.ts 该分支用 console.warn，
 * 打包态 mirrorConsole=false 时 console 无人看见也不进 JSONL（诊断失明）。
 *
 * clearChatHistory 自身对「打开库/清行」失败已内部降级留痕（chat/state.ts），
 * books.ts 的 try/catch 是防御性收编（终态兜底）——注入 clearChatHistory 抛错触发，
 * 断言：删书不被阻断（200）+ log.warn('api', …) 留痕 + 不再走 console.warn。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { log } from '../../src/log/index.js'

/** 注入开关（vi.hoisted 保证 vi.mock 工厂可见） */
const inj = vi.hoisted(() => ({ failClear: false }))

vi.mock('../../src/ai/orchestrate/chat.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ai/orchestrate/chat.js')>()
  return {
    ...orig,
    clearChatHistory: (...args: Parameters<typeof orig.clearChatHistory>) => {
      if (inj.failClear) throw new Error('清史失败注入')
      return orig.clearChatHistory(...args)
    },
  }
})

const BOOK = '清史留痕测试书'
let workDir = ''
let userDataDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-del-warn-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'clwriting-del-warn-ud-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: `长篇/${BOOK}`, kind: 'long' }) + '\n',
    'utf-8',
  )
  const bookAbs = join(workDir, '长篇', BOOK)
  mkdirSync(join(bookAbs, '写作', '正文'), { recursive: true })
  writeFileSync(join(bookAbs, 'book.yaml'), `spec_version: 1\nkind: long\nbook:\n  title: ${BOOK}\nhost: cc\n`, 'utf-8')

  server = startServer({ port: 0, workDir, userDataPath: userDataDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  const boot = await fetch(`${baseUrl}/api/boot`)
  token = ((await boot.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true })
})

describe('低-6（第十轮）：删书清史失败 → log.warn 留痕（不走 console）', () => {
  it('clearChatHistory 抛错：删书 200 不阻断 + logger warn 留痕', async () => {
    // 低-6 锚定点：留痕必须经项目 logger（打包态 mirrorConsole=false 时仍有 JSONL 落盘）。
    // 注意 logger 在 dev/测试态会镜像 console.warn——「不走 console」指不直连 console 通道，
    // 故此处只断言 log.warn 收到，不否决 logger 自身的镜像行为
    const warnSpy = vi.spyOn(log, 'warn')
    inj.failClear = true
    try {
      const r = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}`, {
        method: 'DELETE',
        headers: { 'x-studio-token': token },
      })
      // L-S4（第八轮）：删除主流程已完成，清史收尾失败不阻断删书
      expect(r.status).toBe(200)

      // 低-6：留痕必须进项目 logger——tag 与本文件 log.error 删除目录失败同源 'api'
      const hit = warnSpy.mock.calls.find((c) => String(c[1]).includes('删书清史失败'))
      expect(hit, 'log.warn 应收到删书清史失败留痕').toBeTruthy()
      expect(hit![0]).toBe('api')
      expect(String(hit![1])).toContain(BOOK)
      expect(hit![2]).toBeInstanceOf(Error)
    } finally {
      inj.failClear = false
      warnSpy.mockRestore()
    }
  })
})

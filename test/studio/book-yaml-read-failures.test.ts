/**
 * book.yaml 读失败两面（损坏降级留痕 / 缺失显式报错）——按被测行为归并的单文件。
 *
 * 合并自两份同域回归（2026-09-26 测试资产行为化批；原文件名记档：
 * r50-c2-book-yaml-degrade-warn.test.ts（R50-C-2，5 用例）+ r48-server-fixes.test.ts
 * 的 R48-79 describe（1 用例）→ 6 用例零去重平移）：
 *
 * - R50-C-2（五十轮）：book.yaml 损坏时读配置端点降级留痕（log.warn）。修复前
 *   overview / draft-prompt / rhythm / style config（读 book.yaml 后未判 ok 直接用
 *   .config）在 book.yaml 损坏时静默回落 DEFAULT_CONFIG 骨架——无任何诊断痕迹（对照
 *   state.ts P3-2 既有口径：log.warn('state', 'book.yaml 解析降级: ...')）。修复后
 *   五处消费点（overview / draft / rhythm / outline 卷进度 volumeProgressOf / style）
 *   各自 log.warn 留痕，响应仍 200 正常降级（不崩端点）。
 * - R48-79（四十八轮批 11）：book.yaml 缺失时总览显式 500 IO_ERROR（此前静默代答
 *   默认身份，对齐 books.ts 低-3「读失败显式报错不代答」口径）。
 *
 * 断言模式：vi.spyOn(log, 'warn')（先例 task-gate-lockroot-warn.test.ts），按各模块
 * tag（'overview'/'draft'/'rhythm'/'outline'/'style'）断言留痕。outline 卷进度走导出
 * 函数 buildOutlinePromptWithFiles 直测（其端点 POST /outline 会触发分钟级 AI 生成，
 * 不在本测面）。
 */
import http from 'node:http'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { buildOutlinePromptWithFiles } from '../../src/studio/server/api/outline.js'
import { log } from '../../src/log/index.js'

const BOOK = '坏配置书'
const BOOK_MISSING = '无配置书'
let studio: StudioHarness // book.yaml 损坏（顶层段重复）→ 200 降级面
let missingStudio: StudioHarness // book.yaml 缺失 → 500 显式报错面

function makeGet(h: StudioHarness): (path: string) => Promise<{ status: number; json: unknown }> {
  return (path) =>
    new Promise((resolve, reject) => {
      const u = new URL(h.baseUrl)
      const req = http.request(
        { host: u.hostname, port: u.port, path, method: 'GET', headers: { 'x-studio-token': h.token } },
        (res) => {
          let data = ''
          res.on('data', (c) => (data += c.toString('utf8')))
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

function get(path: string): Promise<{ status: number; json: unknown }> {
  return makeGet(studio)(path)
}

beforeAll(async () => {
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-book-yaml-degrade-',
    dirs: ['写作/正文'],
    // 损坏的 book.yaml：顶层段重复——本项目自研行式解析器（format/yaml.ts parseSections）
    // 对「顶层段重复」显式抛错（宁红不错挂）→ readBookConfig ok:false 回落 DEFAULT_CONFIG
    // 骨架；启动自愈 detectBookName 对 ok:false 回落目录名，登记名稳定（书可解析）
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: 坏配置书\nbook:\n  title: 重复段\n',
  })
  // R48-79 面：只登记目录不写 book.yaml（bootStudio 不给 bookYaml 即不写）
  missingStudio = await bootStudio({
    book: BOOK_MISSING,
    prefix: 'clw-book-yaml-missing-',
    dirs: [],
  })
})

afterAll(() => {
  studio.close()
  missingStudio.close()
})

/** 按模块 tag 断言留痕（log.warn(tag, 'book.yaml 解析降级: ...')）。 */
function warnCallsWithTag(tag: string): string[] {
  return vi.mocked(log.warn).mock.calls
    .filter((c) => c[0] === tag)
    .map((c) => String(c[1] ?? ''))
}

describe('R50-C-2：book.yaml 损坏 → 端点 200 降级 + log.warn 留痕（state.ts P3-2 同款口径）', () => {
  it('GET /overview → 200 且 log.warn("overview") 留痕', async () => {
    const spy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const r = await get(`/api/books/${encodeURIComponent(BOOK)}/overview`)
      expect(r.status).toBe(200)
      const calls = warnCallsWithTag('overview')
      expect(calls.length).toBeGreaterThanOrEqual(1)
      expect(calls.some((m) => m.includes('book.yaml 解析降级'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('GET /draft-prompt → 200 且 log.warn("draft") 留痕', async () => {
    const spy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const r = await get(`/api/books/${encodeURIComponent(BOOK)}/draft-prompt?chapter=1`)
      expect(r.status).toBe(200)
      const calls = warnCallsWithTag('draft')
      expect(calls.length).toBeGreaterThanOrEqual(1)
      expect(calls.some((m) => m.includes('book.yaml 解析降级'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('GET /rhythm → 200 且 log.warn("rhythm") 留痕', async () => {
    const spy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const r = await get(`/api/books/${encodeURIComponent(BOOK)}/rhythm`)
      expect(r.status).toBe(200)
      const calls = warnCallsWithTag('rhythm')
      expect(calls.length).toBeGreaterThanOrEqual(1)
      expect(calls.some((m) => m.includes('book.yaml 解析降级'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('GET /style/config → 200 且 log.warn("style") 留痕', async () => {
    const spy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const r = await get(`/api/books/${encodeURIComponent(BOOK)}/style/config`)
      expect(r.status).toBe(200)
      const calls = warnCallsWithTag('style')
      expect(calls.length).toBeGreaterThanOrEqual(1)
      expect(calls.some((m) => m.includes('book.yaml 解析降级'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('outline 卷进度（buildOutlinePromptWithFiles → volumeProgressOf）→ 正常产出且 log.warn("outline") 留痕', () => {
    const spy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const d = buildOutlinePromptWithFiles(studio.bookRoot, 60, 'long')
      expect(d.prompt.length).toBeGreaterThan(0)
      const calls = warnCallsWithTag('outline')
      expect(calls.length).toBeGreaterThanOrEqual(1)
      expect(calls.some((m) => m.includes('book.yaml 解析降级'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('R48-79：book.yaml 缺失 → 总览显式 500（不静默代答默认身份）', () => {
  it('缺失 book.yaml → 500 IO_ERROR（books.ts 低-3 口径）', async () => {
    const r = await makeGet(missingStudio)(`/api/books/${encodeURIComponent(BOOK_MISSING)}/overview`)
    expect(r.status).toBe(500)
    expect((r.json as { code?: string }).code).toBe('IO_ERROR')
    expect(String((r.json as { error?: unknown }).error)).toContain('book.yaml')
  })
})

/**
 * hh §八-12 错误信封统一回归：所有非 2xx JSON 错误响应唯一信封形状 {code, error}。
 * - replyError 出口单元：状态码 + content-type + 信封体三要素
 * - resolveDocEntry：docId → 清单条目；未登记 → null（调用方按 NOT_FOUND 语义回复）
 * - SSE 订阅错误路径：无工作目录 → JSON 信封（不再裸文本——前端 EventSource/fetch 可读体）
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import type { ServerResponse } from 'node:http'
import { mkdtempTracked } from '../../helpers/temp-dir.js'
import { replyError } from '../../../src/studio/server/http.js'
import { resolveDocEntry } from '../../../src/studio/server/book-context.js'
import { startServerSafe } from '../../helpers/safe-port.js'
import { readManifest, writeManifest, upsertEntry } from '../../../src/document/manifest.js'
import { generateDocId } from '../../../src/document/stable-id.js'

let server: http.Server | undefined
let baseUrl = ''

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
})

describe('replyError 统一信封单元', () => {
  it('状态码 + JSON content-type + {code, error} 体三要素', () => {
    const calls: Array<{ status: number; headers: Record<string, string>; body: string }> = []
    const res = {
      writeHead(status: number, headers: Record<string, string>) {
        calls.push({ status, headers, body: '' })
      },
      end(body: string) {
        calls[0]!.body = body
      },
    } as unknown as ServerResponse
    replyError(res, 409, 'BUSY', '本书正在生成')
    expect(calls[0]!.status).toBe(409)
    expect(calls[0]!.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(JSON.parse(calls[0]!.body)).toEqual({ code: 'BUSY', error: '本书正在生成' })
  })

  // 出口脱敏两层：凭据（redactSecret）+ 路径（log/path-scrub）。路径一层单点是必须的——
  // Node 各 errno 只有部分带路径（ENOENT/EACCES/ENOTDIR 带，EISDIR 不带），逐 call site
  // 判「这条 message 会不会带路径」判不准。
  it('error 文本里的本机绝对路径按占位符消掉（家目录 / 家目录外 / 盘符三形态）', () => {
    const calls: Array<{ body: string }> = []
    const res = {
      writeHead() {},
      end(body: string) {
        calls.push({ body })
      },
    } as unknown as ServerResponse
    const home = homedir()
    // 「家目录外」的反例须真在 home 之外——win 的 tmpdir 落在 home 内
    //（C:\Users\<名>\AppData\Local\Temp），拿它当反例会把用例前提坐空（实测只会落成
    // <用户目录>\AppData\... 而非通用占位符）。卷根两侧都在 home 外。
    const outside =
      process.platform === 'win32'
        ? 'C:\\OtherVolume\\书库\\book.yaml'
        : join('/Volumes', '外接卷', '书库', 'book.yaml')
    replyError(
      res,
      500,
      'IO_ERROR',
      `读 book.yaml 失败:ENOENT: no such file or directory, open '${join(home, '书库', 'book.yaml')}'` +
        ` / ENOTDIR: not a directory, open '${outside}'` +
        ` / EACCES: permission denied, open 'C:\\Users\\bob\\书库\\book.yaml'`,
    )
    const j = JSON.parse(calls[0]!.body) as { error: string }
    expect(j.error).not.toContain(home)
    expect(j.error).not.toContain(outside)
    expect(j.error).not.toContain('C:\\Users\\bob')
    // 期望值按本机分隔符构造（win 的 join 出反斜杠）——写死正斜杠只在本机为 POSIX 时成立
    expect(j.error).toContain(`open '${join('<用户目录>', '书库', 'book.yaml')}'`)
    // 家目录外的绝对路径（临时卷 / 外接卷）没有带名占位符可用，落通用占位符
    expect(j.error).toContain("open '<路径>'")
    expect(j.error).toContain("open '<用户目录>\\书库\\book.yaml'")
  })

  it('对照：相对路径与中文人话逐字保留（防过度脱敏）', () => {
    const calls: Array<{ body: string }> = []
    const res = {
      writeHead() {},
      end(body: string) {
        calls.push({ body })
      },
    } as unknown as ServerResponse
    replyError(res, 404, 'NOT_FOUND', '没有这篇文档：写作/正文/0001-开篇.md（清单未登记）')
    expect((JSON.parse(calls[0]!.body) as { error: string }).error).toBe(
      '没有这篇文档：写作/正文/0001-开篇.md（清单未登记）',
    )
  })
})

describe('resolveDocEntry（hh §八-12 docId 样板公共化）', () => {
  it('已登记 → 返回条目；未登记 → null', () => {
    const bookRoot = mkdtempTracked(join(tmpdir(), 'clwriting-envelope-'))
    try {
      mkdirSync(join(bookRoot, '项目'), { recursive: true })
      const docId = generateDocId()
      const m = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
      upsertEntry(m, { id: docId, nodeType: 'document', path: '定稿/正文/0001-开篇.md', parentId: null })
      writeManifest(join(bookRoot, '项目', '文档清单.jsonl'), m)

      expect(resolveDocEntry(bookRoot, docId)?.path).toBe('定稿/正文/0001-开篇.md')
      expect(resolveDocEntry(bookRoot, 'doc_unknown0000000000000000')).toBeNull()
    } finally {
      rmSync(bookRoot, { recursive: true, force: true })
    }
  })
})

describe('SSE 错误路径走 JSON 信封（不再裸文本）', () => {
  it('无工作目录 → 400 {code: NO_WORKDIR}（fetch 可读体判别；R64-27 鉴权前移须带 token 到达）', async () => {
    server = await startServerSafe({ port: 0, workDir: null, studioToken: 'envelope-test-token' })
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    // R64-27（十二轮）：SSE 鉴权前移——无凭据先吃 403，带凭据才到达 workDir 判定。
    // R0916-7-P3-19：`?token=` 通道已删——凭据改走 x-studio-token 头。
    const unauthed = await fetch(`${baseUrl}/api/books/任意书/stream`)
    expect(unauthed.status).toBe(403)
    const resp = await fetch(`${baseUrl}/api/books/任意书/stream`, {
      headers: { 'x-studio-token': 'envelope-test-token' },
    })
    expect(resp.status).toBe(400)
    expect(resp.headers.get('content-type')).toContain('application/json')
    expect(await resp.json()).toEqual({ code: 'NO_WORKDIR', error: '未定位到工作目录' })
  })
})

// Q-7（第十五轮）：documents 六端点（create/patch/copy/delete/trash-restore/trash-purge）
// 结构化失败原裸 result 整体回复（前端 toast 直显机器码，reason 人话永不见）——收编
// replyError 统一信封 {code, error=reason} 后的回归锚定
describe('documents 端点结构化失败走统一信封（Q-7）', () => {
  const BOOK = '信封测试书'
  let docServer: http.Server | undefined
  let docBaseUrl = ''
  let token = ''
  let docWorkDir = ''
  let docBookRoot = ''

  beforeAll(async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'clwriting-envelope-doc-'))
    docWorkDir = workDir
    mkdirSync(join(workDir, '.clwriting'), { recursive: true })
    writeFileSync(
      join(workDir, '.clwriting', 'books.jsonl'),
      JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
    )
    const bookRoot = join(workDir, BOOK)
    docBookRoot = bookRoot
    mkdirSync(join(bookRoot, '项目'), { recursive: true })
    writeFileSync(
      join(bookRoot, 'book.yaml'),
      'spec_version: 1\nkind: long\nbook:\n  title: 信封测试书\n  genre: 玄幻\nhost: cc\n',
    )
    // 登记一个真实文档（磁盘文件真实存在——create 撞它测 ALREADY_EXISTS。
    // 注意用 写作/ 树：启动迁移（migrateFinalizedRevisions）会把未定稿书的 定稿/ 文件挪回 写作/）
    mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
    writeFileSync(join(bookRoot, '写作', '正文', '0001-开篇.md'), '# 开篇\n\n正文\n')
    const m = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
    upsertEntry(m, { id: 'doc_env1', nodeType: 'document', path: '写作/正文/0001-开篇.md', parentId: null })
    writeManifest(join(bookRoot, '项目', '文档清单.jsonl'), m)

    docServer = await startServerSafe({ port: 0, workDir })
    docBaseUrl = `http://127.0.0.1:${(docServer.address() as AddressInfo).port}`
    const r = await fetch(`${docBaseUrl}/api/boot`)
    token = ((await r.json()) as { token: string }).token
  })

  afterAll(async () => {
    if (docServer) await new Promise<void>((r) => docServer!.close(() => r()))
  })

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${docBaseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-studio-token': token, origin: docBaseUrl },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  it('create 撞已存在文件 → 409 {code: ALREADY_EXISTS, error: 人话 reason}', async () => {
    const resp = await call('POST', `/api/books/${encodeURIComponent(BOOK)}/documents`, {
      relPath: '写作/正文/0001-开篇.md',
    })
    expect(resp.status).toBe(409)
    expect(resp.headers.get('content-type')).toContain('application/json')
    const j = (await resp.json()) as Record<string, unknown>
    expect(j['code']).toBe('ALREADY_EXISTS')
    expect(typeof j['error']).toBe('string')
    expect(j['error']).toContain('已存在')
  })

  it('patch 未知 docId → 404 {code: NOT_FOUND, error: reason}（信封而非裸 result）', async () => {
    const resp = await call('PATCH', `/api/books/${encodeURIComponent(BOOK)}/documents/doc_unknown000000000000`, {
      op: 'rename',
      newName: '改名',
    })
    expect(resp.status).toBe(404)
    const j = (await resp.json()) as Record<string, unknown>
    expect(j['code']).toBe('NOT_FOUND')
    expect(typeof j['error']).toBe('string')
    expect('ok' in j).toBe(false) // 旧裸 result 形状（ok:false + reason）不得回潮
  })

  it('copy 未知 docId → 404 信封', async () => {
    const resp = await call('POST', `/api/books/${encodeURIComponent(BOOK)}/documents/doc_unknown000000000000/copy`, {
      relPath: '写作/正文/0002-副本.md',
    })
    expect(resp.status).toBe(404)
    expect(((await resp.json()) as Record<string, unknown>)['code']).toBe('NOT_FOUND')
  })

  it('delete 未知 docId → 404 信封', async () => {
    const resp = await call('DELETE', `/api/books/${encodeURIComponent(BOOK)}/documents/doc_unknown000000000000`)
    expect(resp.status).toBe(404)
    expect(((await resp.json()) as Record<string, unknown>)['code']).toBe('NOT_FOUND')
  })

  it('trash restore / purge 未知条目 → 404 信封', async () => {
    const r1 = await call('POST', `/api/books/${encodeURIComponent(BOOK)}/trash/no-such-entry/restore`)
    expect(r1.status).toBe(404)
    expect(((await r1.json()) as Record<string, unknown>)['code']).toBe('NOT_FOUND')

    const r2 = await call('DELETE', `/api/books/${encodeURIComponent(BOOK)}/trash/no-such-entry`)
    expect(r2.status).toBe(404)
    expect(((await r2.json()) as Record<string, unknown>)['code']).toBe('NOT_FOUND')
  })

  // 出口统一脱敏的端到端锚：Node 各 errno 消息把**绝对路径原样内嵌**（ENOENT/EACCES/
  // ENOTDIR/EEXIST 带路径，EISDIR 不带），一路直出前端 toast——本机用户名与目录结构
  // 随之泄漏。单点收口在 replyError（不逐 call site 判哪条 message 会带路径）。
  it('坏档/缺文件请求：响应体不含本机绝对路径（出口统一脱敏）', async () => {
    // 坏档形态：把「路径段是文件」造出来，mkdir -p 该段时 errno 原文内嵌目录绝对路径
    writeFileSync(join(docBookRoot, '写作', '第二卷'), 'x')
    const bad = await call('POST', `/api/books/${encodeURIComponent(BOOK)}/documents`, {
      relPath: '写作/第二卷/0001-章.md',
    })
    expect(bad.status).toBe(409)
    const badBody = (await bad.json()) as { code: string; error: string }
    expect(badBody.code).toBe('WRITE_ERROR')
    // 原文形态 `mkdir '/<tmp>/…/写作/第二卷'`——书库根按带名占位符替换
    expect(badBody.error).toContain("mkdir '<书库根>")
    expect(badBody.error).not.toContain(docWorkDir)
    expect(badBody.error).not.toContain(tmpdir())
    expect(badBody.error).not.toContain(homedir())

    // 缺文件形态：book.yaml 被删，身份读数走 readBookConfig 失败分支
    const yamlPath = join(docBookRoot, 'book.yaml')
    const yaml = readFileSync(yamlPath, 'utf-8')
    try {
      rmSync(yamlPath)
      const gone = await call('GET', `/api/books/${encodeURIComponent(BOOK)}`)
      expect(gone.status).toBe(500)
      const goneBody = (await gone.json()) as { code: string; error: string }
      expect(goneBody.code).toBe('IO_ERROR')
      expect(goneBody.error).not.toContain(docWorkDir)
      expect(goneBody.error).not.toContain(tmpdir())
      expect(goneBody.error).not.toContain(homedir())
    } finally {
      writeFileSync(yamlPath, yaml)
    }
  })
})

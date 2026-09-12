/**
 * 测试精简批（2026-09-12，台账 L201/L210 预登记项「withStudioServer 组合 helper」）：
 * 收编 test/studio ~119 文件手写 server 启动样板的公共骨架——
 *   tmp workDir + .clwriting/books.jsonl（+可选 book.yaml）+ startServerSafe + /api/boot 取
 *   token + fetch 式 req() 包装 + close() 统一收口（还原 env → 关服 → 删 workDir）。
 *
 * 语义对齐说明：
 * - req() 逐字对齐存量主流形态（fetch + x-studio-token + origin + JSON body；非 JSON 容错为 null）。
 *   个别文件用裸 http.request（手工 content-length）或有畸形 body/免 token 等特殊面的，
 *   保留其本地请求函数、只用本 helper 收编启动段。
 * - close() 幂等；workDir 由本 helper 创建、由 close() 删除（对齐存量「afterAll 里关服」的
 *   显式清理惯例）。userDataPath 一律由调用方创建与清理（默认不落任何用户数据目录）。
 * - env 在启动前注入、close() 还原（含删除 undefined 语义），替代各文件手写 prev/restore 对。
 */
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { startServerSafe } from './safe-port.js'

export interface StudioReqResult {
  status: number
  json: unknown
}

export interface StudioHarness {
  readonly workDir: string
  readonly bookRoot: string
  readonly baseUrl: string
  readonly token: string
  readonly server: Server
  /** 常规 JSON 端点请求（带 token + origin；非 JSON 响应容错为 json=null） */
  req(method: string, path: string, body?: unknown): Promise<StudioReqResult>
  /** 幂等收口：还原 env → 关服 → 删 workDir */
  close(): Promise<void>
}

export interface BootStudioOptions {
  /** 书名：books.jsonl 登记项 + bookRoot 目录名（目录不预建，调用方按需自建）；缺省 = 空书架形态（不写 .clwriting/books.jsonl） */
  book?: string
  /** books.jsonl 的 kind 字段（默认 'long'；仅在 book 提供时生效） */
  kind?: 'long' | 'short'
  /** 独立用户数据目录（事件库等场景由调用方 mkdtemp 并自行清理） */
  userDataPath?: string
  /** book.yaml 全文（提供时才写；需先建 bookRoot——本 helper 会 recursive 建好再写） */
  bookYaml?: string
  /** 启动前在 bookRoot 下预建的目录清单（recursive；保持「先落盘后起服」的既有顺序） */
  dirs?: string[]
  /** 启动前在 bookRoot 下预写的文件清单（content 逐字节；目录自动递归创建） */
  files?: Array<{ rel: string; content: string }>
  /** mkdtemp 前缀（默认 'clw-studio-'；原文件有专名前缀的保持原样传入） */
  prefix?: string
  /** 启动前注入 process.env、close() 时还原（如 { CLWRITING_DRIVER: 'mock' }；值为 undefined 表示删除该键） */
  env?: Record<string, string | undefined>
}

export async function bootStudio(opts: BootStudioOptions): Promise<StudioHarness> {
  const workDir = mkdtempSync(join(tmpdir(), opts.prefix ?? 'clw-studio-'))
  if (opts.book !== undefined) {
    mkdirSync(join(workDir, '.clwriting'), { recursive: true })
    writeFileSync(
      join(workDir, '.clwriting', 'books.jsonl'),
      JSON.stringify({ name: opts.book, path: opts.book, kind: opts.kind ?? 'long' }) + '\n',
    )
  }
  const bookRoot = join(workDir, opts.book ?? '')
  mkdirSync(bookRoot, { recursive: true })
  for (const rel of opts.dirs ?? []) mkdirSync(join(bookRoot, rel), { recursive: true })
  if (opts.bookYaml !== undefined) writeFileSync(join(bookRoot, 'book.yaml'), opts.bookYaml, 'utf8')
  for (const f of opts.files ?? []) {
    const abs = join(bookRoot, f.rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, f.content, 'utf8')
  }
  const savedEnv: Array<[string, string | undefined]> = []
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    savedEnv.push([k, process.env[k]])
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  const server = await startServerSafe({ port: 0, workDir, userDataPath: opts.userDataPath })
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const bootRes = await fetch(`${baseUrl}/api/boot`)
  const token = ((await bootRes.json()) as { token: string }).token

  async function req(method: string, path: string, body?: unknown): Promise<StudioReqResult> {
    const r = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'x-studio-token': token,
        origin: baseUrl,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    let json: unknown = null
    try {
      json = await r.json()
    } catch {
      /* 非 JSON 留 null */
    }
    return { status: r.status, json }
  }

  let closed = false
  async function close(): Promise<void> {
    if (closed) return
    closed = true
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(workDir, { recursive: true, force: true })
  }

  return { workDir, bookRoot, baseUrl, token, server, req, close }
}

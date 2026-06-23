/**
 * CLI 确定性步端点(C.2b):spawn `clwriting` CLI 跑 prepare/confirm/check/finalize/enter。
 *
 * POST /api/books/:name/cli  body {step, chapter?}
 *   → spawn `clwriting <step> <chapter?>` (cwd=bookRoot)→ {ok, code, stdout, stderr}
 *
 * 确定性步(非大模型),走 CLI(封装 db / 细纲解析 / 哈希 / finalize 等),不违反 GUI 不直连大模型红线。
 * 通用端点:C.2b prepare/confirm + C.3 check/finalize/enter 共用。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { route } from '../router.js'
import { readBooks } from '../../../install/books.js'

interface CliCtx {
  workDir: string | null
}

/** 允许的确定性 CLI 步(白名单防注入) */
const ALLOWED_STEPS = new Set(['prepare', 'confirm', 'check', 'finalize', 'enter'])

export function registerCliRoutes(ctx: CliCtx): void {
  route('POST', '/api/books/:name/cli', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })

    const body = await readJson(req)
    const step = String(body['step'] ?? '')
    if (!ALLOWED_STEPS.has(step)) return reply(res, 400, { error: `step 不支持:${step}` })
    const chapter = Number(body['chapter'])
    const args = [step]
    // prepare/confirm 传章号;check/finalize 显式传草稿路径 工作区/草稿-<章号>.md(与 review --chapter=N 推导一致);enter 无参
    if ((step === 'prepare' || step === 'confirm') && Number.isInteger(chapter) && chapter > 0) {
      args.push(String(chapter))
    } else if ((step === 'check' || step === 'finalize') && Number.isInteger(chapter) && chapter > 0) {
      args.push(`工作区/草稿-${chapter}.md`)
    }

    const bookRoot = join(ctx.workDir, entry.path)
    const result = await runClwriting(args, bookRoot)
    reply(res, result.ok ? 200 : 500, { ...result, step })
  })
}

/** spawn `node <cli.js> <args>`(cwd=bookRoot;cli.js = studio 自身入口 process.argv[1]) */
function runClwriting(
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [process.argv[1] as string, ...args], { cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => {
      stdout += c.toString()
    })
    child.stderr.on('data', (c) => {
      stderr += c.toString()
    })
    child.on('error', (e) => resolve({ ok: false, code: -1, stdout, stderr: e.message }))
    child.on('close', (code) => resolve({ ok: code === 0, code: code ?? 0, stdout, stderr }))
  })
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let buf = ''
    req.on('data', (c) => {
      buf += c
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(buf || '{}'))
      } catch {
        resolve({})
      }
    })
  })
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

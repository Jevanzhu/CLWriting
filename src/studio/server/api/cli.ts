/**
 * CLI 确定性步端点(C.2b + 短篇轮1):spawn clwriting 跑 prepare/confirm/check/finalize/enter。
 *
 * POST /api/books/:name/cli  body {step, chapter?}
 *   → spawn `clwriting <step> [args]` (cwd=bookRoot)→ {ok, code, stdout, stderr}
 *
 * 确定性步(非大模型),走 CLI。prepare/confirm 传章号;
 * check/finalize 长篇传 工作区/草稿-<章号>.md,短篇不传(默认 草稿-1.md 候选);enter 无参。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { route } from '../router.js'
import { readBooks } from '../../../install/books.js'
import { readBookConfig } from '../../../format/yaml.js'

interface CliCtx {
  workDir: string | null
}

/** 允许的确定性 CLI 步(白名单防注入) */
const ALLOWED_STEPS = new Set(['prepare', 'confirm', 'check', 'finalize', 'enter'])

/** Electron 运行时?Electron 下 spawn clwriting CLI 需 ELECTRON_RUN_AS_NODE + 定位 dist/cli.js */
const isElectron = !!process.versions.electron
const here = dirname(fileURLToPath(import.meta.url))

export function registerCliRoutes(ctx: CliCtx): void {
  route('POST', '/api/books/:name/cli', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })

    const body = await readJson(req)
    const step = String(body['step'] ?? '')
    if (!ALLOWED_STEPS.has(step)) return reply(res, 400, { error: `step 不支持:${step}` })
    const chapter = Number(body['chapter'])
    const bookRoot = join(ctx.workDir, entry.path)
    const kind = readKind(bookRoot)
    const args = [step]
    // prepare/confirm 传章号;check/finalize 长篇传草稿路径,短篇默认草稿-1.md(不传);enter 无参
    if ((step === 'prepare' || step === 'confirm') && Number.isInteger(chapter) && chapter > 0) {
      args.push(String(chapter))
    } else if ((step === 'check' || step === 'finalize') && kind === 'long' && Number.isInteger(chapter) && chapter > 0) {
      args.push(`工作区/草稿-${chapter}.md`)
    }

    const result = await runClwriting(args, bookRoot)
    reply(res, result.ok ? 200 : 500, { ...result, step })
  })
}

/** 读 book.yaml kind(long 缺省 / short) */
function readKind(bookRoot: string): 'long' | 'short' {
  const r = readBookConfig(join(bookRoot, 'book.yaml'))
  if (!r.ok) return 'long'
  return ((r as { config: { kind?: string } }).config.kind ?? 'long') === 'short' ? 'short' : 'long'
}

/** 定位 clwriting CLI spawn 目标（双模式,#electron）。
 *  studio 模式:node + process.argv[1](=dist/cli.js)。
 *  Electron 模式:electron + ELECTRON_RUN_AS_NODE + here/../cli.js(否则 electron 会起 GUI)。 */
export function resolveSpawnTarget(
  isElectron: boolean,
  here: string,
  argv1: string,
): { cliJs: string; useRunAsNode: boolean } {
  return isElectron
    ? { cliJs: resolve(here, '..', 'cli.js'), useRunAsNode: true }
    : { cliJs: argv1, useRunAsNode: false }
}

/** spawn clwriting CLI 跑确定性步(cwd=bookRoot)。
 *  studio 模式:node dist/cli.js(process.argv[1])。
 *  Electron 模式:electron + ELECTRON_RUN_AS_NODE=1 跑 dist/cli.js(here/../cli.js),否则 electron 会起 GUI。 */
function runClwriting(
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> {
  const { cliJs, useRunAsNode } = resolveSpawnTarget(isElectron, here, process.argv[1] as string)
  const env = useRunAsNode ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env
  return new Promise((done) => {
    const child = spawn(process.execPath, [cliJs, ...args], { cwd, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => {
      stdout += c.toString()
    })
    child.stderr.on('data', (c) => {
      stderr += c.toString()
    })
    child.on('error', (e) => done({ ok: false, code: -1, stdout, stderr: e.message }))
    child.on('close', (code) => done({ ok: code === 0, code: code ?? 0, stdout, stderr }))
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

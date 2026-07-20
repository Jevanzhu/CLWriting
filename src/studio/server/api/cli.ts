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
import { join } from 'node:path'
import { route } from '../router.js'
import { readJson, reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { readBookConfig } from '../../../format/yaml.js'
import { resolveSpawnTarget, runClwritingCli } from '../cli-runner.js'

export { resolveSpawnTarget }

interface CliCtx {
  workDir: string | null
}

/** 允许的确定性 CLI 步(白名单防注入；hand=W2B 手写起草；rebook=W2B 态 3 补登) */
const ALLOWED_STEPS = new Set(['prepare', 'confirm', 'check', 'finalize', 'enter', 'hand', 'rebook'])

export function registerCliRoutes(ctx: CliCtx): void {
  route('POST', '/api/books/:name/cli', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })

    const body = await readJson(req)
    const step = String(body['step'] ?? '')
    if (!ALLOWED_STEPS.has(step)) return reply(res, 400, { error: `step 不支持:${step}` })
    const chapter = Number(body['chapter'])
    const yes = body['yes'] === true
    const bookRoot = join(ctx.workDir, entry.path)
    const kind = readKind(bookRoot)
    const args = [step]
    // rebook 传 --yes（补登）；prepare/confirm/hand 传章号；check/finalize 长篇传草稿路径；enter 无参
    if (step === 'rebook') {
      if (yes) args.push('--yes')
    } else if ((step === 'prepare' || step === 'confirm' || step === 'hand') && Number.isInteger(chapter) && chapter > 0) {
      args.push(String(chapter))
    } else if ((step === 'check' || step === 'finalize') && kind === 'long' && Number.isInteger(chapter) && chapter > 0) {
      args.push(`工作区/草稿-${chapter}.md`)
    }

    const result = await runClwritingCli(args, bookRoot)
    reply(res, result.ok ? 200 : 500, { ...result, step })
  })
}

/** 读 book.yaml kind(long 缺省 / short) */
function readKind(bookRoot: string): 'long' | 'short' {
  const r = readBookConfig(join(bookRoot, 'book.yaml'))
  if (!r.ok) return 'long'
  return ((r as { config: { kind?: string } }).config.kind ?? 'long') === 'short' ? 'short' : 'long'
}

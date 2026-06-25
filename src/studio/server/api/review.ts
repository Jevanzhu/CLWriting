/**
 * review 三审端点(C.3):CLI run 打包 → driver spawnRole×3 产 issues JSON → CLI collect 产审稿.md。
 *
 * POST /api/books/:name/review  body {chapter}
 *   ① spawn `clwriting review run --chapter=N` → 工作区/三审/packet.json
 *   ② 读 packet → 各 lens spawnRole(`<lens>-review`) 收 issues JSON → 工作区/三审/issues-<lens>.json
 *   ③ spawn `clwriting review collect --chapter=N` → 工作区/审稿.md
 *   → 返 {ok, lenses, report(审稿.md 全文)}
 *
 * POST /api/books/:name/review-verdict  body {approved}
 *   → 改 工作区/审稿.md verdict 行(approved 写「通过」)→ finalize 据此放行
 *
 * B 编排:run/collect 是 CLI 确定性打包/回收,spawnRole×3 是真审稿(AI);串行避 GLM 并发。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { route } from '../router.js'
import { readJson, reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { readFile } from '../../../format/frontmatter.js'
import { readBookConfig } from '../../../format/yaml.js'
import { getDriver, ensureSession } from '../../../driver/index.js'
import type { DriverEvent } from '../../../driver/types.js'
import { runClwritingCli } from '../cli-runner.js'

interface ReviewCtx {
  workDir: string | null
}

const LENS_LABEL: Record<string, string> = {
  reader: '读者',
  editor: '编辑',
  continuity: '连续性',
  hook: '钩子',
  emotion_peak: '情绪反转',
  payoff: '回报',
}

/** 镜头 → 角色文件名(emotion_peak 镜头对应 emotion-review 角色文件,名不一致) */
export function lensToRole(lens: string): string {
  if (lens === 'emotion_peak') return 'emotion-review'
  return `${lens}-review`
}

/** 读 book.yaml kind(long 缺省 / short) */
function readKind(bookRoot: string): 'long' | 'short' {
  const r = readBookConfig(join(bookRoot, 'book.yaml'))
  if (!r.ok) return 'long'
  return ((r as { config: { kind?: string } }).config.kind ?? 'long') === 'short' ? 'short' : 'long'
}

const REVIEW_VERDICT_MARKER = '<!-- verdict: approved -->'

export function registerReviewRoutes(ctx: ReviewCtx): void {
  // 三审:run → spawnRole×3 → collect
  route('POST', '/api/books/:name/review', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })
    const reqBody = await readJson(req)
    const chapter = Number(reqBody['chapter'])
    if (!Number.isInteger(chapter) || chapter < 1) return reply(res, 400, { error: 'chapter 需为正整数' })

    const bookRoot = join(ctx.workDir, entry.path)
    const kind = readKind(bookRoot)
    const workDir = join(bookRoot, '工作区')

    // ① review run(CLI 打包,产 工作区/三审/packet.json)
    const runResult = await runClwritingCli(['review', 'run', '--chapter=' + String(chapter)], bookRoot)
    if (!runResult.ok) {
      return reply(res, 500, { error: `review run 失败:${(runResult.stderr || runResult.stdout).trim().slice(0, 200)}` })
    }

    const packetPath = join(workDir, '三审', 'packet.json')
    if (!existsSync(packetPath)) return reply(res, 500, { error: 'review run 未产出 packet.json' })
    let packet: {
      lenses_run: string[]
      packets: Array<{
        lens: string
        title?: string
        focus?: string[]
        ledger_checks?: Array<{ lead_id: string; chapter: number; verb: string; evidence: string }>
      }>
    }
    try {
      packet = JSON.parse(readFileSync(packetPath, 'utf8'))
    } catch {
      return reply(res, 500, { error: 'packet.json 解析失败(文件损坏或写入未完成)' })
    }

    // 草稿正文(去 front matter):长篇 草稿-<章号>.md;短篇 草稿-1.md(候选),与 /draft-save 落盘一致
    const draftPath = join(workDir, kind === 'short' ? '草稿-1.md' : `草稿-${chapter}.md`)
    if (!existsSync(draftPath)) return reply(res, 400, { error: '无草稿(先写稿)' })
    const draftFile = readFile(draftPath)
    const draftBody = draftFile.ok ? (draftFile as { body: string }).body : readFileSync(draftPath, 'utf8')

    // ② 各 lens spawnRole 产 issues JSON(串行);逐角进度经主 session 回流(6.8④)
    const driver = getDriver('cc')
    const lenses: string[] = []
    mkdirSync(join(workDir, '三审'), { recursive: true })
    const mainSession = await ensureSession(params['name']!, ctx.workDir!)
    const emitProgress = (lens: string, phase: 'start' | 'done'): void => {
      if (driver.emit) driver.emit(mainSession, { type: 'review-progress', lens, label: LENS_LABEL[lens] ?? lens, phase })
    }
    for (const sub of packet.packets) {
      const lens = sub.lens
      lenses.push(lens)
      emitProgress(lens, 'start')
      const prompt = buildLensPrompt(lens, sub, draftBody, chapter, kind)
      const session = await driver.startSession(ctx.workDir!)
      driver.spawnRole(session, lensToRole(lens), prompt)
      let text = ''
      try {
        for await (const ev of driver.stream(session) as AsyncGenerator<DriverEvent>) {
          if (ev.type === 'text') text += String(ev.text ?? '')
          else if (ev.type === 'done') break
          else if (ev.type === 'error') {
            driver.dispose(session)
            return reply(res, 500, { error: `${lens}-review driver:${ev.message}` })
          }
        }
      } catch (e) {
        driver.dispose(session)
        return reply(res, 500, { error: `${lens}-review stream:${e instanceof Error ? e.message : String(e)}` })
      }
      driver.dispose(session)
      writeFileSync(join(workDir, '三审', `issues-${lens}.json`), extractJson(text), 'utf8')
      emitProgress(lens, 'done')
    }

    // ③ review collect(CLI 回收产审稿.md)
    const collectResult = await runClwritingCli(['review', 'collect', '--chapter=' + String(chapter)], bookRoot)
    if (!collectResult.ok) {
      return reply(res, 500, { error: `review collect 失败:${(collectResult.stderr || collectResult.stdout).trim().slice(0, 200)}` })
    }

    const verdictPath = join(workDir, '审稿.md')
    const report = existsSync(verdictPath) ? readFileSync(verdictPath, 'utf8') : '(未生成审稿单)'
    reply(res, 200, { ok: true, lenses, report, collectLog: collectResult.stdout.trim().slice(0, 200) })
  })

  // 裁决:改 审稿.md verdict 行
  route('POST', '/api/books/:name/review-verdict', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })
    const reqBody = await readJson(req)
    const approved = reqBody['approved'] === true
    const verdictPath = join(ctx.workDir, entry.path, '工作区', '审稿.md')
    if (!existsSync(verdictPath)) return reply(res, 404, { error: '无审稿单(先跑三审)' })
    let md = readFileSync(verdictPath, 'utf8')
    const target = approved
      ? `${REVIEW_VERDICT_MARKER} verdict: 通过`
      : `${REVIEW_VERDICT_MARKER} verdict: <把「通过」填这里>`
    const re = new RegExp(`${escapeRegexp(REVIEW_VERDICT_MARKER)} verdict: [^\\n]*`)
    if (re.test(md)) {
      md = md.replace(re, target)
    } else {
      md += `\n\n${target}\n`
    }
    writeFileSync(verdictPath, md, 'utf8')
    reply(res, 200, { ok: true, approved })
  })
}

/** 组单视角审稿 prompt:焦点 + 账本核对(continuity)+ 正文 + 输出契约 */
function buildLensPrompt(
  lens: string,
  sub: { title?: string; focus?: string[]; ledger_checks?: Array<{ lead_id: string; chapter: number; verb: string; evidence: string }> },
  draftBody: string,
  chapter: number,
  kind: 'long' | 'short',
): string {
  const unit = kind === 'short' ? '篇' : '章'
  const parts: string[] = [`## 任务\n你是第 ${chapter} ${unit}的${LENS_LABEL[lens] ?? lens}审稿员,按视角审正文,只报问题。`]
  if (sub.focus?.length) parts.push(`## 焦点\n${sub.focus.map((f) => `- ${f}`).join('\n')}`)
  if (lens === 'continuity') {
    const checks = sub.ledger_checks ?? []
    parts.push(
      checks.length
        ? `## 账本核对(逐条核对账实相符)\n${checks.map((c) => `- ${c.lead_id} 第${c.chapter}章 ${c.verb}:${c.evidence}`).join('\n')}`
        : `## 账本核对\n(本章无账本清单)`,
    )
  }
  parts.push(`## 正文\n${draftBody}`)
  parts.push(
    `## 输出契约\n直接输出 JSON 数组(不要多余文字、不要读文件、不要用任何工具),无问题回 []。每个 issue 必须是:\n{"category": "<枚举>", "severity": "<S1|S2|S3|S4>", "evidence": "正文原句", "issue": "问题说明", "fix": "改稿建议"}\n- category 从枚举选:high_point(爽点)/reader_pull(追读牵引)/pacing(节奏)/ooc(人物崩坏)/logic(逻辑)/consistency(一致性)/continuity(连续性)/setting(设定)/timeline(时间线)/strand(线索)/ledger(账本)/safety(安全红线)\n- severity:S1致命/S2严重/S3一般/S4建议\n- evidence 必须引用正文原句\n- 只报问题,不要正面确认`,
  )
  return parts.join('\n\n')
}

/** 从模型 text 提取 JSON(容忍前后叙述) */
function extractJson(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return trimmed
  const arr = trimmed.match(/\[[\s\S]*\]/)
  if (arr) return arr[0]
  const obj = trimmed.match(/\{[\s\S]*\}/)
  if (obj) return obj[0]
  return trimmed
}

function escapeRegexp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

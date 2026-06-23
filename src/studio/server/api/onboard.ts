/**
 * onboard 段2 端点(2.4):AI 填设定(总纲/角色/世界观/境界)。
 *
 * POST /api/books/:name/onboard-ai  body {step}
 *   step: synopsis | characters | world | realm
 *   → 组 prompt(title/genre/kind)→ spawnRole('onboard', prompt)禁工具 → 收 text → 落盘
 *   → {ok, step, path, words, content}
 *
 * 各步独立 spawnRole(避 GLM send spawn Agent 卡死,C.2a 教训)。role='onboard'
 * 无 agents/onboard.md → readRolePrompt 返空 → 纯 prompt 驱动(任务+设定规范自含)。
 * realm 仅成长线书(leads enabled 含「成长线」)。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { route } from '../router.js'
import { readBooks } from '../../../install/books.js'
import { readBookConfig } from '../../../format/yaml.js'
import { getDriver } from '../../../driver/index.js'
import type { DriverEvent } from '../../../driver/types.js'

interface OnboardCtx {
  workDir: string | null
}

type OnboardStep = 'synopsis' | 'characters' | 'world' | 'realm'

/** 各步落盘路径(相对 bookRoot)*/
const STEP_PATH: Record<OnboardStep, string> = {
  synopsis: '大纲/总纲.md',
  characters: '定稿/设定/名册.md',
  world: '定稿/设定/世界观.md',
  realm: '定稿/设定/境界体系.md',
}

export function registerOnboardRoutes(ctx: OnboardCtx): void {
  route('POST', '/api/books/:name/onboard-ai', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })
    const reqBody = await readJson(req)
    const step = String(reqBody['step'] ?? '') as OnboardStep
    if (!['synopsis', 'characters', 'world', 'realm'].includes(step)) {
      return reply(res, 400, { error: `step 不支持:${step}` })
    }

    const bookRoot = join(ctx.workDir, entry.path)
    const cfgResult = readBookConfig(join(bookRoot, 'book.yaml'))
    if (!cfgResult.ok) return reply(res, 500, { error: `读 book.yaml 失败:${cfgResult.error}` })
    const config = (cfgResult as { config: { book: { title: string; genre: string }; kind?: string; leads?: { enabled?: string[] } } }).config
    const title = config.book.title
    const genre = config.book.genre
    const kind = config.kind ?? 'long'
    const leadsEnabled = config.leads?.enabled ?? []

    // realm 仅成长线书
    if (step === 'realm' && !leadsEnabled.includes('成长线')) {
      return reply(res, 400, { error: 'realm 步仅成长线书(book.yaml leads 未启用成长线)' })
    }

    const prompt = buildOnboardPrompt(step, title, genre, kind)

    const driver = getDriver('cc')
    const session = await driver.startSession(ctx.workDir)
    driver.spawnRole(session, 'onboard', prompt)
    let text = ''
    try {
      for await (const ev of driver.stream(session) as AsyncGenerator<DriverEvent>) {
        if (ev.type === 'text') text += String(ev.text ?? '')
        else if (ev.type === 'done') break
        else if (ev.type === 'error') {
          driver.dispose(session)
          return reply(res, 500, { error: `driver:${ev.message}` })
        }
      }
    } catch (e) {
      driver.dispose(session)
      return reply(res, 500, { error: `stream:${e instanceof Error ? e.message : String(e)}` })
    }
    driver.dispose(session)

    const content = text.trim() || '(空产出)'
    const relPath = STEP_PATH[step]
    try {
      mkdirSync(join(bookRoot, step === 'synopsis' ? '大纲' : '定稿/设定'), { recursive: true })
      writeFileSync(join(bookRoot, relPath), content, 'utf8')
    } catch (e) {
      return reply(res, 500, { error: `落盘:${e instanceof Error ? e.message : String(e)}` })
    }
    reply(res, 200, { ok: true, step, path: relPath, words: content.length, content })
  })
}

/** 组 onboard prompt(各步任务 + 设定规范防臆造)*/
function buildOnboardPrompt(step: OnboardStep, title: string, genre: string, kind: string): string {
  const ctx = `题材:${genre}  书名:《${title}》  篇幅:${kind === 'short' ? '短篇集' : '长篇'}`
  const common = `\n\n## 设定规范(防臆造)\n- 据「${genre}」题材内生推导,不臆造与题材冲突的设定\n- 留余地(后续卷/章可展开),不过度填死\n\n## 输出\n直接输出 markdown 全文,不要读文件、不要用任何工具。`
  switch (step) {
    case 'synopsis':
      return `## 任务\n为这部${genre}小说《${title}》生成总纲。\n\n${ctx}\n\n## 要求\n产出总纲,含:核心(一句话主线)、主角(姓名/身份/驱动/初始处境)、世界观(力量体系/核心势力/规则)、主线(明线成长 + 暗线探秘)、反转靶心(全书最大反转)、卷目(第一卷定位)。${common}`
    case 'characters':
      return `## 任务\n为这部${genre}小说《${title}》生成首批角色(3-5 个主角)。\n\n${ctx}\n\n## 要求\n产出角色名册,每角一段:\n### 角色名\n- 身份 / 动机 / 外貌 / 性格 / 弧光(成长轨迹)\n主角群覆盖正反、师友、敌对关系。${common}`
    case 'world':
      return `## 任务\n为这部${genre}小说《${title}》生成世界观。\n\n${ctx}\n\n## 要求\n产出世界观,含:力量体系(境界/修炼法门)、社会结构(势力/组织/阶层)、核心规则(世界运转法则/禁忌)。${common}`
    case 'realm':
      return `## 任务\n为这部${genre}小说《${title}》生成境界体系(成长线进阶链)。\n\n${ctx}\n\n## 要求\n产出境界体系:进阶链(低→高,如炼气→筑基→金丹→…→最高),每境界一句话简述特征;留高层境界余地(后续卷可揭)。${common}`
  }
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

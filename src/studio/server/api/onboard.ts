/**
 * onboard 段2 端点(2.4):AI 填设定(长篇 9 步 / 短篇专属待补)。
 *
 * POST /api/books/:name/onboard-ai  body {step}
 *   长篇 step: synopsis|characters|world|realm|volume|leads-seed|style-sample|style-rules|style-quotes
 *   → 组 prompt(title/genre/kind)→ spawnRole('onboard', prompt)禁工具 → 收 text → 落盘
 *   → {ok, step, path, words, content}
 *
 * 各步独立 spawnRole(避 GLM send spawn Agent 卡死,C.2a 教训)。role='onboard'
 * 无 agents/onboard.md → readRolePrompt 返空 → 纯 prompt 驱动(任务+设定规范自含)。
 * realm 仅成长线书(leads enabled 含「成长线」)。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { route } from '../router.js'
import { readBooks } from '../../../install/books.js'
import { readBookConfig } from '../../../format/yaml.js'
import { getDriver } from '../../../driver/index.js'
import type { DriverEvent } from '../../../driver/types.js'

interface OnboardCtx {
  workDir: string | null
}

type OnboardStep =
  | 'synopsis'
  | 'characters'
  | 'world'
  | 'realm'
  | 'volume'
  | 'leads-seed'
  | 'style-sample'
  | 'style-rules'
  | 'style-quotes'
  | 'collection-pitch'
  | 'first-outline'

/** 各步落盘路径(相对 bookRoot)*/
const STEP_PATH: Record<OnboardStep, string> = {
  synopsis: '大纲/总纲.md',
  characters: '定稿/设定/名册.md',
  world: '定稿/设定/世界观.md',
  realm: '定稿/设定/境界体系.md',
  volume: '大纲/卷纲/卷纲_第1卷.md',
  'leads-seed': '大纲/账本种子.md',
  'style-sample': '文风/样章库.md',
  'style-rules': '文风/文风铁律.md',
  'style-quotes': '文风/金句库.md',
  'collection-pitch': '定稿/设定/集子定位.md',
  'first-outline': '工作区/首篇细纲.md',
}

export function registerOnboardRoutes(ctx: OnboardCtx): void {
  route('POST', '/api/books/:name/onboard-ai', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })
    const reqBody = await readJson(req)
    const step = String(reqBody['step'] ?? '') as OnboardStep
    if (!(step in STEP_PATH)) {
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
      mkdirSync(dirname(join(bookRoot, relPath)), { recursive: true })
      writeFileSync(join(bookRoot, relPath), content, 'utf8')
    } catch (e) {
      return reply(res, 500, { error: `落盘:${e instanceof Error ? e.message : String(e)}` })
    }
    reply(res, 200, { ok: true, step, path: relPath, words: content.length, content })
  })

  // 保存编辑（作者预览后改内容再落盘，5.2 交互「改 + 确认落盘」）
  route('POST', '/api/books/:name/onboard-save', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })
    const body = await readJson(req)
    const step = String(body['step'] ?? '') as OnboardStep
    if (!(step in STEP_PATH)) return reply(res, 400, { error: `step 不支持:${step}` })
    const content = typeof body['content'] === 'string' ? body['content'] : ''
    const bookRoot = join(ctx.workDir, entry.path)
    const relPath = STEP_PATH[step]
    try {
      mkdirSync(dirname(join(bookRoot, relPath)), { recursive: true })
      writeFileSync(join(bookRoot, relPath), content, 'utf8')
    } catch (e) {
      return reply(res, 500, { error: `落盘:${e instanceof Error ? e.message : String(e)}` })
    }
    reply(res, 200, { ok: true, step, path: relPath, words: content.length })
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
    case 'volume':
      return `## 任务\n为这部${genre}小说《${title}》生成第一卷卷纲。\n\n${ctx}\n\n## 要求\n产出第一卷卷纲,含:本卷主线阶段、核心冲突、关键角色登场顺序、章数预估(30-50 章)、卷末钩子(勾向第二卷)。若已有总纲则据其推导。${common}`
    case 'leads-seed':
      return `## 任务\n为这部${genre}小说《${title}》生成账本种子(各类初始线)。\n\n${ctx}\n\n## 要求\n产出账本种子汇总,基础三类各 1-2 条(伏笔/悬念/感情线),据题材酌加扩展线。每条格式:\n### <类型> <编号> <标题>\n- 开启章: 1  状态: 进行中\n- 线索: 一句话内容\n- 预期回收: 第 N 章\n留余地,不过度填死。${common}`
    case 'style-sample':
      return `## 任务\n为这部${genre}小说《${title}》生成文风样章(5 场景 few-shot)。\n\n${ctx}\n\n## 要求\n产出 5 个场景样章,每场景 200-400 字,体现题材典型笔法。每场景一段:\n### 场景:战斗\n<样章>\n### 场景:对话\n<样章>\n### 场景:抒情\n<样章>\n### 场景:铺陈\n<样章>\n### 场景:爽点\n<样章>\n供写章时文风对齐。${common}`
    case 'style-rules':
      return `## 任务\n为这部${genre}小说《${title}》生成文风铁律(题材定制,替代通用占位)。\n\n${ctx}\n\n## 要求\n产出文风铁律 markdown,含:正文纯文本(禁 MD 语法)、对话标签占比上限、句长方差区间、重复率上限、题材专属规范(如玄幻禁现代词汇、言情禁说教)。${common}`
    case 'style-quotes':
      return `## 任务\n为这部${genre}小说《${title}》生成金句库种子。\n\n${ctx}\n\n## 要求\n产出 20-30 条题材典型金句(角色台词/叙事金句),每条一行,可带角色标注。供写章时点缀。${common}`
    case 'collection-pitch':
      return `## 任务\n为这部${genre}短篇集《${title}》生成集子定位。\n\n${ctx}\n\n## 要求\n产出集子定位,含:集子主线(贯穿主题)、题材定位、目标读者、整体调性、首篇切入点。整集共享设定,各篇独立成篇但有母题串联。${common}`
    case 'first-outline':
      return `## 任务\n为这部${genre}短篇集《${title}》生成首篇细纲。\n\n${ctx}\n\n## 要求\n产出首篇细纲(单篇结构),含:目标情绪、核心反转、五段结构(开场/发展/转折/高潮/余韵,每段一句话)、伏笔回收设计、字数预估(8000-20000)。${common}`
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

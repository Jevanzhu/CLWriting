/**
 * R0916-7-P3-26 / R0916-7-P3-21（0916-7 批）回归：api 层单源与对外面收口锚。
 *
 * ① apiFetch 对外只留 `(path, init)`——递归重试标记（_retried）与超时计量/重放出参
 *    （_gauge/_replayed）此前是对外形参，调用方可见内部状态；现收进私有 apiFetchCore。
 *    源码锚钉两件事：导出签名恰为两参、内部递归只发生在私有函数里。
 * ② 可重放性由调用方显式声明（init.replayable），**不得**再从 body 嗅探 operationId
 *    （原实现对 PUT 做 JSON.parse 找幂等键——每请求多一次全量体解析，且「键名落 body
 *    = 幂等」是隐式契约）。行为面见 client-401-replay-idempotency.test.ts + 下方声明点锚。
 * ③ 截断函数单源：chat-dispatch 的码点截断 import 根 shared/text（P3-26 截断函数项，
 *    本地副本已删）——复活本地副本即红。
 * ④ 工具展示面单源：工具卡（chat/ChatToolCard.vue，自 ChatMessages 拆出的唯一消费面）
 *    的中文名/参数摘要取自根 shared/contract/tool-meta.ts（P3-21 工具名派生项），不得
 *    回落手写工具名清单；跨包面只许 src/shared/**，ai/contract/tool-meta.ts 只是
 *    re-export 桥。
 * ⑤ Beta 标注挂点白名单守卫（AI 辅助面之外不得标 Beta）：档末 describe，判据见其头注。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, readRepoFile } from '../../helpers/repo-root.js'

const CLIENT = 'src/studio/web-next/src/api/client.ts'
const DOCUMENTS = 'src/studio/web-next/src/api/documents.ts'
const CHAT_DISPATCH = 'src/studio/web-next/src/stores/chat-dispatch.ts'
// 工具展示面消费件（拆件前的 ChatMessages.vue 即此断言主体，随迁不悬空）
const CHAT_TOOL_CARD = 'src/studio/web-next/src/components/panels/chat/ChatToolCard.vue'

describe('R0916-7-P3-26: apiFetch 对外面与编码层单源', () => {
  it('apiFetch 导出签名恰为两参 (path, init)；内部管道不对外', () => {
    const src = readRepoFile(CLIENT)
    const m = /export async function apiFetch\(([^)]*)\)/.exec(src)
    expect(m).not.toBeNull()
    expect(m![1]).toBe('path: string, init: ApiFetchInit = {}')
    // 递归重试只发生在私有 apiFetchCore（下一步的 fetch 装配与 401 重放都在其中）
    expect(/^async function apiFetchCore\(/m.test(src)).toBe(true)
    expect(/^export async function apiFetchCore/m.test(src)).toBe(false)
    // apiJson 走私有函数（带计量/重放出参），不经过薄壳
    expect(src).toContain('apiFetchCore(path, { ...reqInit, signal: controller.signal }, false, gauge, replayed)')
  })

  it('删掉靠 JSON.parse 嗅探 operationId 的启发式；重放性只由显式声明驱动', () => {
    const src = readRepoFile(CLIENT)
    expect(src).not.toContain('JSON.parse(body)')
    expect(src).toContain('replayable?: boolean')
    expect(src).toContain('return declared === true')
  })

  it('声明点：文档保存（幂等 operationId）显式声明可重放', () => {
    const src = readRepoFile(DOCUMENTS)
    expect(src).toContain('replayable: true')
  })

  it('截断函数单源：chat-dispatch 引根 shared/text，本地 clipByCodePoints 副本不存在', () => {
    const src = readRepoFile(CHAT_DISPATCH)
    expect(src).toContain("import { codePointLength, clipByCodePoints } from '../../../../shared/text'")
    expect(src).not.toContain('function clipByCodePoints')
  })

  it('工具展示面单源：工具卡的中文名/摘要取自根 shared/contract/tool-meta.ts', () => {
    const src = readRepoFile(CHAT_TOOL_CARD)
    expect(src).toContain(
      "import { toolLabel, toolSummary, type ChapterNameLookup } from '../../../../../../shared/contract/tool-meta'",
    )
  })
})

/**
 * Beta 标注挂点白名单守卫。
 *
 * 口径：项目主体是写作功能、AI 是辅助层——AI 辅助面标 Beta 是准确表达，存量标注保留不动；
 * 本档只拦「给非 AI 功能随手标 Beta」：任何 .vue 的 BetaBadge 挂点（直接挂 / 经 CollapseSection
 * 的裸 beta 属性）都必须落在白名单内，新增挂点须在此登记一行理由。
 *
 * 判据边界（模板正则扫描，不上 Vue AST；宁可多报，不漏报）：
 * ① 文件文本出现 `<BetaBadge`——闭合标签 `</BetaBadge>` 不命中，模板注释里的示例会命中；
 * ② `<CollapseSection` 标签（跨行按同一标签计）属性里含裸 `beta`：beta 前是空白或标签起点，
 *    后紧跟空白 / `>` / `/`；`:beta="false"`、`beta="x"`、`title="… beta …"` 均不算。
 * 行号取标签起始行。白名单条目 = web-next src 相对 posix 路径 + 一句「为什么属 AI 辅助面」。
 * 命中地板（≥12 档）防遍历/正则口径失效后的静默零命中。
 */
const BETA_SRC = join(REPO_ROOT, 'src', 'studio', 'web-next', 'src')

/** web-next src 下全部 .vue 的相对路径（posix，`/` 分隔）。 */
function collectVueFiles(dir: string = BETA_SRC): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      out.push(...collectVueFiles(full))
      continue
    }
    if (name.endsWith('.vue'))
      out.push(
        full
          .slice(BETA_SRC.length + 1)
          .split('\\')
          .join('/'),
      )
  }
  return out
}

/** 全文下标 → 行号（1 基）。 */
function lineAt(src: string, idx: number): number {
  let line = 1
  for (let i = 0; i < idx; i++) if (src[i] === '\n') line++
  return line
}

/** 抽掉属性值（引号内文本），只留属性名——字符串字面量里的 beta 不算裸属性。 */
const stripAttrValues = (tag: string): string => tag.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''")

/** 一档源码的挂点行号（升序、去重）。 */
function mountLines(src: string): number[] {
  const lines = new Set<number>()
  for (const m of src.matchAll(/<BetaBadge/g)) lines.add(lineAt(src, m.index!))
  for (const m of src.matchAll(/<CollapseSection[^>]*/g)) {
    // 尾锚 $：标签文本截到 `>` 前，裸 beta 落在标签末尾时同样算命中
    if (/(^|\s)beta(?=[\s/>]|$)/.test(stripAttrValues(m[0]))) lines.add(lineAt(src, m.index!))
  }
  return [...lines].sort((a, b) => a - b)
}

interface BetaMount {
  file: string
  lines: number[]
}

/** 扫描一组档（[相对路径, 文本]）的挂点。 */
function scanSources(sources: ReadonlyArray<readonly [string, string]>): BetaMount[] {
  const out: BetaMount[] = []
  for (const [file, text] of sources) {
    const lines = mountLines(text)
    if (lines.length > 0) out.push({ file, lines })
  }
  return out
}

/** 未登记白名单的挂点档（文件 + 行号 + 登记状态），即断言失败时要看的那一眼。 */
function outsideWhitelist(mounts: readonly BetaMount[], whitelist: readonly string[]): string[] {
  return mounts.filter((m) => !whitelist.includes(m.file)).map((m) => `${m.file}:${m.lines.join(',')}（未在白名单）`)
}

/** 白名单：挂点档 → 为什么该档属 AI 辅助面。 */
const BETA_WHITELIST: ReadonlyArray<readonly [file: string, why: string]> = [
  ['components/panels/ReviewPanel.vue', '三审面板：AI 多镜头审稿的输出面'],
  ['components/shell/ChatDock.vue', '右栏 AI 对话停靠栏'],
  ['components/shell/SidebarRight.vue', '右栏「AI 分析」折叠区入口，经 CollapseSection 的 beta 属性透出'],
  ['components/style/StyleAcceptancePanel.vue', '文风验收：AI 比对样章与正文的文风偏差'],
  ['components/style/StyleBaselineCard.vue', '文风基线定标：AI 抽取样章文风特征'],
  ['components/ui/CollapseSection.vue', 'BetaBadge 的受控渲染器：beta 由调用方显式开启，本档不自行声明任何功能为 Beta'],
  ['components/ui/SettingsAi.vue', '设置页 AI 对话 / AI 写作卡'],
  ['components/ui/SettingsAnalysis.vue', '设置页知识层 / 关系图 / 知识检索（AI 分析管线）'],
  ['components/ui/SettingsBookAnalysis.vue', '书级知识层 / 关系图 / 知识检索（AI 分析管线）'],
  ['components/ui/SettingsModal.vue', '设置页 AI 写作 / 智能分析 / 服务提供方入口'],
  ['components/workbench/WbDraftCard.vue', '工作台生成正文：AI 起草'],
  ['views/OnboardView.vue', '开书对话：AI 辅助生成设定'],
  ['views/RelationsView.vue', '关系网络：AI 抽取的人物关系图'],
]
const WHITELIST_PATHS: readonly string[] = BETA_WHITELIST.map(([file]) => file)

const REAL_MOUNTS = scanSources(
  collectVueFiles().map((rel) => [rel, readFileSync(join(BETA_SRC, rel), 'utf-8')] as const),
)

describe('Beta 标注挂点白名单守卫（AI 辅助面之外不得标 Beta）', () => {
  it('非白名单内容含 <BetaBadge /> → 被抓出；白名单路径 → 零命中', () => {
    const sources = [
      ['views/FakeView.vue', '<template>\n  <h1>书名 <BetaBadge /></h1>\n</template>\n'],
      ['components/shell/ChatDock.vue', '<template>\n  <span>对话 <BetaBadge /></span>\n</template>\n'],
    ] as const
    const mounts = scanSources(sources)
    expect(mounts.map((m) => `${m.file}:${m.lines.join(',')}`)).toEqual([
      'views/FakeView.vue:2',
      'components/shell/ChatDock.vue:2',
    ])
    expect(outsideWhitelist(mounts, ['components/shell/ChatDock.vue'])).toEqual(['views/FakeView.vue:2（未在白名单）'])
  })

  it('裸 beta 判据：CollapseSection 的裸 beta 算挂点，带值/带冒号/引号内文本不算', () => {
    const cases: Array<[string, number[]]> = [
      ['<CollapseSection title="AI 分析" beta>', [1]],
      ['<CollapseSection\n  title="AI 分析"\n  beta\n/>', [1]],
      ['<CollapseSection :beta="false" title="x">', []],
      ['<CollapseSection beta="x" title="x">', []],
      ['<CollapseSection title="a beta b">', []],
    ]
    for (const [src, want] of cases) expect(mountLines(src), src).toEqual(want)
  })

  it('真实挂点文件集合 ⊆ 白名单（改代码 or 登记白名单，二选一）', () => {
    expect(
      outsideWhitelist(REAL_MOUNTS, WHITELIST_PATHS),
      'BetaBadge 挂点须属 AI 辅助面：去掉该处 Beta，或在 BETA_WHITELIST 登记「路径 + 一句理由」',
    ).toEqual([])
  })

  it('扫描口径未失效：挂点档数 ≥ 12（遍历或正则失效时不得静默零命中）', () => {
    expect(REAL_MOUNTS.length).toBeGreaterThanOrEqual(12)
  })

  it('白名单条目齐备：路径形态合法且每条都有一句人话理由', () => {
    for (const [file, why] of BETA_WHITELIST) {
      expect(file, '白名单路径应为 web-next src 相对 posix 路径').toMatch(/^[\w.\-/]+\.vue$/)
      expect(why.trim().length, `${file} 的登记理由缺失或过短`).toBeGreaterThanOrEqual(8)
    }
  })
})

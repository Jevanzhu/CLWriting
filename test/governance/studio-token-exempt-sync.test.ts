/**
 * 四轮-F402（2026-09-18 全量源码独立重评四轮修复批）+ 抄本同步纪律：
 * 全局 fetch 包装的 GET token 豁免表抄本 ↔ 服务端正本的双向同步机器门。
 *
 * 背景：test/helpers/studio-token-setup.ts 的 GET_TOKEN_EXEMPT 抄自
 * src/studio/server/index.ts 的 GET_TOKEN_EXEMPT_PATHS（X-19 显式豁免清单，唯一事实
 * 源）。抄本不能换成 import 正本——helper 是 vitest setupFiles（挂全部测试 worker），
 * 直连 server/index 会把整个 studio server 模块图拉进每个 worker，不成比例；故抄本以
 * 字面量存在，注释约定「保持同步」但此前无守卫（对比：coverage EXCLUDE 抄本有
 * coverage-threshold-globs 反向守卫）。正本改路（如 R0912-P3-⑥ 式豁免模式搬家）时
 * 抄本静默漂移——豁免路径被注入 token 属无害空转，但「豁免路径上断言 403」类用例会
 * 被注入行为误导排障（R72-20 锚注原始动因），事后零线索。
 *
 * 本测试钉住同步：正本多表/抄本缺、抄本多表/正本缺、模式 source 或 flags 漂移全红；
 * 「名不符」（任一侧改名/删导出）在本文件 import 面直接红（收集失败），不设单独用例。
 *
 * ══ 跨包契约对账门（2026-10-11 全量复审报告 §四 C1/C6·H2）══════════════════════
 * H2 指出「路由 ↔ 前端调用、SSE 事件名、手抄 interface」三处跨包契约都无机器门。
 * 本文件同属「服务端正本 ↔ 消费面同步」族，三条对账门随批并入。
 *
 * 单源落地（C1 的窄面：常量与事件名）之后，本档三门口径：
 *   常量/端口 = 断言「各端按名 import 单源」（src/shared/contract/studio.ts），
 *   SSE 事件名 = 正本读单源清单并逐名对账 DriverEvent 联合，消费面照旧逐名核对。
 *   interface 手抄面（99 个）与路由门不动——路由门仍是「正本 ↔ 消费面」对账。
 *
 * ① 路由对账（describe「路由 ↔ 前端调用对账门」）
 *   - 正本 = src/studio/server/** 全部 defineRoute('name', {method, path}) 的
 *     method+path 全集（AST 抽取；name/method/path 非字面量、绕过 defineRoute 的裸
 *     route() 注册均红）；
 *   - 消费面 = src/studio/web-next/src/** 的 apiJson / apiFetch / fetch / new EventSource
 *     首参路径表达式的静态折叠全集；
 *   - 前端请求了不存在的路由（路径打错 / 方法不匹配）→ 红（静默 404 是真实故障形态）；
 *   - 服务端有路由但前端零调用 → 不红，须逐项登记 ROUTES_UNCONSUMED_KNOWN（理由随项），
 *     新出现的未登记项 → 红；登记项已消失/已被消费 → 红（防僵尸豁免）。
 *
 *   路径模板匹配口径（保守优先：宁可让人工确认，不制造假红）：
 *   - 折叠规则：字符串/无替换模板串/`+` 拼接逐段拼接；bookUrl(name, ...segs) 折叠为
 *     /api/books/<段>/…（书名段=单段动态，字面量段原样）；encodeURIComponent/String/
 *     Number 折叠为单段动态；同文件内「单条 return 返回字符串」的本地助手（如
 *     api/style.ts 的 base()）内联展开；三元表达式取两分支各一版（备选集）；
 *   - 查询串：首个字面 '?' 起整段截断（?file=… / ?refresh=1 等不参与路径比对）；
 *   - 动态片段紧邻静态段（无 '/' 分隔，如 `${bookUrl(name,'tree')}${q}` 的 q）→ 该静态
 *     段标「可能被续写」，匹配服务端同位置段时取前缀匹配（q 可能只是查询串）；
 *   - 不可解析片段按「0..N 段任意」兜底（含空）——它可能续写路径，也可能只是查询串；
 *   - 完全无静态信息的调用点（如 api/client.ts 通用封装的 fetch(path)）不进比对，须在
 *     CLIENT_UNRESOLVED_KNOWN 逐项登记（同防僵尸）——这是本门的登记盲区。
 *   代价（盲区）：前缀匹配会放过「静态段 + 紧邻动态片段」形态下少写后缀的笔误；静态段
 *   打错（entrys ≠ entries）、方法不匹配（GET vs 仅 POST）必红。
 *
 * ② SSE 事件名对账（describe「SSE 事件名对账门」）
 *   - 正本 = 跨包契约底座 src/shared/contract/studio.ts 的 SSE_DRIVER_EVENT_TYPES 运行期
 *     清单（编译期另由 studio.conformance.ts 双向钉在 DriverEvent 联合上）；
 *   - 门内再运行期对账一次：清单 ↔ src/driver/types.ts 的 DriverEvent 联合逐名等价
 *     （任一侧多/少/重复即红——联合新增事件而清单漏更在本门与 tsc 两处都红）；
 *   - SSE 端点直写名（src/studio/server/api/stream*.ts 里 `data: ${JSON.stringify({type:'…'})}`
 *     的 type 字面量，现为 sync）必须落在「清单 ∪ {sync}」内，否则红（绕过清单的新直写名
 *     对前端不可见）；
 *   - 消费面 = useSse.ts（data.type 路由）/ stores/workbench.ts（dispatch 分支）/
 *     stores/chat-dispatch.ts（switch case）/ components/workbench/WbAdvanced.vue（事件流
 *     标签）里「对 .type 的字面量比较 / switch case / startsWith 前缀」全集——前端比较点
 *     仍写字面量（逐名身份比较，非成员判定），由本门对照单源清单逐名核对：前端多抄/打错
 *     名（服务端不发的名）→ 红；
 *   - 前端消费了服务端不发的名 → 红（FRONTEND_ONLY_KNOWN 只登记已核实的遗留死分支，
 *     逐项防僵尸：该名重新被发出或前端面已清 → 红要求删登记）；
 *   - 服务端发出但前端零消费 → 须登记 SSE_UNCONSUMED_KNOWN（当前空集——清单 + sync
 *     全量被消费）；前缀规则（startsWith('chat_')）家族须非空且逐个有显式消费分支。
 *
 * ③ 跨包常量对账（describe「跨包常量对账门」）
 *   - 数值常量的**唯一字面量处** = 跨包契约底座 src/shared/contract/studio.ts：门断言
 *     正本为数值字面量、别名声明是「引用正本名」（不得写第二处字面量）且运行期同值；
 *   - 消费端（服务端 stream-sse-writer.ts / 前端 workbench.ts / chat-dispatch.ts）须按名
 *     import 单源，且文件内不得再出现同值数字字面量（防手抄回潮）——原「两侧字面相等」
 *     口径随之退役（值不再有第二处可漂移）；
 *   - dev-api 端口镜像（Vite 代理目标 / SSE dev 基址回落）同口径：须 import 单源的
 *     DEV_API_DEFAULT_PORT，且不得再出现 127.0.0.1:<端口> 或同值裸数字字面量。
 *   登记项自校验：单源/别名/消费端/镜像任一侧声明消失 → 红。
 *
 * 盲区（本门抓不到，登记在案）：前端非 api 层的裸字符串路径拼接（非上述四类调用形态）；
 * 前端路径里完全动态的部分（只保证静态段对账）；「静态段 + 紧邻动态片段」形态下少写后缀
 * 的笔误（前缀匹配放宽所致）；前端事件名比较点仍为字面量（跨端漂移靠本门运行期对账，
 * 非编译期）；响应体字段/interface 手抄面（C1 未落地）。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { GET_TOKEN_EXEMPT_PATHS } from '../../src/studio/server/index.js'
import { GET_TOKEN_EXEMPT } from '../helpers/studio-token-setup.js'
import {
  DEV_API_DEFAULT_PORT,
  MAX_TEXT_OUT,
  MAX_TEXT_POINTS,
  SSE_BACKPRESSURE_LIMIT,
  SSE_DRIVER_EVENT_TYPES,
} from '../../src/shared/contract/studio.js'

/** 正则 → `source::flags` 签名（集合比对与漂移点名共用；flags 漂移同红） */
const sig = (re: RegExp): string => `${re.source}::${re.flags}`

describe('studio fetch 包装 GET 豁免表抄本同步守卫（四轮-F402）', () => {
  it('抄本 GET_TOKEN_EXEMPT 与正本 GET_TOKEN_EXEMPT_PATHS 双向集合相等（多/少/漂移全红）', () => {
    // 非空地板：两侧同时清空会让「集合相等」退化为恒真（同步门静默失明）
    expect(GET_TOKEN_EXEMPT_PATHS.length, '正本豁免表为空——X-19 显式路径表被误删').toBeGreaterThan(0)
    expect(GET_TOKEN_EXEMPT.length, '抄本豁免表为空——studio-token-setup 抄本被误删').toBeGreaterThan(0)

    const canonical = new Set(GET_TOKEN_EXEMPT_PATHS.map(sig))
    const copy = new Set(GET_TOKEN_EXEMPT.map(sig))
    const drift: string[] = []
    for (const s of canonical) {
      if (!copy.has(s)) drift.push(`正本有而抄本缺——studio-token-setup.ts 抄本须随动补入：/${s}`)
    }
    for (const s of copy) {
      if (!canonical.has(s)) drift.push(`抄本有而正本无——抄本删项或 index.ts 正本补表：/${s}`)
    }
    expect(drift, '\n' + drift.join('\n')).toEqual([])
  })
})

// ══ 跨包契约对账门：扫描基础设施 ══════════════════════════════════════════════
// 口径与保守性论证见文件头注①/②；白名单与僵尸校验见各 describe 头注。

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SERVER_DIR = join(ROOT, 'src', 'studio', 'server')
const WEB_SRC_DIR = join(ROOT, 'src', 'studio', 'web-next', 'src')

/** 递归收集文件（跳过 ._ AppleDouble 与 node_modules；同 known-actions-audit.test.ts 口径）。 */
function listFiles(dir: string, pred: (name: string) => boolean): string[] {
  let out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith('._') || name === 'node_modules') continue
    const fp = join(dir, name)
    if (statSync(fp).isDirectory()) out = out.concat(listFiles(fp, pred))
    else if (pred(name)) out.push(fp)
  }
  return out
}

/** 相对仓库根路径（报错点名用；win 分隔符归一 posix）。 */
function relPath(fp: string): string {
  return relative(ROOT, fp).split('\\').join('/')
}

interface ScriptBlock {
  code: string
  lineOffset: number
}

/** .vue SFC：抽 <script> 块（带行偏移）——整文件裸解析 SFC 会产出伪 AST。 */
function vueScriptBlocks(src: string): ScriptBlock[] {
  const out: ScriptBlock[] = []
  const re = /<script[^>]*>([\s\S]*?)<\/script>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const before = src.slice(0, m.index)
    out.push({ code: m[1] ?? '', lineOffset: (before.match(/\n/g) ?? []).length })
  }
  return out
}

/** 前序遍历（含根）。 */
function forEachNode(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node)
  node.forEachChild((child) => forEachNode(child, fn))
}

// ── ① 路由正本抽取 ──────────────────────────────────────────────────────────

interface ServerRoute {
  name: string
  method: string
  path: string
  site: string
}

/** 服务端正本：全部 defineRoute('name', { method, path }) 的 method+path 全集。 */
function collectServerRoutes(files: string[]): { routes: ServerRoute[]; malformed: string[] } {
  const routes: ServerRoute[] = []
  const malformed: string[] = []
  for (const fp of files) {
    const sf = ts.createSourceFile(fp, readFileSync(fp, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    forEachNode(sf, (node) => {
      if (!ts.isCallExpression(node)) return
      if (!ts.isIdentifier(node.expression) || node.expression.text !== 'defineRoute') return
      const site = `${relPath(fp)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`
      const nameArg = node.arguments[0]
      const schemaArg = node.arguments[1]
      let method: string | undefined
      let path: string | undefined
      if (schemaArg && ts.isObjectLiteralExpression(schemaArg)) {
        for (const prop of schemaArg.properties) {
          if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
          if (prop.name.text === 'method' && ts.isStringLiteral(prop.initializer)) method = prop.initializer.text
          if (prop.name.text === 'path' && ts.isStringLiteral(prop.initializer)) path = prop.initializer.text
        }
      }
      if (!nameArg || !ts.isStringLiteral(nameArg) || !method || !path) {
        malformed.push(`${site}：defineRoute 形态不可静态解析（name/method/path 须为字符串字面量）`)
        return
      }
      routes.push({ name: nameArg.text, method, path, site })
    })
  }
  return { routes, malformed }
}

/**
 * 裸 route(method, path, handler) 注册点——defineRoute 是路由单点声明口
 * （schema.ts 头注「禁止随手加裸 route」），绕过它的路由不进注册表/无 parse 声明，
 * 本对账门也拿不到契约（形态漂移即红）。schema.ts 自身（分发器接线）与 router.ts
 * （分发器实现）为定义面，排除。
 */
function collectBareRouteCalls(files: string[]): string[] {
  const hits: string[] = []
  for (const fp of files) {
    if (fp === join(SERVER_DIR, 'router.ts')) continue
    if (fp === join(SERVER_DIR, 'api', 'schema.ts')) continue
    const sf = ts.createSourceFile(fp, readFileSync(fp, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    forEachNode(sf, (node) => {
      if (!ts.isCallExpression(node)) return
      if (!ts.isIdentifier(node.expression) || node.expression.text !== 'route') return
      hits.push(`${relPath(fp)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`)
    })
  }
  return hits
}

// ── ① 前端调用面抽取（迷你静态求值器）────────────────────────────────────────

/** 段占位：单段动态值（encodeURIComponent(x)/bookUrl 书名段/已解析的单段表达式）。 */
const SEG_PARAM = '\u0001'
/** 段占位：不可解析片段（可能含 '/' 或 '?'，匹配时按 0..N 段兜底）。 */
const SEG_UNKNOWN = '\u0002'

type StringFnTable = Map<string, { params: string[]; body: ts.Expression }>

interface EvalCtx {
  fns: StringFnTable
  bindings: Map<string, string[]>
}

interface ClientCall {
  site: string
  /** null = 方法不可静态确定（按任意方法算，保守不红）。 */
  method: string | null
  patterns: string[]
  raw: string
}

interface UnresolvedCall {
  /** 登记键：`<相对路径>::<被调函数名>`（行号会漂，不作键）。 */
  key: string
  detail: string
}

/** 同文件内「单条 return 返回表达式」的本地函数表（api/style.ts 的 base() 等助手内联用）。 */
function collectLocalStringFns(sf: ts.SourceFile): StringFnTable {
  const fns: StringFnTable = new Map()
  const singleReturnExpr = (body: ts.Block): ts.Expression | null => {
    const st = body.statements[0]
    if (body.statements.length !== 1 || !st || !ts.isReturnStatement(st) || !st.expression) return null
    return st.expression
  }
  const paramName = (p: ts.ParameterDeclaration): string => (ts.isIdentifier(p.name) ? p.name.text : '')
  forEachNode(sf, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const ret = singleReturnExpr(node.body)
      if (ret) fns.set(node.name.text, { params: node.parameters.map(paramName), body: ret })
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer
      if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && ts.isBlock(init.body)) {
        const ret = singleReturnExpr(init.body)
        if (ret) fns.set(node.name.text, { params: init.parameters.map(paramName), body: ret })
      }
    }
  })
  return fns
}

/** 备选集笛卡尔拼接（上限 8：三元链膨胀时退化为不可解析，交 unresolved 登记）。 */
function concatAlts(left: string[], right: string[]): string[] | null {
  const out: string[] = []
  for (const a of left) for (const b of right) out.push(a + b)
  return out.length > 8 ? null : out
}

/** 路径表达式静态折叠：返回备选字符串集（含段占位）；null = 不可解析。 */
function evalStringExpr(node: ts.Expression | undefined, ctx: EvalCtx, depth = 0): string[] | null {
  if (!node || depth > 6) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text]
  if (ts.isParenthesizedExpression(node)) return evalStringExpr(node.expression, ctx, depth + 1)
  if (ts.isTemplateExpression(node)) {
    let acc: string[] = [node.head.text]
    for (const span of node.templateSpans) {
      const rhs = evalStringExpr(span.expression, ctx, depth + 1)
      if (!rhs) return null
      const joined = concatAlts(acc, rhs)
      if (!joined) return null
      acc = joined.map((s) => s + span.literal.text)
    }
    return acc
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evalStringExpr(node.left, ctx, depth + 1)
    const right = evalStringExpr(node.right, ctx, depth + 1)
    if (!left || !right) return null
    return concatAlts(left, right)
  }
  if (ts.isConditionalExpression(node)) {
    const whenTrue = evalStringExpr(node.whenTrue, ctx, depth + 1)
    const whenFalse = evalStringExpr(node.whenFalse, ctx, depth + 1)
    if (!whenTrue || !whenFalse) return null
    return [...whenTrue, ...whenFalse].slice(0, 8)
  }
  if (ts.isIdentifier(node)) return ctx.bindings.get(node.text) ?? [SEG_UNKNOWN]
  if (ts.isCallExpression(node)) return evalStringCall(node, ctx, depth)
  return [SEG_UNKNOWN]
}

/** 调用表达式折叠：bookUrl 单源 / 编码函数 / 本地字符串助手内联；其余按不可解析片段。 */
function evalStringCall(node: ts.CallExpression, ctx: EvalCtx, depth: number): string[] | null {
  const callee = node.expression
  const calleeName = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)
      ? callee.name.text
      : null
  // api/url.ts 的 bookUrl(name, ...segs)：书名段与动态段 = 单段占位，字面量段原样
  if (calleeName === 'bookUrl') {
    let out = `/api/books/${SEG_PARAM}`
    for (let i = 1; i < node.arguments.length; i++) {
      const arg = node.arguments[i]
      out += '/' + (arg && ts.isStringLiteral(arg) ? arg.text : SEG_PARAM)
    }
    return [out]
  }
  if (calleeName === 'encodeURIComponent' || calleeName === 'String' || calleeName === 'Number') return [SEG_PARAM]
  const local = calleeName ? ctx.fns.get(calleeName) : undefined
  if (local && local.params.length === node.arguments.length) {
    const inner: EvalCtx = { fns: ctx.fns, bindings: new Map(ctx.bindings) }
    for (let i = 0; i < local.params.length; i++) {
      const bound = evalStringExpr(node.arguments[i], ctx, depth + 1)
      if (!bound) return null
      inner.bindings.set(local.params[i] ?? '', bound)
    }
    return evalStringExpr(local.body, inner, depth + 1)
  }
  return [SEG_UNKNOWN]
}

/**
 * 请求方法静态判定：apiJson/apiFetch/fetch 的第二参 init——
 * 缺省/undefined/对象字面量无 method 字段 = GET（client.ts 的默认），
 * method 非字面量或 init 非字面量对象 = null（按任意方法算，保守不红）。
 */
function evalMethodExpr(node: ts.Expression | undefined): string | null {
  if (!node || (ts.isIdentifier(node) && node.text === 'undefined')) return 'GET'
  if (!ts.isObjectLiteralExpression(node)) return null
  for (const prop of node.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'method') {
      return ts.isStringLiteral(prop.initializer) ? prop.initializer.text : null
    }
  }
  return 'GET'
}

/** 前端调用面：apiJson / apiFetch / fetch / new EventSource 的首参路径表达式全集。 */
function collectClientCalls(files: string[]): { calls: ClientCall[]; unresolved: UnresolvedCall[] } {
  const calls: ClientCall[] = []
  const unresolved: UnresolvedCall[] = []
  for (const fp of files) {
    const rawSrc = readFileSync(fp, 'utf8')
    const blocks = fp.endsWith('.vue') ? vueScriptBlocks(rawSrc) : [{ code: rawSrc, lineOffset: 0 }]
    for (const block of blocks) {
      const sf = ts.createSourceFile(fp, block.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      const ctx: EvalCtx = { fns: collectLocalStringFns(sf), bindings: new Map() }
      forEachNode(sf, (node) => {
        const isCall = ts.isCallExpression(node)
        const isNewEs =
          ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'EventSource'
        if (!isCall && !isNewEs) return
        const callee = node.expression
        const calleeName = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)
            ? callee.name.text
            : null
        let method: string | null
        if (calleeName === 'apiJson' || calleeName === 'apiFetch' || calleeName === 'fetch') {
          method = evalMethodExpr(node.arguments?.[1])
        } else if (calleeName === 'EventSource' && isNewEs) {
          method = 'GET'
        } else {
          return
        }
        const site = `${relPath(fp)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 + block.lineOffset}`
        const arg = node.arguments?.[0]
        const raw = `${calleeName}(${arg ? arg.getText(sf) : '缺首参'})`
        const patterns = evalStringExpr(arg, ctx)
        // 全 unknown 备选（通用封装透传入参）无静态信息——不进比对，走 unresolved 登记
        if (!patterns || !patterns.some((p) => hasStaticInfo(tokenizeClientPath(p)))) {
          unresolved.push({ key: `${relPath(fp)}::${calleeName}`, detail: `${site} ${raw}` })
          return
        }
        calls.push({ site, method, patterns, raw })
      })
    }
  }
  return { calls, unresolved }
}

// ── ① 路径模板匹配（段级，保守）─────────────────────────────────────────────

type PathToken = { kind: 'static'; text: string; flexible: boolean } | { kind: 'param' } | { kind: 'unknown' }

/**
 * 客户端路径表达式 → 段序列（口径见文件头注①）：
 * 首个字面 '?' 截断；段内静态文本后紧跟动态片段（无 '/' 分隔）→ 该静态段标 flexible。
 */
function tokenizeClientPath(pattern: string): PathToken[] {
  const queryAt = pattern.indexOf('?')
  const body = queryAt >= 0 ? pattern.slice(0, queryAt) : pattern
  const tokens: PathToken[] = []
  const chunks = body.split('/')
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci] ?? ''
    if (ci === 0 && chunk === '') continue // 前导 '/'
    let lit = ''
    const flush = (flexible: boolean): void => {
      if (lit !== '') tokens.push({ kind: 'static', text: lit, flexible })
      lit = ''
    }
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]
      if (c === SEG_PARAM) {
        flush(true)
        tokens.push({ kind: 'param' })
      } else if (c === SEG_UNKNOWN) {
        flush(true)
        tokens.push({ kind: 'unknown' })
      } else {
        lit += c
      }
    }
    flush(false)
  }
  return tokens
}

/** 全 unknown 的表达式（通用封装透传入参）无静态信息，不进比对（走 unresolved 登记）。 */
function hasStaticInfo(tokens: PathToken[]): boolean {
  return tokens.some((t) => t.kind !== 'unknown')
}

/** 段级匹配：param 吃一段；unknown 吃 0..N 段（回溯）；static 精确或（flexible 时）前缀。 */
function matchTokens(tokens: PathToken[], segments: string[]): boolean {
  const rec = (i: number, j: number): boolean => {
    if (i === tokens.length) return j === segments.length
    const token = tokens[i]
    if (!token) return false
    if (token.kind === 'unknown') {
      for (let k = 0; k <= segments.length - j; k++) if (rec(i + 1, j + k)) return true
      return false
    }
    if (j >= segments.length) return false
    const seg = segments[j] ?? ''
    if (token.kind === 'param') return rec(i + 1, j + 1)
    const ok = seg.startsWith(':') || (token.flexible ? seg.startsWith(token.text) : seg === token.text)
    return ok && rec(i + 1, j + 1)
  }
  return rec(0, 0)
}

function routeSegments(path: string): string[] {
  return (path.startsWith('/') ? path.slice(1) : path).split('/')
}

/** 调用点是否命中该路由（方法：调用点 null = 任意；路径：任一带静态信息的备选命中即算）。 */
function callMatchesRoute(call: ClientCall, route: ServerRoute): boolean {
  if (call.method !== null && call.method !== route.method) return false
  const segments = routeSegments(route.path)
  return call.patterns.some((p) => {
    const tokens = tokenizeClientPath(p)
    return hasStaticInfo(tokens) && matchTokens(tokens, segments)
  })
}

// ── ① 扫描与白名单 ──────────────────────────────────────────────────────────

const serverRouteFiles = listFiles(SERVER_DIR, (n) => n.endsWith('.ts') && !n.endsWith('.d.ts'))
const { routes: serverRoutes, malformed: malformedRoutes } = collectServerRoutes(serverRouteFiles)
const bareRouteCalls = collectBareRouteCalls(serverRouteFiles)
const webFiles = listFiles(WEB_SRC_DIR, (n) => (n.endsWith('.ts') || n.endsWith('.vue')) && !n.endsWith('.d.ts'))
const { calls: clientCalls, unresolved: unresolvedClientCalls } = collectClientCalls(webFiles)

/** 前端请求了服务端不存在的路由（路径打错 / 方法不匹配）——红向清单。 */
const frontendUnknownRoutes = clientCalls
  .filter((c) => !serverRoutes.some((r) => callMatchesRoute(c, r)))
  .map((c) => `${c.site} ${c.method ?? '任意方法'} ${c.raw} → 静态折叠：${c.patterns.join(' | ')}`)

/** 服务端有路由但前端零调用——须逐项登记。 */
const routesWithoutFrontendCall = serverRoutes.filter((r) => !clientCalls.some((c) => callMatchesRoute(c, r)))

/**
 * 已知零前端调用的服务端路由（键 = `<METHOD> <path>`；逐项理由）。
 * 新出现的未登记项 → 红（逼显式确认「有意能力面」还是「前端漏接」）；
 * 登记项已消失/已被消费 → 红（防僵尸豁免）。
 */
const ROUTES_UNCONSUMED_KNOWN: ReadonlyMap<string, string> = new Map([
  [
    'GET /api/books/:name',
    '单书身份端点（book.yaml 身份回显 name/kind/title/genre/host）：web-next 只消费书架列表与 /api/books/:name/config；身份端点现由测试/外部消费（test/studio/server/books-rename-case.test.ts 等），保留为能力面',
  ],
  [
    'POST /api/books/:name/documents/:docId/analyze',
    '重新分析端点（kind → submit_<kind>）：前端已改用细分端点 autotag / infer-meta（api/analysis.ts），analyze 保留给测试与工具链（test/studio/server/analyze-api.test.ts 等）',
  ],
])

/**
 * 不可静态解析的前端调用点（键 = `<相对路径>::<被调函数名>`）——完全无静态路径信息的
 * 调用形态（通用封装透传入参），本门不比对（登记盲区）；新出现即红，登记项消失即红。
 */
const CLIENT_UNRESOLVED_KNOWN: ReadonlyMap<string, string> = new Map([
  [
    'src/studio/web-next/src/api/client.ts::fetch',
    'apiFetchCore 的通用 fetch 封装：路径为函数入参，真实路径由各调用方经 apiJson/apiFetch 传入（已被本门覆盖），此处是管道自身',
  ],
])

describe('路由 ↔ 前端调用对账门（报告 H2/C1）', () => {
  it('服务端正本全量可静态解析、只走 defineRoute（形态漂移/裸 route 注册即红）', () => {
    expect(
      malformedRoutes,
      'defineRoute 声明形态漂移（name/method/path 须字符串字面量，本门才能对账）：\n' + malformedRoutes.join('\n'),
    ).toEqual([])
    expect(
      bareRouteCalls,
      '绕过 defineRoute 的裸 route() 注册（schema.ts 头注：新路由必须 defineRoute，裸注册不进注册表/无 parse 声明，本门也拿不到契约）：\n' +
        bareRouteCalls.join('\n'),
    ).toEqual([])
    expect(serverRoutes.length, '服务端路由扫描面过小（defineRoute 抽取疑似失效）——防空转绿灯').toBeGreaterThan(50)
  })

  it('前端请求路径全部命中服务端路由（打错路径 / 方法不匹配即红）', () => {
    expect(clientCalls.length, '前端调用面扫描过小（apiJson/apiFetch/fetch/EventSource 抽取疑似失效）').toBeGreaterThan(
      50,
    )
    expect(
      frontendUnknownRoutes,
      '前端请求了服务端不存在的路由（或方法不匹配）——打错路径的静默 404 是真实故障形态，修前端或补服务端路由：\n' +
        frontendUnknownRoutes.join('\n'),
    ).toEqual([])
  })

  it('不可静态解析的前端调用点须逐项登记（新出现未登记 → 红；登记项消失 → 红）', () => {
    const known = new Set(CLIENT_UNRESOLVED_KNOWN.keys())
    const unregistered = unresolvedClientCalls.filter((u) => !known.has(u.key))
    expect(
      unregistered.map((u) => u.detail),
      '出现不可静态解析的调用点（无静态路径信息）——本门抓不到它是否打错路径：\n' +
        '修法：把路径改为静态可折叠形态，或在此逐项登记理由（CLIENT_UNRESOLVED_KNOWN）：\n' +
        unregistered.map((u) => `${u.detail}（登记键 ${u.key}）`).join('\n'),
    ).toEqual([])
    const stale = [...known].filter((k) => !unresolvedClientCalls.some((u) => u.key === k))
    expect(
      stale,
      'CLIENT_UNRESOLVED_KNOWN 登记项已不存在（调用点已静态化/已删）——请删除登记：\n' + stale.join('\n'),
    ).toEqual([])
  })

  it('零前端调用的服务端路由须逐项登记理由（未登记即红）', () => {
    const unregistered = routesWithoutFrontendCall.filter((r) => !ROUTES_UNCONSUMED_KNOWN.has(`${r.method} ${r.path}`))
    expect(
      unregistered.map((r) => `${r.method} ${r.path}（${r.name}，${r.site}）`),
      '服务端有路由但前端零调用——确认是「有意能力面/遗留」还是「前端漏接」，' +
        '属前者则登记理由（ROUTES_UNCONSUMED_KNOWN），属后者则补前端调用：\n' +
        unregistered.map((r) => `${r.method} ${r.path}（${r.name}，${r.site}）`).join('\n'),
    ).toEqual([])
  })

  it('零前端调用路由白名单防僵尸（登记项须真实存在且仍零调用）', () => {
    const allKeys = new Set(serverRoutes.map((r) => `${r.method} ${r.path}`))
    const unconsumedKeys = new Set(routesWithoutFrontendCall.map((r) => `${r.method} ${r.path}`))
    const problems: string[] = []
    for (const [key, reason] of ROUTES_UNCONSUMED_KNOWN) {
      if (!allKeys.has(key)) {
        problems.push(`登记项已不存在于服务端路由全集（路由已删/改名/改方法）——请删除登记：${key}（理由：${reason}）`)
      } else if (!unconsumedKeys.has(key)) {
        problems.push(`登记项已被前端消费（僵尸豁免）——请删除登记：${key}（理由：${reason}）`)
      }
    }
    expect(problems, 'ROUTES_UNCONSUMED_KNOWN 僵尸校验失败：\n' + problems.join('\n')).toEqual([])
  })
})

// ── ② SSE 事件名正本与消费面抽取 ─────────────────────────────────────────────

/** 连接快照名（stream.ts 建流即直写、不在 DriverEvent 联合内）——前端 useSse/两 store 消费。 */
const SSE_CONNECTION_SNAPSHOT = 'sync'

/**
 * 单源清单（正本）= src/shared/contract/studio.ts 的运行期清单；它与 DriverEvent 联合的
 * 逐名等价另有编译期钉子（src/shared/contract/studio.conformance.ts）——本门在运行期再对账
 * 一次，红时能直接点名漂移的事件名。
 */
const SSE_EVENT_TYPE_LIST: readonly string[] = SSE_DRIVER_EVENT_TYPES
const SSE_EVENT_TYPE_SET: ReadonlySet<string> = new Set(SSE_EVENT_TYPE_LIST)

interface ServerSseNames {
  unionFound: boolean
  union: Set<string>
  direct: Set<string>
}

/** DriverEvent 联合 type 字面量（与单源清单对账用）+ SSE 端点直写名
 *  （`data: ${JSON.stringify({type:'…'})}`）。 */
function collectServerSseNames(): ServerSseNames {
  const typesPath = join(ROOT, 'src', 'driver', 'types.ts')
  const sf = ts.createSourceFile(
    typesPath,
    readFileSync(typesPath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const union = new Set<string>()
  let unionFound = false
  forEachNode(sf, (node) => {
    if (!ts.isTypeAliasDeclaration(node) || node.name.text !== 'DriverEvent') return
    unionFound = true
    forEachNode(node.type, (n) => {
      if (!ts.isPropertySignature(n) || !n.name || !ts.isIdentifier(n.name) || n.name.text !== 'type') return
      const t = n.type
      if (t && ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)) union.add(t.literal.text)
    })
  })
  const direct = new Set<string>()
  const streamFiles = listFiles(join(SERVER_DIR, 'api'), (n) => n.startsWith('stream') && n.endsWith('.ts'))
  for (const fp of streamFiles) {
    const streamSf = ts.createSourceFile(fp, readFileSync(fp, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    forEachNode(streamSf, (node) => {
      // 只认 SSE 唯一写出口形态：`data: ${JSON.stringify({ type: '…' })}` 模板
      if (!ts.isTemplateExpression(node) || !node.head.text.includes('data:')) return
      for (const span of node.templateSpans) {
        const expr = span.expression
        if (!ts.isCallExpression(expr)) continue
        const callee = expr.expression
        if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'stringify') continue
        const arg = expr.arguments[0]
        if (!arg || !ts.isObjectLiteralExpression(arg)) continue
        for (const prop of arg.properties) {
          if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'type') {
            if (ts.isStringLiteral(prop.initializer)) direct.add(prop.initializer.text)
          }
        }
      }
    })
  }
  return { unionFound, union, direct }
}

/**
 * 日志白名单（workbench.ts 的 `WORKBENCH_LOG_TYPES = new Set([...])`）——决定事件是否进
 * 事件流日志，同属前端消费面（新增死名/漏接新事件都在此显形）。声明改名/删表时抽取为空，
 * 由「服务端发出但前端零消费」断言兜底（fail-closed，不静默）。
 */
function collectWorkbenchLogTypes(sf: ts.SourceFile): string[] {
  const names: string[] = []
  forEachNode(sf, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== 'WORKBENCH_LOG_TYPES')
      return
    const init = node.initializer
    if (!init || !ts.isNewExpression(init) || !ts.isIdentifier(init.expression) || init.expression.text !== 'Set')
      return
    const arg = init.arguments?.[0]
    if (!arg || !ts.isArrayLiteralExpression(arg)) return
    for (const el of arg.elements) if (ts.isStringLiteral(el)) names.push(el.text)
  })
  return names
}

interface ClientSseNames {
  names: Set<string>
  prefixes: Set<string>
}

/**
 * 消费面：对 `.type` 的字面量比较（=== / ==）、switch(….type) 的 case、
 * startsWith('<前缀>') 前缀规则、workbench 日志白名单——四文件
 * （useSse/workbench/chat-dispatch/WbAdvanced）全集。
 */
function collectClientSseNames(files: string[]): ClientSseNames {
  const names = new Set<string>()
  const prefixes = new Set<string>()
  for (const fp of files) {
    // 缺文件不在此抛 ENOENT（否则整档收集失败、失明原因被 ENOENT 掩盖）——由「消费面
    // 四文件在位」用例点名红；此处跳过只损失该文件的抽取面
    if (!statSync(fp, { throwIfNoEntry: false })?.isFile()) continue
    const rawSrc = readFileSync(fp, 'utf8')
    const blocks = fp.endsWith('.vue') ? vueScriptBlocks(rawSrc) : [{ code: rawSrc, lineOffset: 0 }]
    for (const block of blocks) {
      const sf = ts.createSourceFile(fp, block.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      // 事件类型变量：`const t = …data.type…` 形态（useSse 的路由变量）
      const typeVars = new Set<string>()
      forEachNode(sf, (node) => {
        if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return
        let init: ts.Expression = node.initializer
        if (ts.isConditionalExpression(init)) init = init.whenTrue
        if (ts.isPropertyAccessExpression(init) && init.name.text === 'type') typeVars.add(node.name.text)
      })
      const isTypeRef = (e: ts.Expression): boolean =>
        (ts.isPropertyAccessExpression(e) && e.name.text === 'type') || (ts.isIdentifier(e) && typeVars.has(e.text))
      for (const name of collectWorkbenchLogTypes(sf)) names.add(name)
      forEachNode(sf, (node) => {
        if (
          ts.isBinaryExpression(node) &&
          (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
            node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)
        ) {
          const pairs: Array<[ts.Expression, ts.Expression]> = [
            [node.left, node.right],
            [node.right, node.left],
          ]
          for (const [maybeType, maybeLit] of pairs) {
            if (isTypeRef(maybeType) && ts.isStringLiteral(maybeLit)) names.add(maybeLit.text)
          }
        }
        if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression)) {
          const sw = node.parent.parent
          if (ts.isSwitchStatement(sw) && isTypeRef(sw.expression)) names.add(node.expression.text)
        }
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'startsWith'
        ) {
          const recv = node.expression.expression
          const arg = node.arguments[0]
          if (isTypeRef(recv) && arg && ts.isStringLiteral(arg)) prefixes.add(arg.text)
        }
      })
    }
  }
  return { names, prefixes }
}

/** SSE 消费面四文件（改名/搬迁后须同步本门；缺文件即红——防静默失明）。 */
const SSE_CLIENT_FILES = [
  join(WEB_SRC_DIR, 'composables', 'useSse.ts'),
  join(WEB_SRC_DIR, 'stores', 'workbench.ts'),
  join(WEB_SRC_DIR, 'stores', 'chat-dispatch.ts'),
  join(WEB_SRC_DIR, 'components', 'workbench', 'WbAdvanced.vue'),
]

const serverSse = collectServerSseNames()
const clientSse = collectClientSseNames(SSE_CLIENT_FILES)
/** 服务端会发出的名全集：单源清单（正本） ∪ 端点直写名（sync）。 */
const serverSseAll = new Set<string>([...SSE_EVENT_TYPE_SET, ...serverSse.direct])

/**
 * 前端消费但服务端已不再发出的事件名（前端多）——逐项理由 + 防僵尸。
 * 默认红：前端对不存在的事件名写分支 = 死分支（静默不触发），是「事件名打错」的形态。
 */
const FRONTEND_ONLY_KNOWN: ReadonlyMap<string, string> = new Map([
  [
    'tool_use',
    'DriverEvent 联合已无此名（服务端不再发）；前端两处仍消费：WbAdvanced.vue 事件流标签分支 + workbench.ts WORKBENCH_LOG_TYPES 白名单。经核对为**有意保留的显示面兜底**（workbench-log-whitelist.test.ts 明确断言该名照常入日志、事件流渲染分支依赖它），非待清遗留——故登记保留而非删分支。若将来两侧一并清理，本登记须同步删除（僵尸校验会顶红）',
  ],
])

/** 服务端发出但前端零消费的事件名——当前为空集（联合 + sync 全量被消费）。新增未消费事件在此登记理由。 */
const SSE_UNCONSUMED_KNOWN: ReadonlyMap<string, string> = new Map<string, string>()

describe('SSE 事件名对账门（报告 H2/C1）', () => {
  it('消费面四文件在位（改名/搬迁后须同步本门，防静默失明）', () => {
    const missing = SSE_CLIENT_FILES.filter((fp) => !statSync(fp, { throwIfNoEntry: false })?.isFile())
    expect(
      missing.map((fp) => relPath(fp)),
      'SSE 消费面扫描文件缺失——前端文件改名/搬迁后本门会静默失明，请同步 SSE_CLIENT_FILES：\n' +
        missing.map((fp) => relPath(fp)).join('\n'),
    ).toEqual([])
  })

  it('单源清单与 DriverEvent 联合逐名等价（任一侧多/少/重复即红）', () => {
    expect(serverSse.unionFound, 'src/driver/types.ts 的 DriverEvent 联合未找到（改名/删除即红）').toBe(true)
    expect(serverSse.union.size, 'DriverEvent 联合名扫描面过小（抽取疑似失效）——防空转绿灯').toBeGreaterThan(20)
    expect(
      SSE_EVENT_TYPE_LIST.length,
      '单源清单为空/过小（src/shared/contract/studio.ts 的 SSE_DRIVER_EVENT_TYPES 被清空或抽取失效）',
    ).toBeGreaterThan(20)
    expect(SSE_EVENT_TYPE_SET.size, '单源清单内有重复事件名（集合语义下重复名不会进漂移比对，会静默掩盖漏更）').toBe(
      SSE_EVENT_TYPE_LIST.length,
    )
    const drift: string[] = []
    for (const name of serverSse.union) {
      if (!SSE_EVENT_TYPE_SET.has(name)) {
        drift.push(
          `联合有而单源清单缺：${name}——补进 src/shared/contract/studio.ts 的 SSE_DRIVER_EVENT_TYPES（前端消费面与治理门都以清单为准）`,
        )
      }
    }
    for (const name of SSE_EVENT_TYPE_LIST) {
      if (!serverSse.union.has(name)) {
        drift.push(
          `单源清单有而联合无：${name}——事件已删/改名，从 SSE_DRIVER_EVENT_TYPES 删名（编译期钉子 studio.conformance.ts 同报错）`,
        )
      }
    }
    expect(drift, 'SSE 事件名单源清单与 DriverEvent 联合漂移：\n' + drift.join('\n')).toEqual([])
  })

  it('服务端直写名不得绕过单源清单（stream*.ts 直写须落在清单 ∪ {sync} 内）', () => {
    const bypass = [...serverSse.direct].filter((n) => !SSE_EVENT_TYPE_SET.has(n) && n !== SSE_CONNECTION_SNAPSHOT)
    expect(
      bypass,
      'SSE 端点直写了不在 DriverEvent 联合（= 单源清单）内的事件名（绕过联合的事件对前端/契约不可见）——' +
        '补进 src/driver/types.ts 联合与 src/shared/contract/studio.ts 清单，或删除直写：\n' +
        bypass.join('\n'),
    ).toEqual([])
    expect(
      serverSse.direct.has(SSE_CONNECTION_SNAPSHOT),
      "stream.ts 建流快照 `type: 'sync'` 直写点消失（前端 running 校正依赖它）——若确已删改，同步本门与前端消费面",
    ).toBe(true)
  })

  it('前端消费的每个事件名服务端都会发出（前端多 → 红）', () => {
    expect(clientSse.names.size, '前端事件名消费面扫描过小（抽取疑似失效）').toBeGreaterThan(20)
    const frontendOnly = [...clientSse.names].filter((n) => !serverSseAll.has(n) && !FRONTEND_ONLY_KNOWN.has(n))
    expect(
      frontendOnly,
      '前端消费了服务端不发出的事件名（分支永不触发；多为改名/打错字）——改前端名或补服务端事件，' +
        '确属遗留显示面才登记 FRONTEND_ONLY_KNOWN：\n' +
        frontendOnly.join('\n'),
    ).toEqual([])
  })

  it('服务端发出但前端零消费的事件名须逐项登记（未登记 → 红）', () => {
    const prefixList = [...clientSse.prefixes]
    const unconsumed = [...serverSseAll].filter(
      (n) => !clientSse.names.has(n) && !prefixList.some((p) => n.startsWith(p)),
    )
    const unregistered = unconsumed.filter((n) => !SSE_UNCONSUMED_KNOWN.has(n))
    expect(
      unregistered,
      '服务端会发出但前端零消费的事件名（新事件漏接前端分发）——补前端消费分支，' +
        '或登记「有意不消费」理由（SSE_UNCONSUMED_KNOWN）：\n' +
        unregistered.join('\n'),
    ).toEqual([])
  })

  it('startsWith 前缀规则家族非空且全量被消费（防「新 chat_* 事件无处理」）', () => {
    const prefixList = [...clientSse.prefixes]
    const problems: string[] = []
    for (const p of prefixList) {
      const family = [...serverSseAll].filter((n) => n.startsWith(p))
      if (family.length === 0) {
        problems.push(`前缀规则 '${p}' 未命中任何服务端事件名（事件已删/改名或规则失效）——删规则或改前缀`)
      }
      for (const n of family) {
        if (!clientSse.names.has(n)) problems.push(`前缀 '${p}' 家族的服务端事件 ${n} 无显式消费分支（分发未处理）`)
      }
    }
    expect(problems, 'startsWith 前缀规则校验失败：\n' + problems.join('\n')).toEqual([])
  })

  it('两侧白名单防僵尸（FRONTEND_ONLY_KNOWN / SSE_UNCONSUMED_KNOWN 登记项须仍然成立）', () => {
    const prefixList = [...clientSse.prefixes]
    const problems: string[] = []
    for (const [name, reason] of FRONTEND_ONLY_KNOWN) {
      if (!clientSse.names.has(name))
        problems.push(`登记项前端已不再消费（登记过时）——请删除：${name}（理由：${reason}）`)
      if (serverSseAll.has(name)) {
        problems.push(`登记项服务端已重新发出（不再是前端独有）——请删除登记并接消费分支：${name}（理由：${reason}）`)
      }
    }
    for (const [name, reason] of SSE_UNCONSUMED_KNOWN) {
      if (!serverSseAll.has(name)) {
        problems.push(`登记项服务端已不再发出（登记过时）——请删除：${name}（理由：${reason}）`)
      } else if (clientSse.names.has(name) || prefixList.some((p) => name.startsWith(p))) {
        problems.push(`登记项前端已消费（僵尸豁免）——请删除登记：${name}（理由：${reason}）`)
      }
    }
    expect(problems, 'SSE 事件名白名单僵尸校验失败：\n' + problems.join('\n')).toEqual([])
  })
})

// ── ③ 跨包常量对账（同一语义两端 → 单源 + 各端引用）──────────────────────────
// 报告 §四 C1 点名「跨包常量（MAX_TEXT_OUT ↔ SSE_BACKPRESSURE_LIMIT 等）全靠人抄，且无门」。
// 单源落地后本门口径（原「两侧字面相等」退役，值不再有第二处可漂移）：
// - 数值常量的唯一字面量处 = 跨包契约底座 src/shared/contract/studio.ts（web-next 跨包只许
//   import src/shared/**，故单源必须落在这里）：正本为数值字面量，同值别名写「引用正本名」；
// - 各消费端（服务端 stream-sse-writer.ts / 前端 workbench.ts / chat-dispatch.ts）只许按名
//   import 单源，且文件内不得再出现同值数字字面量（防手抄回潮——这是本门替代「两处相等」
//   的新判据：副本不存在则无从漂移）；
// - 端口镜像（Vite 代理目标 / SSE dev 基址回落）同口径：须 import 单源的 DEV_API_DEFAULT_PORT，
//   且不得再出现 127.0.0.1:<端口> 串或同值裸数字字面量。
// 登记项自校验：单源/别名/消费端/镜像任一侧声明消失 → 红；别名写回字面量 → 红。
// 盲区：跨包常量的单位语义（服务端 UTF-8 字节 / 前端码元·码点）由单源注释与消费端注释各自
// 记明，本门不对单位等价做断言。

/** 单源模块（跨包契约底座）——所有跨包共用的名字与数值的唯一字面量处。 */
const CONTRACT_SOURCE = 'src/shared/contract/studio.ts'

interface ConstRef {
  file: string
  name: string
}

/** 数值常量族：单源正本 + 同值别名（同文件、初值须引用正本名） + 消费端（须 import 单源）。 */
interface NumericConstFamily {
  canonical: ConstRef
  aliases: ConstRef[]
  consumers: ConstRef[]
  reason: string
}

const NUMERIC_CONST_FAMILIES: readonly NumericConstFamily[] = [
  {
    canonical: { file: CONTRACT_SOURCE, name: 'SSE_BACKPRESSURE_LIMIT' },
    aliases: [
      { file: CONTRACT_SOURCE, name: 'MAX_TEXT_OUT' },
      { file: CONTRACT_SOURCE, name: 'MAX_TEXT_POINTS' },
    ],
    consumers: [
      { file: 'src/studio/server/api/stream-sse-writer.ts', name: 'SSE_BACKPRESSURE_LIMIT' },
      { file: 'src/studio/web-next/src/stores/workbench.ts', name: 'MAX_TEXT_OUT' },
      { file: 'src/studio/web-next/src/stores/chat-dispatch.ts', name: 'MAX_TEXT_POINTS' },
    ],
    reason: '一次生成输出的封顶（服务端背压判死 ↔ 前端正文聚合 ↔ 对话正文闸）：三处语义同锚，值只许有一处字面量',
  },
]

/** 端口镜像：单源声明 + 镜像端（须 import 单源名；不得再硬编码地址或裸数字）。 */
interface PortMirrorFamily {
  canonical: ConstRef
  /** 镜像端（key = 文件，name = 须 import 的单源名）。 */
  mirrors: ConstRef[]
  reason: string
}

const PORT_MIRROR_FAMILIES: readonly PortMirrorFamily[] = [
  {
    canonical: { file: CONTRACT_SOURCE, name: 'DEV_API_DEFAULT_PORT' },
    mirrors: [
      { file: 'src/studio/server/dev-port.ts', name: 'DEV_API_DEFAULT_PORT' },
      { file: 'src/studio/web-next/vite.config.ts', name: 'DEV_API_DEFAULT_PORT' },
      { file: 'src/studio/web-next/src/composables/useSse.ts', name: 'DEV_API_DEFAULT_PORT' },
    ],
    reason:
      'dev-api 缺省端口三消费端同源（服务端 dev-port 再导出桥 / Vite dev 代理目标 / SSE dev 直连基址回落）——换端口只改单源一处',
  },
]

/** 源文件 AST；文件缺失 → null（缺文件由调用方点名红，不抛 ENOENT 掩盖原因）。 */
function readAst(file: string): ts.SourceFile | null {
  const fp = join(ROOT, file)
  if (!statSync(fp, { throwIfNoEntry: false })?.isFile()) return null
  return ts.createSourceFile(fp, readFileSync(fp, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

type DeclInit = { kind: 'numeric'; value: number } | { kind: 'ref'; name: string } | null

/** 变量声明初值形态：数值字面量 / 引用某标识符 / null（无声明或其它形态）。 */
function readDeclInit(sf: ts.SourceFile | null, name: string): DeclInit {
  if (!sf) return null
  let out: DeclInit = null
  forEachNode(sf, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== name) return
    const init = node.initializer
    if (!init) return
    if (ts.isNumericLiteral(init)) out = { kind: 'numeric', value: Number(init.text) }
    else if (ts.isIdentifier(init)) out = { kind: 'ref', name: init.text }
  })
  return out
}

/** 说明符 → 相对仓库根路径（去扩展名；win 分隔符归一），跨平台比对用。 */
function resolveSpecifier(fromFile: string, spec: string): string {
  const abs = resolve(dirname(join(ROOT, fromFile)), spec)
  return relative(ROOT, abs)
    .split('\\')
    .join('/')
    .replace(/\.(ts|tsx|js|mjs)$/, '')
}

/** 该文件是否从单源模块按名 import（值 import：import { name } from '<单源>'）。 */
function importsFromContract(sf: ts.SourceFile | null, file: string, name: string): boolean {
  if (!sf) return false
  let found = false
  forEachNode(sf, (node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return
    if (resolveSpecifier(file, node.moduleSpecifier.text) !== CONTRACT_SOURCE.replace(/\.ts$/, '')) return
    const bindings = node.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) return
    for (const el of bindings.elements) if ((el.propertyName ?? el.name).text === name) found = true
  })
  return found
}

/** 文件里全部字面量文本（字符串 + 无替换模板串 + 模板串静态段）——硬编码地址检测用。 */
function literalTexts(sf: ts.SourceFile): string[] {
  const out: string[] = []
  forEachNode(sf, (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text)
    else if (
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail
    ) {
      out.push((node as ts.TemplateLiteralLikeNode).text)
    }
  })
  return out
}

/** 文件里的数字字面量值（含模板串/字符串里写成数字的形态只取 AST 数字字面量）。 */
function numericLiteralValues(sf: ts.SourceFile): number[] {
  const out: number[] = []
  forEachNode(sf, (node) => {
    if (ts.isNumericLiteral(node)) out.push(Number(node.text))
  })
  return out
}

/** 消费端/镜像端硬编码回潮：同值数字字面量 或（端口族）127.0.0.1:<数字> 串。 */
function hardcodedCopies(sf: ts.SourceFile | null, value: number, addressRe: boolean): string[] {
  if (!sf) return []
  const hits: string[] = []
  for (const n of numericLiteralValues(sf)) if (n === value) hits.push(`数字字面量 ${n}`)
  if (addressRe) for (const t of literalTexts(sf)) if (/127\.0\.0\.1:\d/.test(t)) hits.push(`地址串「${t}」`)
  return hits
}

describe('跨包常量对账门（同一语义两端 → 单源 + 各端引用）', () => {
  it('单源声明在位：正本为数值字面量、别名初值引用正本名（别名写回第二处字面量即红）', () => {
    const sf = readAst(CONTRACT_SOURCE)
    expect(
      sf,
      `跨包契约单源缺失：${CONTRACT_SOURCE}——跨包常量/端口的唯一字面量处（改名/搬迁须同步本门）`,
    ).not.toBeNull()
    expect(NUMERIC_CONST_FAMILIES.length + PORT_MIRROR_FAMILIES.length, '单源族表为空（门失明）').toBeGreaterThan(0)
    const problems: string[] = []
    for (const family of NUMERIC_CONST_FAMILIES) {
      const canonical = readDeclInit(sf, family.canonical.name)
      if (!canonical || canonical.kind !== 'numeric') {
        problems.push(
          `单源正本缺失/非数值字面量：${family.canonical.name}（${family.canonical.file}，现形态 ${canonical?.kind ?? '无声明'}）——${family.reason}`,
        )
      }
      for (const alias of family.aliases) {
        const init = readDeclInit(sf, alias.name)
        if (!init) {
          problems.push(`单源别名缺失：${alias.name}（${alias.file}）——${family.reason}`)
        } else if (init.kind !== 'ref' || init.name !== family.canonical.name) {
          problems.push(
            `单源别名未引用正本名（须写 ${alias.name} = ${family.canonical.name}，不得写第二处字面量）：` +
              `${alias.name}（${alias.file}）现为 ${init.kind === 'ref' ? `引用 ${init.name}` : `字面量 ${init.value}`}`,
          )
        }
      }
    }
    for (const entry of PORT_MIRROR_FAMILIES) {
      const canonical = readDeclInit(sf, entry.canonical.name)
      if (!canonical || canonical.kind !== 'numeric') {
        problems.push(`单源端口缺失/非数值字面量：${entry.canonical.name}（${entry.canonical.file}）——${entry.reason}`)
      }
    }
    expect(problems, '跨包常量单源声明自校验失败：\n' + problems.join('\n')).toEqual([])
  })

  it('单源值自证：别名与正本运行期同值、端口为正整数（值被静默改小/清零即红）', () => {
    // 别名 = 正本：
    expect(MAX_TEXT_OUT, 'MAX_TEXT_OUT 与 SSE_BACKPRESSURE_LIMIT 不同值——别名被改成独立字面量').toBe(
      SSE_BACKPRESSURE_LIMIT,
    )
    expect(MAX_TEXT_POINTS, 'MAX_TEXT_POINTS 与 SSE_BACKPRESSURE_LIMIT 不同值——别名被改成独立字面量').toBe(
      SSE_BACKPRESSURE_LIMIT,
    )
    // 地板：值被清零/改小会让两端闸同时失效（单源只保证一致，不保证有效）
    expect(SSE_BACKPRESSURE_LIMIT, '背压/正文封顶值非正（单源被改坏）').toBeGreaterThan(0)
    expect(
      Number.isInteger(DEV_API_DEFAULT_PORT) && DEV_API_DEFAULT_PORT > 0 && DEV_API_DEFAULT_PORT <= 65535,
      `dev-api 缺省端口非 1–65535 整数：${DEV_API_DEFAULT_PORT}`,
    ).toBe(true)
  })

  it('消费端只许按名 import 单源，且文件内不得再有同值字面量（手抄回潮即红）', () => {
    const consumerCount = NUMERIC_CONST_FAMILIES.reduce((n, f) => n + f.consumers.length, 0)
    const mirrorCount = PORT_MIRROR_FAMILIES.reduce((n, f) => n + f.mirrors.length, 0)
    expect(consumerCount, '消费端表为空（门失明）').toBeGreaterThanOrEqual(3)
    expect(mirrorCount, '端口镜像表为空（门失明）').toBeGreaterThanOrEqual(2)
    const problems: string[] = []
    for (const family of NUMERIC_CONST_FAMILIES) {
      const canonicalValue = readDeclInit(readAst(CONTRACT_SOURCE), family.canonical.name)
      if (!canonicalValue || canonicalValue.kind !== 'numeric') {
        problems.push(`单源正本不可读——无法校验消费端副本：${family.canonical.name}`)
        continue
      }
      for (const consumer of family.consumers) {
        const sf = readAst(consumer.file)
        if (!sf) {
          problems.push(`消费端文件缺失：${consumer.file}——改名/搬迁后须同步本表`)
          continue
        }
        if (!importsFromContract(sf, consumer.file, consumer.name)) {
          problems.push(
            `消费端未按名 import 单源 ${consumer.name}：${consumer.file}——` +
              `须 import { ${consumer.name} } from 单源（${CONTRACT_SOURCE}），不得本地再写一份`,
          )
        }
        const copies = hardcodedCopies(sf, canonicalValue.value, false)
        if (copies.length > 0) {
          problems.push(
            `消费端仍存同值字面量副本（手抄回潮，无从保证与单源同值）：${consumer.file} → ${copies.join('、')}`,
          )
        }
      }
    }
    for (const entry of PORT_MIRROR_FAMILIES) {
      const port = readDeclInit(readAst(CONTRACT_SOURCE), entry.canonical.name)
      if (!port || port.kind !== 'numeric') {
        problems.push(`单源端口不可读——无法校验镜像端：${entry.canonical.name}`)
        continue
      }
      for (const mirror of entry.mirrors) {
        const sf = readAst(mirror.file)
        if (!sf) {
          problems.push(`端口镜像文件缺失：${mirror.file}——改名/搬迁后须同步本表`)
          continue
        }
        if (!importsFromContract(sf, mirror.file, mirror.name)) {
          problems.push(`端口镜像端未按名 import 单源 ${mirror.name}：${mirror.file}——${entry.reason}`)
        }
        const copies = hardcodedCopies(sf, port.value, true)
        if (copies.length > 0) {
          problems.push(
            `端口镜像端仍有硬编码副本（改端口会漏改，dev 页面静默失联）：${mirror.file} → ${copies.join('、')}——${entry.reason}`,
          )
        }
      }
    }
    expect(problems, '跨包常量/端口单源引用对账失败：\n' + problems.join('\n')).toEqual([])
  })
})

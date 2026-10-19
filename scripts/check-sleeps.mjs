/**
 * 测试面「定长实睡」门。
 *
 * 问题形态：`await new Promise((r) => setTimeout(r, 200))` ——把「等某个状态出现」写成
 * 「睡一个凑好的时长」。两个后果都是静默的：①机器慢一点就偶发红（红在别处，看着像产品
 * 缺陷）；②机器快则白等，全套件累计成分钟级的空转。
 *
 * 但「实睡」与「合法的固定时长」在文本上一模一样，区分它们需要**位置**信息：
 *
 * - **轮询间隔**（合法）：`while (!existsSync(marker) && Date.now() < deadline) await sleep(100)`
 *   ——这里的 N 是两次探测之间的间隔，判据本身是那行 `while` 条件（有截止、有可观察量）。
 *   故判据取「语句是否词法上位于循环体内」：在循环里就是间隔，不是实睡。
 * - **负向断言的观察窗**（合法但需写理由）：`await sleep(200); expect(count).toBe(n)`
 *   ——要证明「不该再发生」，只能等一个窗口过去。形态上与实睡无法区分，故只能靠**登记**
 *   放行（下方 baseline），并在登记条目上写清这个窗口为什么是必要下限。
 * - **其余**（不受欢迎）：多为「等某状态出现」的偷懒写法，应改 `vi.waitFor` 轮询判据。
 *
 * 判据因此是**上锚**而非清零：冻结实测数为上限，新增即红（写新的就得先清掉一条存量，或
 * 在 baseline 里登记理由），存量清理不强制。机制与 `check-comments` 的 `TAG_ANCHORS`、
 * `check-counts` 的 `TEST_BATCH_ANCHOR` 同族，理由同：一次性清几百处的 diff review 成本
 * 远高于它带来的收益，而门的作用是**阻止增长**。
 *
 *   node scripts/check-sleeps.mjs          跑门
 *   node scripts/check-sleeps.mjs --list   只列命中（排障 / 重算 baseline 用）
 *
 * 扫描面 = `test/**`。阈值 = 100ms（低于此的实睡不值得写成实睡，也不值得拦）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { REPO_ROOT as root } from './repo-root.mjs'

/** 低于此值的实睡不入判据（个位数毫秒是「让出事件循环」，不是「等一个状态」）。 */
export const SLEEP_THRESHOLD_MS = 100

/** 扫描根（相对仓库根）。只扫测试面——生产代码里没有「等一个时长」这种正当形态。 */
export const SCAN_ROOTS = ['test']

/**
 * baseline：文件相对路径 → 允许的实睡处数。超出即红；低于不追（清理不强制）。
 *
 * 冻结于落门实测（22 处 / 18 档，win 腿口径）。这些存量逐处都还没换写成轮询，属「不追」
 * 而非「认可」：本表只承担**阻止增长**。清理时改一处就同步下调对应数字，降到 0 即整条删掉。
 */
export const SLEEP_BASELINE = Object.freeze({
  'test/ai/chat-abort.test.ts': 1,
  'test/ai/chat-settle.test.ts': 2,
  'test/ai/chat-steer.test.ts': 1,
  'test/ai/gen.test.ts': 1,
  'test/desktop/main-reachability.test.ts': 1,
  'test/desktop/switch-library-cancel-rollback.test.ts': 2,
  'test/document/lead-finalize-lock-order.test.ts': 1,
  'test/process/summary.test.ts': 1,
  'test/studio/api/draft-save-drain-chaining.test.ts': 1,
  'test/studio/api/knowledge-learn-gate.test.ts': 1,
  'test/studio/api/readjson-body-lifecycle.test.ts': 1,
  'test/studio/api/stream-api.test.ts': 1,
  'test/studio/api/stream-ticket.test.ts': 2,
  'test/studio/server/books-delete-events.test.ts': 1,
  'test/studio/server/graceful-shutdown.test.ts': 1,
  'test/studio/server/readjson-chunked.test.ts': 1,
  'test/studio/server/static-branch-error.test.ts': 2,
  'test/studio/webnext/dom/cm-programmatic-replace-no-reemit.test.ts': 1,
})

/**
 * 已核实「这个固定时长是必要下限」的档（file → reason）。
 *
 * 与 SLEEP_BASELINE 分工：计数会随清理下调，而理由与档同在、不随数字漂移。**不收「等某
 * 状态出现」的档**——那是 `vi.waitFor` 的活，登记只会把偷懒写法洗白。当前只登记负向断言
 * 的观察窗：要证明「某事不该再发生」，时间窗本身就是判据，没有可轮询的对象。
 */
export const REGISTERED = Object.freeze({
  'test/ai/chat-abort.test.ts': '负向断言：中断后 requestCount 不再增长——「不再发生」只能等窗口过去',
  'test/ai/chat-settle.test.ts': '负向断言：收尾未到时 waitChatSettled 不得提前 resolve（两处各测一个阶段）',
  'test/studio/server/static-branch-error.test.ts':
    '负向断言：unhandledRejection 不得出现——事件在微任务/下一轮才派发，必须等窗口',
})

/** 累加：语法上是否位于循环体内（轮询间隔的判据）。 */
function insideLoop(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (
      ts.isWhileStatement(p) ||
      ts.isForStatement(p) ||
      ts.isForOfStatement(p) ||
      ts.isForInStatement(p) ||
      ts.isDoStatement(p)
    ) {
      return true
    }
  }
  return false
}

/** 数值字面量的毫秒值；非字面量（变量/表达式）→ null（判不了就不算，宁可漏也不误杀）。 */
function msOf(node) {
  if (!node) return null
  if (ts.isNumericLiteral(node)) return Number(node.text)
  // `10_000` 一类带分隔符的写法由 NumericLiteral.text 已归一为 "10000"
  return null
}

/**
 * 从 `setTimeout(cb, N)` / `sleep(N)` / `delay(N)` 里取出毫秒数。
 *
 * `setTimeout` 两形都要认：裸调用（callee 是标识符）与 `globalThis.setTimeout` /
 * `win.setTimeout`（callee 是属性访问）——只认后者时，测试里最常见的
 * `new Promise((r) => setTimeout(r, N))` 整支漏判（门自报「共 2 处」而实测三十余处）。
 */
function sleepMsOfCall(call) {
  if (!ts.isCallExpression(call)) return null
  const callee = call.expression
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null
  if (name === 'setTimeout') return msOf(call.arguments[1]) // setTimeout(cb, 毫秒)
  if (name === 'sleep' || name === 'delay') return msOf(call.arguments[0]) // sleep(毫秒)
  return null
}

/**
 * 在 `new Promise(...)` 里找「实睡」的毫秒数；是竞速守卫则返回 null。
 *
 * 关键区分：`new Promise((r) => setTimeout(r, 200))` 是**睡**（定时器是唯一出口）；
 * `new Promise((resolve) => { child.once('exit', () => resolve()); setTimeout(() => kill(), 30_000) })`
 * 是**竞速守卫**（真实事件 resolve，定时器只是「等太久了就杀掉」的兜底）——后者在测试里
 * 是正确形态，把它算成实睡会让门逼人删掉兜底、让用例在挂死时永久卡住。
 *
 * 判据 = **resolve 是否另有一条出口**：除定时器回调之外还有 `resolve(...)` 调用点（事件订阅、
 * `once`、`on` 的闭包里），就是守卫。这也覆盖 `setTimeout(resolve, N)` 与
 * `setTimeout(() => resolve(), N)` 两形（前者 resolve 作为回调传入、后者调用在定时器内）。
 */
function msOfPromiseSleep(newExpr) {
  const executor = newExpr.arguments?.[0]
  if (!executor || !(ts.isArrowFunction(executor) || ts.isFunctionExpression(executor))) return null
  const firstParam = executor.parameters[0]
  const resolveName = firstParam && ts.isIdentifier(firstParam.name) ? firstParam.name.text : null

  // 先定位执行体里的 setTimeout 调用及其毫秒（自根节点起扫——箭头函数体可能**就是**那个
  // 调用表达式，只扫子节点会把它整个漏掉）
  let timerCall = null
  let ms = null
  const findTimer = (node) => {
    if (timerCall) return
    if (ts.isCallExpression(node)) {
      const got = sleepMsOfCall(node)
      if (got !== null) {
        timerCall = node
        ms = got
        return
      }
    }
    node.forEachChild(findTimer)
  }
  findTimer(executor.body)
  if (!timerCall || ms === null) return null

  // 再看 resolve 是否有定时器之外的出口
  let hasOtherExit = false
  const scanExit = (node) => {
    if (hasOtherExit) return
    if (ts.isCallExpression(node) && resolveName !== null) {
      const callee = node.expression
      if (ts.isIdentifier(callee) && callee.text === resolveName) {
        hasOtherExit = true
        return
      }
    }
    node.forEachChild(scanExit)
  }
  // 从执行体扫，但跳过定时器的第一个实参（那是定时器自己的出口，不算「另一条」）
  const scanExceptTimerCallback = (node) => {
    if (hasOtherExit) return
    if (node === timerCall) {
      for (const arg of timerCall.arguments) {
        if (arg === timerCall.arguments[0]) continue // 定时器回调整体跳过
        scanExit(arg)
      }
      return
    }
    if (ts.isCallExpression(node) && resolveName !== null) {
      const callee = node.expression
      if (ts.isIdentifier(callee) && callee.text === resolveName) {
        hasOtherExit = true
        return
      }
    }
    node.forEachChild(scanExceptTimerCallback)
  }
  scanExceptTimerCallback(executor.body)
  if (hasOtherExit) return null
  return ms
}

/**
 * 对单档源码找「裸定长实睡」命中。返回 [{ line, ms, text }]。
 *
 * 只认 `await` 位置：不 await 的 setTimeout 是排程（本身就带句柄），不是实睡。
 */
export function findSleeps(content, file = 'x.ts') {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const hits = []
  const visit = (node) => {
    if (ts.isAwaitExpression(node)) {
      const arg = node.expression
      let ms = null
      if (ts.isNewExpression(arg) && ts.isIdentifier(arg.expression) && arg.expression.text === 'Promise') {
        ms = msOfPromiseSleep(arg)
      } else if (ts.isCallExpression(arg)) {
        ms = sleepMsOfCall(arg)
      }
      if (ms !== null && ms >= SLEEP_THRESHOLD_MS && !insideLoop(node)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
        hits.push({ line: line + 1, ms, text: node.getText(sf).replace(/\s+/g, ' ').slice(0, 120) })
      }
    }
    node.forEachChild(visit)
  }
  sf.forEachChild(visit)
  return hits
}

/** 收集扫描面文件（相对仓库根的 POSIX 路径）。 */
export function collectFiles(base = root) {
  const out = []
  const walk = (dir) => {
    let names
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const abs = join(dir, name)
      let st
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(abs)
        continue
      }
      if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)) out.push(abs)
    }
  }
  for (const dir of SCAN_ROOTS) walk(join(base, dir))
  return out
}

/**
 * 全库扫描。返回 `{ hits, problems }`——命中带 file 相对路径；扫描面问题按 fail-closed 收口。
 */
export function scanRepo(base = root) {
  const problems = []
  const hits = []
  const files = collectFiles(base)
  if (files.length === 0) {
    problems.push(`扫描面为空：${SCAN_ROOTS.join('/')} 下零个测试档——目录结构或命名口径已失效`)
  }
  for (const abs of files) {
    const rel = relative(base, abs).split(sep).join('/')
    let content
    try {
      content = readFileSync(abs, 'utf8')
    } catch (e) {
      problems.push(`文件不可读：${rel}（${e.code ?? e.message ?? String(e)}）——扫描面不完整`)
      continue
    }
    for (const h of findSleeps(content, rel)) hits.push({ file: rel, ...h })
  }
  return { hits, problems }
}

/**
 * 上锚分流（纯函数，双向直测）：返回 `{ excess, registered }`。
 *
 * `excess` = 超出该档 baseline 的命中（未登记档的 baseline 视为 0）；
 * `registered` = 已在 baseline 内的命中（信息面，不红）。
 */
export function splitByBaseline(hits, baseline = SLEEP_BASELINE) {
  const byFile = new Map()
  for (const h of hits) {
    const list = byFile.get(h.file) ?? []
    list.push(h)
    byFile.set(h.file, list)
  }
  const excess = []
  const registered = []
  for (const [file, list] of byFile) {
    const cap = baseline[file] ?? 0
    // 稳定排序：按行号，前 cap 条算存量，其余算新增——行号靠前的存量先占位，
    // 这样「在同一档里新加一处」永远落在尾部而不是把存量挤成新增
    const sorted = [...list].sort((a, b) => a.line - b.line)
    registered.push(...sorted.slice(0, cap))
    excess.push(...sorted.slice(cap))
  }
  excess.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
  return { excess, registered }
}

export function main() {
  const listOnly = process.argv.includes('--list')
  const { hits, problems } = scanRepo()
  if (problems.length) {
    console.error('定长实睡门未过（sleep-surface）：扫描面本身不可信——下列问题使判定无意义，')
    console.error('先修复扫描面再重跑（fail-closed：扫描面为空 / 不可读时绝不打通过）。')
    for (const p of problems) console.error(`  • ${p}`)
    process.exit(1)
  }
  if (listOnly) {
    for (const h of hits) console.log(`${h.file}:${h.line}  ${h.ms}ms  ${h.text}`)
    console.log(`共 ${hits.length} 处（≥${SLEEP_THRESHOLD_MS}ms，已排除循环内的轮询间隔）。`)
    return
  }
  const { excess } = splitByBaseline(hits)
  if (excess.length > 0) {
    console.error('定长实睡门未过（sleep-surface）：测试面新增了定长实睡。')
    console.error('  纪律：等某个状态出现 → `vi.waitFor` 轮询判据；等一个时间窗过去（负向断言）→')
    console.error('  在 SLEEP_BASELINE 登记该档并写清「这个下限为什么是必要的」。')
    let lastFile = ''
    for (const h of excess) {
      if (h.file !== lastFile) {
        console.error(`  ${h.file}`)
        lastFile = h.file
      }
      console.error(`    :${h.line}  ${h.ms}ms  ${h.text}`)
    }
    console.error(
      `  共 ${excess.length} 处超出 baseline，且该档未登记理由（${Object.keys(REGISTERED).length} 档已登记）。`,
    )
    process.exit(1)
  }
  console.log(
    `check:sleeps 通过：测试面定长实睡 ${hits.length} 处 ≤ baseline ${Object.values(SLEEP_BASELINE).reduce((a, b) => a + b, 0)}（存量冻结，新增即红；循环内的轮询间隔不计入判据）。`,
  )
  const noReason = Object.keys(SLEEP_BASELINE).filter((f) => !(f in REGISTERED))
  if (noReason.length > 0) {
    console.log(`  其中 ${noReason.length} 档未核实理由（属「不追」而非「认可」）：清理时改一处即下调一处。`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()

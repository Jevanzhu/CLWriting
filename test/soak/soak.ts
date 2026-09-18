/**
 * R0910-W（2026-09-10）：有界内存/soak 门——「200 万字不崩」至今没有任何内存断言
 * （全仓 grep memoryUsage|heapUsed|max-old-space = 0 命中），线性泄漏回归无法被
 * 任何门拦下。本脚本补上最小可信防线：反复跑一条真实存在的「纯、有界、热」路径
 * （章纲 parse→stringify→回读往返，piece-list-core 零 Node 依赖、无 I/O、无定时器），
 * 强制 GC 后断言 heapUsed 增长不超一个带大余量的上界——只为抓线性泄漏，不测噪声。
 *
 * R0911-G-P3-4（2026-09-11 全量重评 GLM-5.3 修复批）：补第二条受守路径——RAG 召回
 *（此前仅 piece-list 一条，rag/召回零内存断言）：建索引一次 + 召回 N 次（每调用
 * 开/关 SQLite + 流式打分，P1-31 句柄契约与 R46-9 流式内存契约正在此面）。与首段
 * 同样固定输入/无定时器；差异 = 有临时目录 I/O（收尾即删）与桩 embed（3 维确定性，
 * 不联网）。两段各自独立预算/断言，任一超界即 FAIL。
 *
 * 为何是独立脚本而非 vitest 用例（任务书 CRITICAL 条）：
 * 1) scripts/check-counts.mjs 按 README 声称值对账「测试文件数 / 单测数」，新增
 *    test/**\/*.test.ts 会直接改动被计数的套件，README 需连带修账；
 * 2) vitest 走 forks 池跑测，`--expose-gc` 落在主进程、worker 内 globalThis.gc 不可
 *    保证可用，false-skip 风险高。独立脚本用 `node --expose-gc`（经 tsx 转发）直接
 *    掌控 GC 可见性，主套件零扰动。文件名故意不带 .test.，vitest include（test/**\/*.test.ts）
 *    与 check-counts 的 *.test.ts 收集口径都不命中——不新增/不改动任何被计数用例。
 *
 * 确定性保证：无 wall-clock sleep、无 timer、无并发；用固定输入迭代固定次数；
 * GC 后取多次采样的最小值作基线/终值（压采样时机噪声）。globalThis.gc 不可用时
 * 干净 SKIP（exit 0，打印 SKIP 标记）——绝不给假结果。
 *
 * 跑：npm run soak（= node --expose-gc … tsx …）。可调：CLW_SOAK_ITER、CLW_SOAK_BOUND_MB、
 * CLW_SOAK_RAG_ITER（缺省 20000）、CLW_SOAK_RAG_BOUND_MB（缺省 24）、CLW_SOAK_MANIFEST_ITER
 * （缺省 3000）、CLW_SOAK_MANIFEST_BOUND_MB、CLW_SOAK_EV_ITER（缺省 2000 批×10）、
 * CLW_SOAK_EV_BOUND_MB、CLW_SOAK_SVC_ITER（缺省 600）、CLW_SOAK_SVC_BOUND_MB（均缺省 24）。
 */
import { parsePieceListBody, stringifyPieceList } from '../../src/format/piece-list-core.js'
import type { PieceList } from '../../src/format/types.js'
// R0911-G-P3-4：RAG 召回段的装置面（桩 embed 不联网；writeChapter 是测试造章助手）
// R0915-4a：补段三～五的装置面（清单 jsonl 重写 / 事件库长会话 / service save 链）
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildIndex, recall } from '../../src/rag/index.js'
import { writeChapter } from '../helpers/chapter.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { EmbedResult } from '../../src/rag/embed.js'
import { readManifestStrict, upsertEntry, writeManifest, type Manifest } from '../../src/document/manifest.js'
import { openSessionStore, type NewEvent } from '../../src/events/store.js'
import { DocumentService } from '../../src/document/service.js'

/** 固定小fixture（真实章纲三段式形态）：纯字符串常量，解析/回写零外部依赖。 */
const FIXTURE = [
  '## 反转线索表',
  '- 核心反转：来客即死者',
  '- 铺垫点（≥3，反转可回溯）：',
  '  - [第一章] 茶馆里多摆了一副碗筷',
  '  - [第三章] 死者袖口的茶渍',
  '  - [第五章] 更夫说漏的时辰',
  '',
  '## 情绪曲线',
  '- [开头钩子] 惊悚 3/10：尸体敲门',
  '- [反转] 震惊 9/10：来客就是死者',
  '',
  '## 伏笔回收',
  '- 多摆的碗筷 → 回收于 第五章',
  '- 无名的更夫（未回收）',
].join('\n')

/** `--expose-gc` 未开时 globalThis.gc 不存在——显式窄化，不裸引用 `global`（免 no-undef）。 */
const gc = (globalThis as unknown as { gc?: () => void }).gc

/** 环境值解析：0 是合法值（`|| 默认`会把它误当缺省），按「缺省/非法才回落」判。 */
function numEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}
const ITER = numEnv('CLW_SOAK_ITER', 100_000)
/** 增长上界：100k 次迭代给 24MB 余量（≈240B/次），远高于噪声、远低于典型线性泄漏。 */
const BOUND_MB = numEnv('CLW_SOAK_BOUND_MB', 24)

// ── 0918四轮修复批（G408）：--plan 旗标 ────────────────────────────────────────
// 此前 CI 侧（ci.yml / desktop.yml）soak 断言各自硬编码「OK 行数 -eq 5」——段数真相源
// 分裂三处（两把 yml + 本脚本实态），补段漏改任一 yml 即假绿/假红双风险。修法：本脚本
// 出 --plan（打印 `plan: N` 即退出 0，不跑段、不要求 --expose-gc——故必须置于下方 gc
// 门之前），CI 改两段式：先 --plan 提计划数，再真跑比对 OK 行数。PLAN_SEGMENTS 为段数
// 唯一真相源，补段须同步改此值：漏改时真跑 OK 行数 ≠ 计划数，CI 断言红（fail-closed
// 与旧硬编码同向，且改一处即全量生效）。
const PLAN_SEGMENTS = 5
if (process.argv.includes('--plan')) {
  console.log(`plan: ${PLAN_SEGMENTS}`)
  process.exit(0)
}

if (typeof gc !== 'function') {
  console.log('[soak] SKIP：未检测到 globalThis.gc（需以 node --expose-gc 运行）；跳过内存断言，不给假结果。')
  process.exit(0)
}

const gcFn: () => void = gc

/** GC 后多次采样取最小值——压单一采样时点的残留垃圾噪声。 */
function settledHeapUsed(): number {
  let min = Number.POSITIVE_INFINITY
  for (let i = 0; i < 5; i++) {
    gcFn()
    const h = process.memoryUsage().heapUsed
    if (h < min) min = h
  }
  return min
}

/** 单次往返：parse → stringify → 回读，全链分配即弃（模拟章纲面板热路径）。 */
function oneRoundTrip(): PieceList {
  const parsed = parsePieceListBody(FIXTURE)
  const text = stringifyPieceList(parsed)
  return parsePieceListBody(text)
}

// 功能性底座：往返幂等（input→parse→stringify→parse 应与直接 parse 等价）。
// 既保证循环不是空转（防被引擎当无副作用整体消去），也让 soak 脚本本身是一次真断言。
const once = oneRoundTrip()
const twice = parsePieceListBody(stringifyPieceList(once))
if (JSON.stringify(once) !== JSON.stringify(twice)) {
  console.error('[soak] FAIL：章纲往返不幂等，soak 输入本身失效。')
  process.exit(1)
}

// 预热（让 JIT/内联缓存落定后再取基线，避免编译期临时分配计入增长）。
for (let i = 0; i < Math.min(5_000, ITER); i++) oneRoundTrip()

const baseline = settledHeapUsed()
for (let i = 0; i < ITER; i++) oneRoundTrip()
const finalHeap = settledHeapUsed()

const growthMb = (finalHeap - baseline) / (1024 * 1024)
const boundBytes = BOUND_MB * 1024 * 1024

console.log(
  `[soak] 迭代 ${ITER} 次 · 基线 heapUsed ${(baseline / 1048576).toFixed(2)}MB · ` +
    `终值 ${(finalHeap / 1048576).toFixed(2)}MB · 增长 ${growthMb.toFixed(2)}MB · 上界 ${BOUND_MB}MB`,
)

if (finalHeap - baseline > boundBytes) {
  console.error(
    `[soak] FAIL：heapUsed 增长 ${growthMb.toFixed(2)}MB 超上界 ${BOUND_MB}MB——疑似线性泄漏（迭代 ${ITER} 次）。`,
  )
  process.exit(1)
}
console.log('[soak] OK：有界往返循环无显著内存增长。')

// ── R0911-G-P3-4（2026-09-11 全量重评 GLM-5.3 修复批）：RAG 召回热路径 ─────────────
const RAG_ITER = numEnv('CLW_SOAK_RAG_ITER', 20_000)
/** RAG 段增长上界：20k 次召回（SQLite 开/关 + 流式打分 + 命中元组 churn）给 24MB 余量。 */
const RAG_BOUND_MB = numEnv('CLW_SOAK_RAG_BOUND_MB', 24)

/** 桩 embed：确定性 3 维（test/rag/r1010b 同款），不联网。 */
function stubEmbed(_e: string, _m: string, _k: string, texts: string[]): Promise<EmbedResult> {
  return Promise.resolve(
    texts.map((t) => {
      const norm = 1 / ((t.charCodeAt(0) || 1) + 1)
      return [norm, norm * 0.5, norm * 0.3]
    }),
  )
}

const ragRoot = join(tmpdir(), `clw-soak-rag-${Date.now()}-${Math.random().toString(36).slice(2)}`)
mkdirSync(join(ragRoot, '写作', '正文'), { recursive: true })
for (const n of [1, 2, 3]) {
  const meta: ChapterMeta = {
    章号: n, 标题: `第${n}章`, 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
    _path: '', _wordCount: 100,
  }
  writeChapter(join(ragRoot, '写作', '正文', `${n}-第${n}章.md`), meta, `第${n}章正文，战斗场景描写充分，主角挥剑，剑光如水。`)
}
const RAG_CONFIG = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }

// 功能性底座：建索引必须成功、召回必须非空（防循环空转假绿——空召回路径不走打分面）
const built = await buildIndex(ragRoot, RAG_CONFIG, 'key', stubEmbed)
if (!built.ok) {
  console.error(`[soak] FAIL：RAG 装置建索引失败（${built.error}）——soak 输入本身失效。`)
  rmSync(ragRoot, { recursive: true, force: true })
  process.exit(1)
}
async function oneRecall(): Promise<number> {
  const hits = await recall(ragRoot, RAG_CONFIG, 'key', '战斗 主角 挥剑', 3, stubEmbed)
  return hits.length
}
if ((await oneRecall()) === 0) {
  console.error('[soak] FAIL：RAG 装置召回为空——soak 输入本身失效。')
  rmSync(ragRoot, { recursive: true, force: true })
  process.exit(1)
}

// 预热（JIT/内联缓存/SQLite 页缓存落定后再取基线）
for (let i = 0; i < Math.min(2_000, RAG_ITER); i++) await oneRecall()

const ragBaseline = settledHeapUsed()
for (let i = 0; i < RAG_ITER; i++) await oneRecall()
const ragFinal = settledHeapUsed()
rmSync(ragRoot, { recursive: true, force: true })

const ragGrowthMb = (ragFinal - ragBaseline) / (1024 * 1024)
console.log(
  `[soak] RAG 召回迭代 ${RAG_ITER} 次 · 基线 heapUsed ${(ragBaseline / 1048576).toFixed(2)}MB · ` +
    `终值 ${(ragFinal / 1048576).toFixed(2)}MB · 增长 ${ragGrowthMb.toFixed(2)}MB · 上界 ${RAG_BOUND_MB}MB`,
)
if (ragFinal - ragBaseline > RAG_BOUND_MB * 1024 * 1024) {
  console.error(
    `[soak] FAIL：RAG 召回 heapUsed 增长 ${ragGrowthMb.toFixed(2)}MB 超上界 ${RAG_BOUND_MB}MB——疑似线性泄漏（迭代 ${RAG_ITER} 次，句柄/打分流式契约正在此面）。`,
  )
  process.exit(1)
}
console.log('[soak] OK：RAG 召回循环无显著内存增长。')

// ── R0915-4a（2026-09-15 中件组批，台账行 260 soak 面窄处置）：补段三～五 ──────────
// 行 260 登记三处无内存断言面：文档清单 jsonl 重写放大 / 事件库长会话增长 / service
// 索引累积。三段同前两段纪律：固定输入固定次数、无 wall-clock sleep、无并发、功能
// 性底座防空转假绿、失败路径 rmSync 后 FAIL。段 5 走 DocumentService.save 真链
// （journal pending + 留底去重 + 清单 RMW + 字数 delta），顺序单写无锁竞争——
// 锁等待 setTimeout 轮询不触发，事件循环干净，跑完即退。

// 段 3：文档清单 jsonl 重写放大——每次重写全量序列化 M 条（O(M) 字符串构建），
// 内存应随迭代有界（写必 bump mtime + writeManifest 主动清缓存双保险在此面）。
const MANIFEST_ROWS = 200
const MANIFEST_ITER = numEnv('CLW_SOAK_MANIFEST_ITER', 3_000)
const MANIFEST_BOUND_MB = numEnv('CLW_SOAK_MANIFEST_BOUND_MB', 24)

const manifestDir = join(tmpdir(), `clw-soak-manifest-${Date.now()}-${Math.random().toString(36).slice(2)}`)
mkdirSync(manifestDir, { recursive: true })
const manifestPath = join(manifestDir, '文档清单.jsonl')
const seedManifest: Manifest = { version: 1, entries: new Map() }
for (let i = 0; i < MANIFEST_ROWS; i++) {
  upsertEntry(seedManifest, {
    id: `d${i}`, nodeType: 'document',
    path: `写作/正文/${String(i + 1).padStart(4, '0')}-章.md`, parentId: null,
  })
}
writeManifest(manifestPath, seedManifest)
if (readManifestStrict(manifestPath).entries.size !== MANIFEST_ROWS) {
  console.error('[soak] FAIL：清单装置读回条数不符——soak 输入本身失效。')
  rmSync(manifestDir, { recursive: true, force: true })
  process.exit(1)
}
function manifestRewriteOnce(i: number): void {
  const m = readManifestStrict(manifestPath)
  upsertEntry(m, {
    id: 'd0', nodeType: 'document',
    path: `写作/正文/0001-章-v${i % 97}.md`, parentId: null,
  })
  writeManifest(manifestPath, m)
}
for (let i = 0; i < Math.min(300, MANIFEST_ITER); i++) manifestRewriteOnce(i)
const manifestBaseline = settledHeapUsed()
for (let i = 0; i < MANIFEST_ITER; i++) manifestRewriteOnce(i)
const manifestFinal = settledHeapUsed()
rmSync(manifestDir, { recursive: true, force: true })

const manifestGrowthMb = (manifestFinal - manifestBaseline) / (1024 * 1024)
console.log(
  `[soak] 清单重写迭代 ${MANIFEST_ITER} 次（${MANIFEST_ROWS} 条）· 基线 ${(manifestBaseline / 1048576).toFixed(2)}MB · ` +
    `终值 ${(manifestFinal / 1048576).toFixed(2)}MB · 增长 ${manifestGrowthMb.toFixed(2)}MB · 上界 ${MANIFEST_BOUND_MB}MB`,
)
if (manifestFinal - manifestBaseline > MANIFEST_BOUND_MB * 1024 * 1024) {
  console.error(
    `[soak] FAIL：清单重写 heapUsed 增长 ${manifestGrowthMb.toFixed(2)}MB 超上界 ${MANIFEST_BOUND_MB}MB——疑似线性泄漏（重写放大面）。`,
  )
  process.exit(1)
}
console.log('[soak] OK：文档清单重写循环无显著内存增长。')

// 段 4：事件库长会话增长——单会话持续追加（批接口真链），行数落盘 SQLite、堆不应
// 随会话长度线性涨（listEvents 全量投影是 O(N) 读面，循环内不做全量读防 O(N²)，
// 终态以 lastSeq 钉行数）。
const EV_BATCH = 10
const EV_ITER = numEnv('CLW_SOAK_EV_ITER', 2_000)
const EV_BOUND_MB = numEnv('CLW_SOAK_EV_BOUND_MB', 24)

const evDir = join(tmpdir(), `clw-soak-ev-${Date.now()}-${Math.random().toString(36).slice(2)}`)
const evRoot = join(evDir, 'book')
mkdirSync(evRoot, { recursive: true })
const evStore = openSessionStore(evDir, evRoot)
if (!evStore) {
  console.error('[soak] FAIL：事件库装置 openSessionStore 返回 null——soak 输入本身失效。')
  rmSync(evDir, { recursive: true, force: true })
  process.exit(1)
}
const evSession = evStore.createSession('soak')
function evBatch(i: number): NewEvent[] {
  return Array.from({ length: EV_BATCH }, (_, k) => ({
    type: 'llm/call',
    data: {
      runId: `r${i}-${k}`, task: 'soak', tierKind: 'creative', model: 'model-soak', attempt: 0,
      stopReason: 'end', durationMs: 1, ok: true,
    },
  }))
}
evStore.appendEvents(evSession, evBatch(0))
if (evStore.listEvents('soak', evSession).length !== EV_BATCH) {
  console.error('[soak] FAIL：事件库装置读回批数不符——soak 输入本身失效。')
  evStore.close()
  rmSync(evDir, { recursive: true, force: true })
  process.exit(1)
}
for (let i = 1; i < Math.min(200, EV_ITER); i++) evStore.appendEvents(evSession, evBatch(i))
const evBaseline = settledHeapUsed()
for (let i = 200; i < EV_ITER; i++) evStore.appendEvents(evSession, evBatch(i))
const evFinal = settledHeapUsed()
if (evStore.lastSeq() !== EV_ITER * EV_BATCH) {
  console.error('[soak] FAIL：事件库终态 lastSeq 与追加批数不符——soak 输入本身失效。')
  evStore.close()
  rmSync(evDir, { recursive: true, force: true })
  process.exit(1)
}
evStore.close()
rmSync(evDir, { recursive: true, force: true })

const evGrowthMb = (evFinal - evBaseline) / (1024 * 1024)
console.log(
  `[soak] 事件库长会话追加 ${EV_ITER} 批 × ${EV_BATCH} 事件 · 基线 ${(evBaseline / 1048576).toFixed(2)}MB · ` +
    `终值 ${(evFinal / 1048576).toFixed(2)}MB · 增长 ${evGrowthMb.toFixed(2)}MB · 上界 ${EV_BOUND_MB}MB`,
)
if (evFinal - evBaseline > EV_BOUND_MB * 1024 * 1024) {
  console.error(
    `[soak] FAIL：事件库 heapUsed 增长 ${evGrowthMb.toFixed(2)}MB 超上界 ${EV_BOUND_MB}MB——疑似随会话长度线性泄漏。`,
  )
  process.exit(1)
}
console.log('[soak] OK：事件库长会话循环无显著内存增长。')

// 段 5：service save 链累积——DocumentService.save 真链（journal pending + 留底
// dedupe + 清单 RMW + 字数 delta + revision 链），内容逐次变化使留底不 hit 去重
// 短路；顺序单写无锁竞争。快照/日志文件落盘，堆有界即「索引/映射不随保存次数涨」。
const SVC_ITER = numEnv('CLW_SOAK_SVC_ITER', 600)
const SVC_BOUND_MB = numEnv('CLW_SOAK_SVC_BOUND_MB', 24)

const svcDir = join(tmpdir(), `clw-soak-svc-${Date.now()}-${Math.random().toString(36).slice(2)}`)
const svcRoot = join(svcDir, 'soakbook')
mkdirSync(join(svcRoot, '设定'), { recursive: true })
const svc = new DocumentService({ bookRoot: svcRoot })
const svcRel = '设定/soak.md'
const svcCreated = await svc.createDocument({ relPath: svcRel, content: '---\n名称: soak\n---\n初稿' })
if (!svcCreated.ok) {
  console.error(`[soak] FAIL：service 装置 createDocument 失败（${svcCreated.code}）——soak 输入本身失效。`)
  rmSync(svcDir, { recursive: true, force: true })
  process.exit(1)
}
const svcDocId = svcCreated.docId
let svcRev = svcCreated.revision
async function svcSaveOnce(i: number): Promise<void> {
  const s = await svc.save(svcDocId, svcRel, {
    content: `---\n名称: soak\n---\n\n第 ${i} 次保存：正文段落若干，字数口径稳定不塌缩。\n`.repeat(3),
    expectedRevision: svcRev,
    operationId: `soak-${i}`,
    origin: 'manual',
  })
  if (!s.ok) {
    console.error(`[soak] FAIL：service 装置 save 失败（${s.code}：${s.reason}）——soak 输入本身失效。`)
    rmSync(svcDir, { recursive: true, force: true })
    process.exit(1)
  }
  svcRev = s.revision
}
for (let i = 0; i < Math.min(30, SVC_ITER); i++) await svcSaveOnce(i)
const svcBaseline = settledHeapUsed()
for (let i = 30; i < SVC_ITER; i++) await svcSaveOnce(i)
const svcFinal = settledHeapUsed()
if (!readFileSync(join(svcRoot, ...svcRel.split('/')), 'utf-8').includes(`第 ${SVC_ITER - 1} 次保存`)) {
  console.error('[soak] FAIL：service 终态盘面与最后保存不符——soak 输入本身失效。')
  rmSync(svcDir, { recursive: true, force: true })
  process.exit(1)
}
rmSync(svcDir, { recursive: true, force: true })

const svcGrowthMb = (svcFinal - svcBaseline) / (1024 * 1024)
console.log(
  `[soak] service save 链迭代 ${SVC_ITER} 次 · 基线 ${(svcBaseline / 1048576).toFixed(2)}MB · ` +
    `终值 ${(svcFinal / 1048576).toFixed(2)}MB · 增长 ${svcGrowthMb.toFixed(2)}MB · 上界 ${SVC_BOUND_MB}MB`,
)
if (svcFinal - svcBaseline > SVC_BOUND_MB * 1024 * 1024) {
  console.error(
    `[soak] FAIL：service save 链 heapUsed 增长 ${svcGrowthMb.toFixed(2)}MB 超上界 ${SVC_BOUND_MB}MB——疑似索引/日志累积线性泄漏。`,
  )
  process.exit(1)
}
console.log('[soak] OK：service save 链循环无显著内存增长。')

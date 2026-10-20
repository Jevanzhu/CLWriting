#!/usr/bin/env node
/**
 * harness 采用面申报对账门——副本版本号 + 四份空判据门的申报。
 *
 * 两件文档已声明、此前只靠自律的事，本门升级为机器可判：
 *
 *   1. **副本版本**：`.agents/skills/VERSION`（副本版本号单源）与
 *      `scripts/harness/version.json`（安装来源版本）必须相等。上游替换副本后忘了
 *      刷新 version.json，「手上这一套装的是哪一版」就答错——而两个号都写在文档里，
 *      错的正是被查的那一处。
 *
 *   2. **空判据门**：本仓不接线 harness 的 comment-hygiene / test-hygiene /
 *      doc-budgets / doc-claims（各自的面归自建 check），manifest 空置是**申报**而非
 *      漏配。申报（形状 + 理由）写在本文件 DECLARED_EMPTY，与实文不符即红——两种漂移
 *      都拦：空置被填上（面已开启而申报没跟上）、已接线的清单被清空（静默失去覆盖）。
 *      判据是命令可读的事实，散文宣称不进本门（诚实边界见 05-规范 §八）。
 *
 * 用法：npm run check:harness-copy（退出码 1 = 失配，并列出问题）
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// 仓根锚定单源 = ./repo-root.mjs（本档位置锚定，不取 cwd）
import { REPO_ROOT as root } from './repo-root.mjs'

const HARNESS_DIR = 'scripts/harness'
const VERSION_JSON = `${HARNESS_DIR}/version.json`
const COPY_VERSION = '.agents/skills/VERSION'

/**
 * 空判据门申报：文件 → 申报的空置形状与理由。
 *
 * `shape` 取 `empty-object`（`{}`，harness 定的刻意空声明形态）或 `empty-claims`
 * （`{"claims": []}`，doc-claims 的解析器认这个形态，让空置在文件里自证是刻意）。
 * 新增/停用一条采用面 = 同批改本表：门面一旦开启，这里就不能再写「空置」。
 */
export const DECLARED_EMPTY = [
  {
    file: `${HARNESS_DIR}/comment-hygiene.manifest.json`,
    shape: 'empty-object',
    reason: '注释面归自建 check:comments（按路径排除副本面，规则面强于起步形状）',
  },
  {
    file: `${HARNESS_DIR}/test-hygiene.manifest.json`,
    shape: 'empty-object',
    reason: '测试面（.only / 无条件 .skip）归 check:counts 的 AST 扫描',
  },
  {
    file: `${HARNESS_DIR}/doc-budgets.manifest.json`,
    shape: 'empty-object',
    reason: '篇幅归自建 check:docs——词数总量拦不住行文变水，本仓用单行长度细口径',
  },
  {
    file: `${HARNESS_DIR}/doc-claims.manifest.json`,
    shape: 'empty-claims',
    reason: '数字声称归自建 check:counts；形状写成 {"claims": []} 让空置在文件里自证是刻意',
  },
]

const SEMVER = /^\d+\.\d+\.\d+$/

/** 副本版本对账：两个号都必须像版本号，且相等。 */
export function problemsForCopyVersion(copyVersion, harnessVersion) {
  const problems = []
  const bad = (where, value) =>
    problems.push(`${where} 内容不是语义版本号：${JSON.stringify(value)}（此号是「装的是哪一版」的单一来源）`)
  if (typeof copyVersion !== 'string' || !SEMVER.test(copyVersion.trim())) bad(COPY_VERSION, copyVersion)
  if (typeof harnessVersion !== 'string' || !SEMVER.test(harnessVersion.trim())) bad(VERSION_JSON, harnessVersion)
  if (problems.length > 0) return problems
  if (copyVersion.trim() !== harnessVersion.trim()) {
    problems.push(
      `副本版本对不上：${COPY_VERSION} 是 ${copyVersion.trim()}，${VERSION_JSON} 是 ${harnessVersion.trim()}` +
        '——副本整体替换后须同批刷新 version.json，别让「装的是哪一版」留下两个答案',
    )
  }
  return problems
}

/** 解析形态描述，用于失配信息（让修的人一眼看出实文长什么样）。 */
function describeShape(value) {
  if (Array.isArray(value)) return `数组（${value.length} 项）`
  if (value === null) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  const keys = Object.keys(value)
  return keys.length === 0 ? '空对象 {}' : `对象（字段 ${keys.join(' / ')}）`
}

/**
 * 空判据门申报 ↔ 实文对账。
 *
 * `actual` = 仓库里实读到的 `scripts/harness/*.manifest.json`（相对路径 → JSON.parse 结果）。
 * 未申报却空置的 manifest 单独报——空置必须显式声明，否则「门没在查」和「门查过没事」
 * 在输出里长得一样（skipped 伪装成 passed 是本门禁体系最危险的失败模式）。
 */
export function problemsForManifestShapes(actual) {
  const problems = []
  const declared = new Map(DECLARED_EMPTY.map((entry) => [entry.file, entry]))

  for (const entry of DECLARED_EMPTY) {
    if (!(entry.file in actual)) {
      problems.push(`${entry.file} 读不到：申报为空判据门，文件须在位（缺文件 = 门在静默消失）`)
      continue
    }
    const value = actual[entry.file]
    const isEmptyObject =
      typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0
    const isEmptyClaims =
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Array.isArray(value.claims) &&
      value.claims.length === 0
    const ok = entry.shape === 'empty-object' ? isEmptyObject : isEmptyClaims
    if (!ok) {
      problems.push(
        `${entry.file} 实文是 ${describeShape(value)}，与申报的空置形状不符——` +
          `该面已开启（或形状变了），请同步本文件的申报（理由原为：${entry.reason}）`,
      )
    }
  }

  for (const [file, value] of Object.entries(actual)) {
    if (declared.has(file)) continue
    const isEmpty =
      typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0
    if (isEmpty) {
      problems.push(`${file} 空置但未申报——空判据门必须显式声明并给出理由（见本文件 DECLARED_EMPTY）`)
    }
  }
  return problems
}

function readText(rel) {
  try {
    return { text: readFileSync(join(root, rel), 'utf8') }
  } catch (error) {
    return { error: `${rel} 读不到：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 副本校验器「装进来了」与「真在跑」的对账。
 *
 * 为什么需要这一条：副本整体替换（上游升版）会把新的 `verify-*.ts` 一起拷进来，但
 * `run-gates.ts` 的门表是**上游声明的清单**——新增校验器若上游没有同时加进某个 mode，
 * 文件在盘上、却没有任何模式会跑它。此时「副本完整」与「门全绿」两句话同时为真，而那
 * 块面其实没人查。这是静默失去覆盖，与「门没配」长得一样。
 *
 * 判据两侧都取实文、不做声明：磁盘 = `scripts/harness/verify-*.ts` 文件清单；
 * 接线 = `run-gates.ts` 里 `join(HARNESS, '…')` 的实参文本（gate 定义只此一种写法，
 * `HARNESS` 常量专为该用途存在）。只读副本、不改副本——不动上游字节契约。
 *
 * 反向也判：接线指向一个盘上没有的文件，等于门在跑一个不存在的脚本。
 *
 * @param {readonly string[]} onDisk 盘上的 verify-*.ts 文件名（含扩展名）
 * @param {readonly string[]} wired  run-gates.ts 里被 join(HARNESS, …) 引用的文件名
 */
export function problemsForVerifierWiring(onDisk, wired) {
  const problems = []
  const disk = new Set(onDisk)
  const running = new Set(wired)
  for (const name of [...disk].sort()) {
    // 扩展名在门表里必须写全（join 不做模块解析），故按文件名整体对账
    if (!running.has(name)) {
      problems.push(
        `${HARNESS_DIR}/${name} 在盘上但没有任何门跑它——副本带来了新校验器而 run-gates.ts 的门表` +
          `没接线。要么在上游把它加进某个 mode 后刷新副本，要么在本仓门表里接线；` +
          `「文件在位」不等于「这块面在查」`,
      )
    }
  }
  for (const name of [...running].sort()) {
    if (!disk.has(name)) {
      problems.push(
        `${HARNESS_DIR}/run-gates.ts 接线的 ${name} 在盘上不存在——门会去跑一个没有的脚本，` +
          `副本不完整，或门表指向了改名后的旧名`,
      )
    }
  }
  return problems
}

/**
 * 从 run-gates.ts 正文抽出被接线的校验器文件名（纯函数，供直测）。
 *
 * 只认 `join(HARNESS, 'x')` 这一种实参形态：gate 定义的 args 是该常量唯一的使用面，
 * 按形态取而不是全文搜 `verify-`，避免注释里提到的名字被当成接线。
 */
export function wiredVerifiersFrom(source) {
  const out = []
  for (const m of source.matchAll(/join\(\s*HARNESS\s*,\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (m[1] !== undefined) out.push(m[1])
  }
  return out
}

function main() {
  const problems = []

  const copy = readText(COPY_VERSION)
  const harness = readText(VERSION_JSON)
  if (copy.error !== undefined) problems.push(copy.error)
  if (harness.error !== undefined) problems.push(harness.error)

  let harnessVersion
  if (harness.text !== undefined) {
    try {
      harnessVersion = JSON.parse(harness.text).version
    } catch (error) {
      problems.push(`${VERSION_JSON} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (copy.error === undefined && harnessVersion !== undefined) {
    problems.push(...problemsForCopyVersion(copy.text.trim(), harnessVersion))
  }

  const actual = {}
  let names
  try {
    names = readdirSync(join(root, HARNESS_DIR)).filter((name) => name.endsWith('.manifest.json'))
  } catch (error) {
    problems.push(`${HARNESS_DIR} 读不到：${error instanceof Error ? error.message : String(error)}`)
    names = []
  }
  for (const name of names) {
    const rel = `${HARNESS_DIR}/${name}`
    const read = readText(rel)
    if (read.error !== undefined) {
      problems.push(read.error)
      continue
    }
    try {
      actual[rel] = JSON.parse(read.text)
    } catch (error) {
      problems.push(`${rel} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  problems.push(...problemsForManifestShapes(actual))

  // 接线对账：盘上的校验器 must 都在门表里（见 problemsForVerifierWiring 头注）
  let onDisk = []
  try {
    onDisk = readdirSync(join(root, HARNESS_DIR)).filter((name) => name.startsWith('verify-') && name.endsWith('.ts'))
  } catch (error) {
    problems.push(`${HARNESS_DIR} 读不到校验器清单：${error instanceof Error ? error.message : String(error)}`)
  }
  const gates = readText(`${HARNESS_DIR}/run-gates.ts`)
  if (gates.error !== undefined) {
    problems.push(gates.error)
  } else {
    problems.push(...problemsForVerifierWiring(onDisk, wiredVerifiersFrom(gates.text)))
  }

  if (problems.length > 0) {
    console.error('check:harness-copy 失配：')
    for (const problem of problems) console.error(`  ${problem}`)
    process.exit(1)
  }
  console.log(
    `check:harness-copy 通过：副本版本 ${copy.text.trim()} 与 ${VERSION_JSON} 一致；` +
      `${DECLARED_EMPTY.length} 份空判据门实文与申报一致；` +
      `${onDisk.length} 个校验器全部接线。`,
  )
}

// 直跑判定读路径（不读 import.meta.main——旧 Node 上恒为假会静默退出 0）；
// import（如用例直测纯函数）不产生副作用。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()

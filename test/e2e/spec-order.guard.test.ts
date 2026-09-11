/**
 * R27-122（二十七轮）：E2E_SPEC_ORDER_SNAPSHOT 守卫落地——此前它是 playwright.config.ts
 * retries:0 注释里宣称却全仓库不存在的幻影防线。e2e 29 specs 共享 globalSetup 单一
 * workDir、按文件名字典序固有顺序跑（前序 spec 落盘是后序输入），新增/改名/删除 spec
 * 即漂移该契约而无人设防。本测试把 test/e2e/*.spec.ts 实际序列与 spec-order.snapshot.txt
 * 快照比对，漂移即红，迫使改序者确认有意后显式重拍快照。
 *
 * 重评-3（全库代码重评审 2026-09-05）：重拍通道改两步闸（非交互式）——原
 * CLW_UPDATE_SPEC_ORDER_SNAPSHOT=1 单变量即静默重拍唯一真相源，误触发/无脑重拍
 * 无任何闸。现：UPDATE=1 且快照将实际变化、但未设第二确认变量
 * CLW_UPDATE_SPEC_ORDER_SNAPSHOT_CONFIRM=1 时，测试失败并打印将写入的新顺序清单 +
 * 变更说明 + 「重拍后必须连跑完整 e2e」警示；两变量齐备才写入。快照无变化时
 * UPDATE=1 幂等通过（不写入、不打扰）。两步用法：
 *
 *   # 第一步：预览（测试红，列出变更与新顺序，不写任何文件）
 *   CLW_UPDATE_SPEC_ORDER_SNAPSHOT=1 npx vitest run test/e2e/spec-order.guard.test.ts
 *   # 第二步：确认写入
 *   CLW_UPDATE_SPEC_ORDER_SNAPSHOT=1 CLW_UPDATE_SPEC_ORDER_SNAPSHOT_CONFIRM=1 \
 *     npx vitest run test/e2e/spec-order.guard.test.ts
 *   # 写入后必须连跑完整 e2e（npx playwright test）验证新顺序契约可执行
 *
 * 放 test/e2e/ 但 Playwright 不收集：*.test.ts 本会命中 Playwright 默认 testMatch、
 * 被收成第 30 个 spec 破坏 29-spec 顺序契约，已在 playwright.config.ts 用 testIgnore
 * 排除本文件；vitest 侧由 include（test/ 下的 *.test.ts，见 vitest.config.ts）自然纳管。
 * （vitest helpers 的 mkdtempTracked 顶层 import vitest 与 Playwright 语境互斥，本文件
 * 是 vitest 用例、纯 fs 比对无临时目录，不涉该取舍。）
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
// R0911-G-P3-3：运行期探针 reporter 的纯函数直测（reporter 模块零 playwright 运行时
// 依赖——类型自持，vitest 侧可直 import；onBegin/onEnd 只在真实 e2e 由 config 挂载跑）
import SpecOrderReporter, { plannedSpecOrderFromSuite, specOrderDriftLines } from './spec-order.reporter.js'

const e2eDir = dirname(fileURLToPath(import.meta.url))
const SNAPSHOT_PATH = join(e2eDir, 'spec-order.snapshot.txt')
const UPDATE_ENV = 'CLW_UPDATE_SPEC_ORDER_SNAPSHOT'
const CONFIRM_ENV = 'CLW_UPDATE_SPEC_ORDER_SNAPSHOT_CONFIRM'

/** 当前固有顺序：test/e2e 扁平目录下的 *.spec.ts 文件名，localeCompare 序
 *  （R28-27：镜像 Playwright 的收集序——playwright/lib/runner 用
 *  `entries.sort((a,b)=>a.name.localeCompare(b.name))` 排 spec 文件；此前守卫用
 *  Array.prototype.sort 默认码元序，纯小写 ASCII 名下两序恰同，未来混入大小写/
 *  标点的新 spec 时守卫序会与实际执行序分叉而照绿，故显式同基）。 */
function currentSpecOrder(): string[] {
  return readdirSync(e2eDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.spec.ts'))
    .map((entry) => entry.name)
    // R43-29（四十三轮）：钉显式 locale 'en'——快照序按 en collation 锁定，与 Playwright
    // 收集序的镜像假设不再随宿主默认 locale（zh-CN/en/…）漂移分叉。排查同款排序：
    // grep localeCompare 于 scripts/check-counts.mjs 仅命中注释，其 diffSpecOrder 用
    // 默认 .sort() 且 added/removed 按成员判定（序不进结果），无 localeCompare 调用，
    // 不需对齐。现快照全为小写 ASCII+连字符名，en 与原默认序一致，重拍前后不变。
    .sort((a, b) => a.localeCompare(b, 'en'))
}

/** 读快照为行序；文件不存在返回 null（首拍/快照被误删场景，读失败不再以 ENOENT 裸抛） */
function readSnapshotOrder(): string[] | null {
  if (!existsSync(SNAPSHOT_PATH)) return null
  return readFileSync(SNAPSHOT_PATH, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** 序差异说明（重评-3）：改名 = 一增一移除；集合相同仅次序不同 = 顺序漂移（移动） */
function diffLines(current: string[], baseline: string[]): string[] {
  const added = current.filter((n) => !baseline.includes(n))
  const removed = baseline.filter((n) => !current.includes(n))
  const out: string[] = []
  if (added.length > 0) out.push(`  新增：${added.join('、')}`)
  if (removed.length > 0) out.push(`  移除：${removed.join('、')}`)
  if (added.length === 0 && removed.length === 0) out.push('  集合未变、顺序漂移（移动）——前序 spec 落盘是后序输入，确认移动不破坏依赖链')
  return out
}

/**
 * 守卫核心（重评-3 抽出为可注入纯函数：fs 读写以参数传入，文件底部新增用例在内存
 * 模拟三场景、不触真快照；真实比对/写入语义与本函数一一对应）。名单比对（toEqual）
 * 与 locale 钉定（currentSpecOrder，R28-27/R43-29）语义零变更。
 * 返回 'written'（已重拍）| 'unchanged'（比对通过或幂等）；契约破坏/闸拦截以异常抛出。
 */
function enforceSpecOrder(opts: {
  update: boolean
  confirm: boolean
  current: string[]
  baseline: string[] | null
  write: (current: string[]) => void
}): 'written' | 'unchanged' {
  const { update, confirm, current, baseline, write } = opts
  if (!update) {
    // 既有守卫主路径：实际序列与快照逐一比对（原 R27-122 语义）
    expect(
      current,
      baseline === null
        ? `快照不存在（${SNAPSHOT_PATH}）。首拍或快照被误删时按两步闸生成：` +
            `先 ${UPDATE_ENV}=1 预览，确认后叠加 ${CONFIRM_ENV}=1 写入。`
        : 'e2e spec 集合漂移了顺序契约（新增/改名/删除 spec 都会改固有顺序，' +
            '前序 spec 落盘是后序输入）。唯一真相源 = test/e2e/spec-order.snapshot.txt，' +
            '确认改动有意后两步重拍：先 ' +
            `${UPDATE_ENV}=1 npx vitest run test/e2e/spec-order.guard.test.ts 预览` +
            `（测试红并列出变更），再叠加 ${CONFIRM_ENV}=1 写入；重拍后必须连跑完整 e2e。`,
    ).toEqual(baseline ?? [])
    return 'unchanged'
  }
  // 重拍通道（重评-3 两步闸）：快照与当前序一致 → 幂等通过，不写入不打扰
  if (
    baseline !== null &&
    baseline.length === current.length &&
    baseline.every((name, i) => name === current[i])
  ) {
    console.log(
      `[spec-order-guard] 快照与当前固有顺序一致（${current.length} specs），幂等通过，未写入`,
    )
    return 'unchanged'
  }
  if (!confirm) {
    // 两步闸第一步：拦截——单 UPDATE 不再静默重拍，打印将写入清单 + 变更 + 警示
    throw new Error(
      `[spec-order-guard] 两步闸拦截：${UPDATE_ENV}=1 将重拍唯一真相源` +
        `（test/e2e/spec-order.snapshot.txt）且快照将实际变化，需第二确认变量 ` +
        `${CONFIRM_ENV}=1 才写入。\n\n` +
        `将写入的新顺序（${current.length} specs）：\n  ${current.join('\n  ')}\n\n` +
        `变更说明：\n${baseline === null ? '  快照不存在（首拍）' : diffLines(current, baseline).join('\n')}\n\n` +
        `确认无误后二次执行（两变量齐备才写入）：\n` +
        `  ${UPDATE_ENV}=1 ${CONFIRM_ENV}=1 npx vitest run test/e2e/spec-order.guard.test.ts\n\n` +
        `警示：重拍只是登记新契约，不证明契约可执行——写入后必须连跑完整 e2e ` +
        `（npx playwright test）验证固有顺序下前序 spec 落盘仍是后序输入。`,
    )
  }
  write(current)
  console.log(
    `[spec-order-guard] 快照已重拍：${current.length} specs → ${SNAPSHOT_PATH}` +
      `。重拍后必须连跑完整 e2e（npx playwright test）验证新顺序契约可执行。`,
  )
  return 'written'
}

it('e2e spec 顺序契约：*.spec.ts 序列与快照一致（E2E_SPEC_ORDER_SNAPSHOT）', () => {
  enforceSpecOrder({
    update: process.env[UPDATE_ENV] === '1',
    confirm: process.env[CONFIRM_ENV] === '1',
    current: currentSpecOrder(),
    baseline: readSnapshotOrder(),
    write: (lines) => writeFileSync(SNAPSHOT_PATH, lines.join('\n') + '\n'),
  })
})

// ---- 重评-3（全库代码重评审 2026-09-05）两步闸用例：内存模拟，不读不写真快照 ----

const BASE_ORDER = ['aa-create-book.spec.ts', 'bb-write.spec.ts', 'zz-read.spec.ts']

it('重评-3 两步闸：有变化 + 仅 UPDATE → 拦截失败，输出新顺序清单与确认指引，不写入', () => {
  let written = false
  const drifted = [...BASE_ORDER, 'mm-new-spec.spec.ts'] // 新增 spec → 集合变化
  let thrown: unknown
  try {
    enforceSpecOrder({
      update: true,
      confirm: false,
      current: drifted,
      baseline: BASE_ORDER,
      write: () => {
        written = true
      },
    })
  } catch (e) {
    thrown = e
  }
  expect(thrown).toBeInstanceOf(Error)
  const msg = (thrown as Error).message
  // 指引：确认变量名 + 完整两步命令形态
  expect(msg).toContain(CONFIRM_ENV)
  expect(msg).toContain(`${UPDATE_ENV}=1 ${CONFIRM_ENV}=1`)
  // 将写入的新顺序清单逐名在列（含新增 spec）
  expect(msg).toContain('将写入的新顺序（4 specs）')
  expect(msg).toContain('mm-new-spec.spec.ts')
  // 变更说明 + 重拍后警示
  expect(msg).toContain('新增：mm-new-spec.spec.ts')
  expect(msg).toContain('完整 e2e')
  // 闸拦截时绝不可有写副作用
  expect(written).toBe(false)
})

it('重评-3 两步闸：有变化 + UPDATE+CONFIRM → 正常写入新顺序', () => {
  let written: string[] | null = null
  const drifted = [BASE_ORDER[1]!, BASE_ORDER[0]!, BASE_ORDER[2]!] // 纯顺序漂移（移动）
  const outcome = enforceSpecOrder({
    update: true,
    confirm: true,
    current: drifted,
    baseline: BASE_ORDER,
    write: (lines) => {
      written = lines
    },
  })
  expect(outcome).toBe('written')
  expect(written).toEqual(drifted)
})

it('重评-3 两步闸：无变化 + 仅 UPDATE → 幂等通过，不写入不打扰', () => {
  let written = false
  const outcome = enforceSpecOrder({
    update: true,
    confirm: false,
    current: BASE_ORDER,
    baseline: BASE_ORDER,
    write: () => {
      written = true
    },
  })
  expect(outcome).toBe('unchanged')
  expect(written).toBe(false)
})

// ── R0911-G-P3-3（2026-09-11 全量重评 GLM-5.3 修复批）：运行期探针 reporter 的纯函数直测 ──
// （spec-order.reporter.ts 由 playwright.config.ts 挂载，onBegin/onEnd 只在真实 e2e
// 跑；两个纯函数在 vitest 侧锚定语义）
describe('R0911-G-P3-3：spec-order reporter 纯函数（运行期探针的比对内核）', () => {
  it('plannedSpecOrderFromSuite：按文件去重保序（跨 spec 多用例只记一次，顺序=allTests 首见序）', () => {
    const mk = (file: string) => ({ location: { file: `/repo/test/e2e/${file}` } })
    const out = plannedSpecOrderFromSuite([mk('aa.spec.ts'), mk('aa.spec.ts'), mk('cc.spec.ts'), mk('bb.spec.ts'), mk('aa.spec.ts')])
    expect(out).toEqual(['aa.spec.ts', 'cc.spec.ts', 'bb.spec.ts'])
  })

  it('specOrderDriftLines：一致 → 空；新增/移除/纯顺序漂移三形态各自成行', () => {
    const base = ['aa.spec.ts', 'bb.spec.ts', 'cc.spec.ts']
    expect(specOrderDriftLines([...base], base)).toEqual([])
    expect(specOrderDriftLines([...base, 'dd.spec.ts'], base)).toEqual(['  实际执行序多出：dd.spec.ts'])
    expect(specOrderDriftLines(base.slice(0, 2)!, base)).toEqual(['  快照有而实际未收集：cc.spec.ts'])
    expect(specOrderDriftLines(['bb.spec.ts', 'aa.spec.ts', 'cc.spec.ts'], base)).toEqual([
      '  集合相同、顺序不同——Playwright 收集序与快照分叉（localeCompare 镜像假设失效，或 spec 集漂移未重拍）',
    ])
  })
})

// ── R0911-G-P3-3 补：reporter 门行为直测（锚 onEnd 返回 { status: 'failed' } 机制）──
// 首版实现在此处翻过车：onBegin 单参声明把 config 收成 suite（allTests undefined）、
// onEnd 用 throw——playwright 对 reporter 异常只记「Error in reporter」日志且退出码
// 仍 0，门形失效。本组用例把两个签名口径钉进回归（playwright 1.57 探针实测）。
describe('R0911-G-P3-3：spec-order reporter 门行为（防回退成抛错/单参签名）', () => {
  const mkTests = (files: string[]) => files.map((f) => ({ location: { file: `/fake/e2e/${f}` } }))
  const snapshot = readSnapshotOrder()

  it.skipIf(snapshot === null)(
    '双参 onBegin(config, suite) 收集计划序；序与快照一致 → onEnd 不判失败（返回 undefined）',
    () => {
      const r = new SpecOrderReporter()
      r.onBegin({ workers: 1 }, { allTests: () => mkTests(snapshot!) })
      expect(r.onEnd()).toBeUndefined()
    },
  )

  it.skipIf(snapshot === null)(
    '序漂移 → onEnd 返回 { status: "failed" }（整轮退出码 1 的官方通道）并留痕 console.error',
    () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const base = snapshot!
        const drifted =
          base.length > 1 ? [...base.slice(1), base[0]!] : [...base, 'zz-extra-drift.spec.ts']
        const r = new SpecOrderReporter()
        r.onBegin({}, { allTests: () => mkTests(drifted) })
        expect(r.onEnd()).toEqual({ status: 'failed' })
        expect(errSpy).toHaveBeenCalled()
      } finally {
        errSpy.mockRestore()
      }
    },
  )
})

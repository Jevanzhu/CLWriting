// R0911-G-P3-3（2026-09-11 全量重评 GLM-5.3 修复批）：e2e 顺序契约运行期探针 reporter。
// 类型面照 first-cause-reporter.ts R73-76 口径——playwright 对外类型随版本漂移，
// 用结构化最小类型自持（reporter 由 config 以路径字符串挂载，运行时只按形状调用）。
// 签名实测口径（playwright 1.57，探针核过）：onBegin(config, suite) 双参——首参是
// config 对象（无 allTests），套件在第二参；onEnd 返回 { status: 'failed' } 可把整轮
// 结果改判失败（Multiplexer.onEnd 逐 reporter 取 outResult.status 回写 run 状态 →
// 退出码 1）——throw 会被包成「Error in reporter」日志且不改退出码（探针证伪过
// process.exitCode 与 onExit 改码两条路，均被 playwright 终态覆写），勿回退成抛错。
interface ReporterLike {
  onBegin?(config: unknown, suite: SuiteLike): void
  onEnd?(): { status: 'failed' } | void
}
interface SuiteLike {
  allTests(): TestCaseLike[]
}
interface TestCaseLike {
  location: { file: string }
}
// vitest 侧直测（spec-order.guard.test.ts）import 本模块：fs/path/url 均无害，
// playwright 类型零依赖（上面的 interface 是本地声明，不 import '@playwright/test'）。
import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SNAPSHOT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'spec-order.snapshot.txt')

/**
 * 计划执行序：Playwright onBegin 的 suite.allTests()（含 skipped 用例，workers:1 下
 * 即真实执行序）按文件名去重保序。纯函数导出供 vitest 侧直测。
 */
export function plannedSpecOrderFromSuite(tests: ReadonlyArray<TestCaseLike>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tests) {
    const name = basename(t.location.file)
    if (!seen.has(name)) {
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

/**
 * 实际序 ↔ 快照序的失配行（空 = 一致）。纯函数导出供 vitest 侧直测；语义对齐
 * spec-order.guard.test.ts 的 diffLines（新增/移除/纯顺序漂移三分支）。
 */
export function specOrderDriftLines(actual: string[], baseline: string[]): string[] {
  const added = actual.filter((n) => !baseline.includes(n))
  const removed = baseline.filter((n) => !actual.includes(n))
  const movedOnly = added.length === 0 && removed.length === 0 && actual.join('\n') !== baseline.join('\n')
  const out: string[] = []
  if (added.length > 0) out.push(`  实际执行序多出：${added.join('、')}`)
  if (removed.length > 0) out.push(`  快照有而实际未收集：${removed.join('、')}`)
  if (movedOnly) {
    out.push('  集合相同、顺序不同——Playwright 收集序与快照分叉（localeCompare 镜像假设失效，或 spec 集漂移未重拍）')
  }
  return out
}

/**
 * 动机：vitest 侧守卫（spec-order.guard.test.ts）用 localeCompare 镜像 Playwright
 * 内部收集序，镜像假设此前无任何运行期验证——Playwright 升级改排序实现即静默分叉，
 * 守卫照绿而真实执行序已变。本 reporter 在每轮真实 e2e 里拿 Playwright 自排的计划
 * 执行序对快照逐行比对，分叉当场红（onEnd 返回 { status: 'failed' } → 整轮退出码
 * 1，机制见文件头注）。与 vitest 侧守卫互补：那边管「磁盘名单 ↔ 快照」，这边管
 * 「Playwright 实际收集序 ↔ 快照」，两侧合围即磁盘 ↔ 真实执行序传递闭合。
 */
export default class SpecOrderReporter implements ReporterLike {
  private planned: string[] = []

  onBegin(_config: unknown, suite: SuiteLike): void {
    this.planned = plannedSpecOrderFromSuite(suite.allTests())
  }

  onEnd(): { status: 'failed' } | void {
    let baseline: string[] | null = null
    try {
      baseline = readFileSync(SNAPSHOT_PATH, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
    } catch {
      baseline = null
    }
    if (baseline === null) {
      console.error(
        `[spec-order-reporter] 快照不存在（${SNAPSHOT_PATH}）——先按守卫两步闸生成（用法见 test/e2e/spec-order.guard.test.ts 头注）`,
      )
      return { status: 'failed' }
    }
    const drift = specOrderDriftLines(this.planned, baseline)
    if (drift.length > 0) {
      console.error(
        '[spec-order-reporter] Playwright 实际收集序与快照失配（R0911-G-P3-3 运行期探针）——\n' +
          drift.join('\n') +
          `\n  实际序（${this.planned.length} specs）：\n  ${this.planned.join('\n  ')}\n` +
          '  确认有意后走守卫两步闸重拍快照（CLW_UPDATE_SPEC_ORDER_SNAPSHOT=1 预览 → 叠加 CONFIRM 写入），重拍后必须连跑完整 e2e。',
      )
      return { status: 'failed' }
    }
  }
}

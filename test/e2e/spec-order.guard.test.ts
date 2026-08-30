/**
 * R27-122（二十七轮）：E2E_SPEC_ORDER_SNAPSHOT 守卫落地——此前它是 playwright.config.ts
 * retries:0 注释里宣称却全仓库不存在的幻影防线。e2e 29 specs 共享 globalSetup 单一
 * workDir、按文件名字典序固有顺序跑（前序 spec 落盘是后序输入），新增/改名/删除 spec
 * 即漂移该契约而无人设防。本测试把 test/e2e/*.spec.ts 实际序列与 spec-order.snapshot.txt
 * 快照比对，漂移即红，迫使改序者确认有意后显式重拍快照：
 *
 *   CLW_UPDATE_SPEC_ORDER_SNAPSHOT=1 npx vitest run test/e2e/spec-order.guard.test.ts
 *
 * 放 test/e2e/ 但 Playwright 不收集：*.test.ts 本会命中 Playwright 默认 testMatch、
 * 被收成第 30 个 spec 破坏 29-spec 顺序契约，已在 playwright.config.ts 用 testIgnore
 * 排除本文件；vitest 侧由 include（test/ 下的 *.test.ts，见 vitest.config.ts）自然纳管。
 * （vitest helpers 的 mkdtempTracked 顶层 import vitest 与 Playwright 语境互斥，本文件
 * 是 vitest 用例、纯 fs 比对无临时目录，不涉该取舍。）
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const e2eDir = dirname(fileURLToPath(import.meta.url))
const SNAPSHOT_PATH = join(e2eDir, 'spec-order.snapshot.txt')
const UPDATE_ENV = 'CLW_UPDATE_SPEC_ORDER_SNAPSHOT'

/** 当前固有顺序：test/e2e 扁平目录下的 *.spec.ts 文件名，localeCompare 序
 *  （R28-27：镜像 Playwright 的收集序——playwright/lib/runner 用
 *  `entries.sort((a,b)=>a.name.localeCompare(b.name))` 排 spec 文件；此前守卫用
 *  Array.prototype.sort 默认码元序，纯小写 ASCII 名下两序恰同，未来混入大小写/
 *  标点的新 spec 时守卫序会与实际执行序分叉而照绿，故显式同基）。 */
function currentSpecOrder(): string[] {
  return readdirSync(e2eDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.spec.ts'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
}

it('e2e spec 顺序契约：*.spec.ts 序列与快照一致（E2E_SPEC_ORDER_SNAPSHOT）', () => {
  const current = currentSpecOrder()
  // 重拍通道：显式 env 才写快照，避免误触发
  if (process.env[UPDATE_ENV] === '1') {
    writeFileSync(SNAPSHOT_PATH, current.join('\n') + '\n')
    console.log(`[spec-order-guard] 快照已重拍：${current.length} specs → ${SNAPSHOT_PATH}`)
    return
  }
  const baseline = readFileSync(SNAPSHOT_PATH, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  expect(
    current,
    'e2e spec 集合漂移了顺序契约（新增/改名/删除 spec 都会改固有顺序，' +
      '前序 spec 落盘是后序输入）。唯一真相源 = test/e2e/spec-order.snapshot.txt，' +
      '确认改动有意后重拍：' +
      `${UPDATE_ENV}=1 npx vitest run test/e2e/spec-order.guard.test.ts`,
  ).toEqual(baseline)
})

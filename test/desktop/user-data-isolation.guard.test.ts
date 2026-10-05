/**
 * 真实用户数据隔离守卫（2026-10-02 实事故立档）。
 *
 * 事故形态：多库多窗把 workdir.json 的解析从 electron `app.getPath('userData')` 改为
 * `appDataHomeDir()`（共享根）后，test/desktop/workdir-read-failure-write-guard.test.ts
 * 只假件了 electron——「临时 userData」进的是 app.getPath，storePath() 实际落到真实
 * ~/Library/Application Support/CLWriting/workdir.json，用例写盘把作者真实书库指针
 * 覆写成测试值（current='/libs/C'，recent 混入测试条目）。
 *
 * 本守卫把「desktop 测试触达 storePath 链时必须隔离路径源」从口头纪律升为机器门：
 * 凡**真实导入**会走到 storePath()/appDataHomeDir() 的模块（main / ipc / lifecycle /
 * workdir-controller）的测试文件，必须至少具备三条隔离之一：
 *   1. vi.mock('…/src/desktop/workdir-controller.js')——整模块假件，链断在导入处；
 *   2. vi.mock('…/src/fs/user-data-path.js')——路径源假件（appDataHomeDir → 临时目录）；
 *   3. 引 main-fixtures——共享夹具内已含 user-data-path 假件（单源）。
 * 三者皆无 → 该文件一旦触发写盘即写真实用户数据，本用例红并列出名单。
 *
 * 静态文本断言而非行为断言（同 main-instance-guard-dual-flag 先例）：零 Electron
 * 依赖、零盘面副作用——守卫自身绝不碰真实 userData。type-only 导入不执行模块体，
 * 不判危险（负向断言在正则内）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DESKTOP_TEST_DIR = join(import.meta.dirname, '.')

/** 守卫自身（只读文本、零导入）不在扫描面内——其正反例字符串含危险导入原文 */
const SELF = 'user-data-isolation.guard.test.ts'

/** 真实导入危险模块的形态：`import … from '…/src/desktop/<risky>.js'` 或
 *  `await import('…')`；vi.mock(...) 行不是 import，不判危险。type-only 导入排除。 */
const RISKY_IMPORT_RE =
  /(?:^\s*import(?!\s+type\b)[\s\S]{0,300}?from\s*|await\s+import\()\s*['"][^'"]*src\/desktop\/(?:main|ipc|lifecycle|workdir-controller)\.js['"]/m

/** 三条隔离路径（任一具备即安全） */
const ISOLATION_RES = [
  /vi\.mock\(\s*['"][^'"]*src\/desktop\/workdir-controller\.js['"]/,
  /vi\.mock\(\s*['"][^'"]*src\/fs\/user-data-path\.js['"]/,
  /from\s*['"][^'"]*main-fixtures(?:\.js)?['"]/,
]

describe('真实用户数据隔离：desktop 测试触达 storePath 链必须假件路径源', () => {
  const files = readdirSync(DESKTOP_TEST_DIR).filter((f) => f.endsWith('.test.ts') && f !== SELF)

  it('无「裸触达」——导入危险模块却未假件 workdir-controller / user-data-path / main-fixtures', () => {
    const naked = files.filter((f) => {
      const src = readFileSync(join(DESKTOP_TEST_DIR, f), 'utf-8')
      if (!RISKY_IMPORT_RE.test(src)) return false
      return !ISOLATION_RES.some((re) => re.test(src))
    })
    expect(
      naked,
      '以下测试真实导入 main/ipc/lifecycle/workdir-controller 却未隔离 userData 路径源——' +
        '一旦触发 storePath() 写盘即覆写作者真实 workdir.json（2026-10-02 事故）：\n' +
        naked.map((f) => `  - test/desktop/${f}`).join('\n') +
        "\n修法：补 vi.mock('../../src/fs/user-data-path.js', …)（appDataHomeDir → 用例临时目录）" +
        '，或改引 main-fixtures（其内已含该假件）。',
    ).toEqual([])
  })

  it('扫描口径自检：事故当日形态判危险、补假件后判安全（守卫不空转）', () => {
    // 反例 = 事故文件当日形态：只假件 electron，storePath() 仍解析真实路径
    const bad = [
      "vi.mock('electron', () => ({ app: { getPath: () => M.userData } }))",
      "await import('../../src/desktop/workdir-controller.js')",
    ].join('\n')
    expect(RISKY_IMPORT_RE.test(bad), '裸触达应被识别').toBe(true)
    expect(
      ISOLATION_RES.some((re) => re.test(bad)),
      '无隔离 → 判危险',
    ).toBe(false)
    // 正例：补 user-data-path 假件后同文件判安全
    const good = bad + "\nvi.mock('../../src/fs/user-data-path.js', () => ({ appDataHomeDir: () => M.userData }))"
    expect(
      ISOLATION_RES.some((re) => re.test(good)),
      '有隔离 → 判安全',
    ).toBe(true)
    // vi.mock 行不误判为真实导入（整模块假件形态）
    const mockedOnly = "vi.mock('../../src/desktop/workdir-controller.js', () => ({}))"
    expect(RISKY_IMPORT_RE.test(mockedOnly), 'vi.mock 行不算真实导入').toBe(false)
  })
})

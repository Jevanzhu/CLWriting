/**
 * 起服进程面 userData 隔离守卫（加固批立档；desktop 域同款先例 =
 * test/desktop/user-data-isolation.guard.test.ts）。
 *
 * 背景：产品起服链的日志初始化落 <userData>/logs——server-main 入口未传
 * --user-data 时回落 defaultUserDataPath（真实 %APPDATA%/CLWriting），Electron
 * main 同（app.setPath('userData', …)）。测试若以**子进程**形态跑这些入口而不传
 * 隔离根，就把日志写进作者真实用户数据目录：server-main-error / release-smoke
 * 两处曾实测如此（已修：spawn 传临时 --user-data）。本守卫把「测试不得以子进程起
 * 产品入口而不隔离 userData」从口头纪律升为机器门：
 *   1) spawn 家族（spawn/execFile/fork）起 server-main 入口（.ts 源码形态 / .js
 *      编译形态）的测试档，必须含 `--user-data`（入口自身支持，server-boot 解析）；
 *   2) spawn(APP_BIN) 或 Playwright `_electron.launch(` 起打包态 app 的测试档，
 *      必须含 `CLW_SMOKE_USER_DATA`（main.ts env 钩子，先例 packaged-app-smoke）
 *      或 `--user-data`。
 *
 * 进程内起服（startServer 直调）不在扫描面：无 userDataPath 时
 * initLogging({ logsDir: null }) 纯 console 镜像（src/studio/server/index.ts
 * 「未提供 userDataPath 时保持纯 console 镜像」），零真实盘面写入。
 * 豁免说明：electron-close-flush-delivery 以 electron 二进制跑内联 fixture（非产品
 * 入口、不触日志链），其 spawn 目标不匹配本守卫两条触发式，天然不在命中面。
 *
 * 静态文本判据（同先例：零 Electron 依赖、零盘面副作用——守卫自身绝不碰真实
 * userData）。含扫描口径自检与已知站点必命中断言：路径/形态漂移时守卫先红，
 * 不得静默失明。
 *
 * 粗粒度注释剥离后判据（块注释 + 行注释；`(?<!:)` 避开 http:// 形态）——注释里
 * 提到隔离标志不算隔离（防「删了标志留注释」静默洗绿）。字符串内 `//` 的误剥
 * 面不影响判据方向（标志/触发式均在代码行内、剥点之前）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const TEST_ROOT = join(import.meta.dirname, '..')
const SELF = 'user-data-spawn-isolation.guard.test.ts'

/** 粗粒度注释剥离：块注释整体删、行注释删至行尾（`://` 不误判为注释起点） */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '')
}

/** spawn 家族调用（词边界防 respawn 之类前缀误判） */
const SPAWN_FAMILY_RE = /(?:^|[^\w.])(?:spawn|spawnSync|execFile|execFileSync|fork)\s*\(/m
/** 产品 server 入口（源码 tsx 形态 / 编译产物 js 形态） */
const SERVER_ENTRY_RE = /server-main\.(?:ts|js)/
/** server 入口的 userData 隔离标志（缺省回落真实用户目录） */
const SERVER_ISOLATION_RE = /--user-data/
/** 打包态 app 起进程形态 */
const PACKAGED_APP_RE = /spawn(?:Sync)?\(\s*APP_BIN|_electron\.launch\(/
/** Electron main 的 userData 隔离：CLW_SMOKE_USER_DATA env 钩子 或 --user-data */
const APP_ISOLATION_RE = /CLW_SMOKE_USER_DATA|--user-data/

function listTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) out.push(...listTsFiles(p))
    else if (ent.name.endsWith('.ts') && ent.name !== SELF) out.push(p)
  }
  return out
}

describe('起服进程面 userData 隔离：测试子进程起产品入口必须带隔离根', () => {
  const files = listTsFiles(TEST_ROOT)

  it('无「裸起服」——spawn server-main 必带 --user-data；起打包态 app 必带隔离钩子', () => {
    const nakedServer: string[] = []
    const nakedApp: string[] = []
    for (const f of files) {
      const src = stripComments(readFileSync(f, 'utf-8'))
      const rel = f.slice(TEST_ROOT.length + 1).replace(/\\/g, '/')
      if (SPAWN_FAMILY_RE.test(src) && SERVER_ENTRY_RE.test(src) && !SERVER_ISOLATION_RE.test(src)) {
        nakedServer.push(rel)
      }
      if (PACKAGED_APP_RE.test(src) && !APP_ISOLATION_RE.test(src)) {
        nakedApp.push(rel)
      }
    }
    expect(
      nakedServer,
      '以下测试以子进程起 server-main 入口却未传 --user-data——起服链日志会写进作者真实用户数据目录（%APPDATA%/CLWriting/logs）：\n' +
        nakedServer.map((f) => `  - test/${f}`).join('\n') +
        "\n修法：spawn 参数补 '--user-data', <临时目录>（mkdtempTracked 建、afterAll 清）。",
    ).toEqual([])
    expect(
      nakedApp,
      '以下测试起打包态 app 却未带 userData 隔离——Electron main 的日志/指针会写进真实用户数据目录：\n' +
        nakedApp.map((f) => `  - test/${f}`).join('\n') +
        "\n修法：env 补 CLW_SMOKE_USER_DATA: <临时目录>（main.ts 钩子），或 args 补 '--user-data'。",
    ).toEqual([])
  })

  it('扫描口径自检 + 已知站点必命中（守卫不空转、形态漂移即响）', () => {
    // 反例（修复前形态）：spawn 起 server-main 无隔离标志 → 判危险
    const bad =
      "const p = join(root, 'src', 'desktop', 'server-main.ts')\n" +
      "spawn(process.execPath, [tsxCli, p, '--port', '0'])"
    expect(SPAWN_FAMILY_RE.test(bad) && SERVER_ENTRY_RE.test(bad)).toBe(true)
    expect(SERVER_ISOLATION_RE.test(bad), '无 --user-data → 判危险').toBe(false)
    // 正例（修复后形态）：补标志 → 判安全
    const good = bad + "\nspawn(process.execPath, [p, '--user-data', tmp])"
    expect(SERVER_ISOLATION_RE.test(good), '有 --user-data → 判安全').toBe(true)
    // 进程内直测形态不误判（无 spawn 家族调用；如 test/desktop/server-main.test.ts）
    const inProcess =
      "import { runServerMain } from '../../src/desktop/server-main.js'\n" + "runServerMain(['node', 'server-main.js'])"
    expect(SPAWN_FAMILY_RE.test(inProcess), '进程内直测不算起服').toBe(false)
    // 注释提及隔离标志不算隔离（防「删了标志留注释」静默洗绿）
    const commentOnly = bad + "\n// 已修：spawn 参数补 '--user-data' 临时目录"
    expect(SERVER_ISOLATION_RE.test(stripComments(commentOnly)), '注释里的 --user-data 不得洗绿').toBe(false)
    // 已知站点必命中：两处真实起服档在扫描面内且受护（改路径/改名时本断言先红）
    for (const rel of ['e2e/release-smoke.spec.ts', 'studio/server/server-main-error.test.ts']) {
      const src = stripComments(readFileSync(join(TEST_ROOT, rel), 'utf-8'))
      expect(
        SPAWN_FAMILY_RE.test(src) && SERVER_ENTRY_RE.test(src),
        `${rel} 应被识别为「spawn 起 server-main」站点——本断言红说明路径/形态已变，守卫面需同步`,
      ).toBe(true)
      expect(SERVER_ISOLATION_RE.test(src), `${rel} 应带 --user-data`).toBe(true)
    }
    // 打包态已知站点必命中
    for (const rel of ['e2e/packaged-app-smoke.spec.ts', 'e2e/multi-instance.spec.ts']) {
      const src = stripComments(readFileSync(join(TEST_ROOT, rel), 'utf-8'))
      expect(PACKAGED_APP_RE.test(src), `${rel} 应被识别为打包态起进程站点`).toBe(true)
      expect(APP_ISOLATION_RE.test(src), `${rel} 应带 userData 隔离钩子`).toBe(true)
    }
  })
})

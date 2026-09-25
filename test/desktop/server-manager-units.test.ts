/**
 * R0916-7-P3-2（2026-09-25 评审 P3-2）：desktop/server-manager.ts 工厂拆分后的新单元直测。
 * 覆盖「组装依赖 / 启动前的纯前置 / 重启退避」三处新单元——纯函数与表驱动为主，不 fork
 * 真进程：
 * - resolveManagerConfig：deps 缺省注入表（各字段缺省值 + 覆写透传 + 缺省真件形态）；
 * - buildChildArgs / buildChildEnv：fork 前置的纯组装（argv 无 token / env 受控键
 *   逐键大小写不敏感清洗与注入 / 不污染宿主 process.env）；
 * - nextBackoffMs：退避表读数（表尾夹取 + 空表 0ms）。
 * 状态机语义（转移表 / 停机三值 / 相位）继续由 server-manager-state-machine.test.ts
 * 的 132 格矩阵钉住；本文件只补拆分新面。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  resolveManagerConfig,
  buildChildArgs,
  buildChildEnv,
  nextBackoffMs,
  createStudioServerManager,
} from '../../src/desktop/server-manager.js'
import type { LogLike } from '../../src/desktop/server-manager.js'

const logger: LogLike = { error: () => {}, warn: () => {}, info: () => {} }

/** 受控键面（R1W-6/R41-7/R43-26/0918三拍板批/阶段 53 S2 的 7 键清洗面） */
const CONTROLLED = [
  'CLW_STUDIO_TOKEN',
  'CLW_LOG_STDOUT',
  'CLW_DEV_UI',
  'CLW_DEV_CORS',
  'CLWRITING_RESOURCES_DIR',
  'CLW_OS_KEK',
  'CLW_APP_VERSION',
] as const

/** env 里某受控键名（大小写不敏感）的全部键拼写——双键穿透即长度 >1 */
function spellings(env: Record<string, string | undefined>, name: string): string[] {
  return Object.keys(env).filter((k) => k.toUpperCase() === name)
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('R0916-7-P3-2 组装依赖：resolveManagerConfig 缺省注入表', () => {
  it('空 deps → 各字段取模块常量缺省；缺省真件为函数形态', () => {
    const cfg = resolveManagerConfig()
    expect(cfg.backoffMs).toEqual([0, 5_000, 15_000])
    expect(cfg.shutdownTotalMs).toBe(3_500)
    expect(cfg.shutdownSettleBudgetMs).toBe(2_000)
    expect(cfg.killWaitMs).toBe(2_000)
    expect(cfg.stabilityResetMs).toBe(5 * 60_000)
    expect(cfg.restartShutdownWaitMs).toBe(5_000)
    expect(typeof cfg.forkImpl).toBe('function')
    expect(typeof cfg.loadOsKek).toBe('function')
    // 三个钩子缺省「无接线」：onTransition/onRestarted 无操作，onRestartExhausted 缺省
    expect(cfg.onTransition).toBeUndefined()
    expect(cfg.onRestarted).toBeUndefined()
    expect(cfg.onRestartExhausted).toBeUndefined()
    // 退出探测缺省恒 false（无接线不放弃自愈）
    expect(cfg.isProcessExiting()).toBe(false)
  })

  it('deps 覆写逐字段透传（含 logger/钩子/读数注入）', () => {
    const cbs = { onRestarted: () => {}, onTransition: () => {}, onRestartExhausted: () => 'quit' as const }
    const cfg = resolveManagerConfig({
      logger,
      shutdownTotalMs: 11,
      shutdownSettleBudgetMs: 12,
      killWaitMs: 13,
      backoffMs: [1, 2],
      stabilityResetMs: 14,
      restartShutdownWaitMs: 15,
      isProcessExiting: () => true,
      loadOsKek: () => null,
      ...cbs,
    })
    expect(cfg.logger).toBe(logger)
    expect([
      cfg.shutdownTotalMs,
      cfg.shutdownSettleBudgetMs,
      cfg.killWaitMs,
      cfg.stabilityResetMs,
      cfg.restartShutdownWaitMs,
    ]).toEqual([11, 12, 13, 14, 15])
    expect(cfg.backoffMs).toEqual([1, 2])
    expect(cfg.isProcessExiting()).toBe(true)
    expect(cfg.loadOsKek('/x')).toBeNull()
    expect(cfg.onRestarted).toBe(cbs.onRestarted)
    expect(cfg.onTransition).toBe(cbs.onTransition)
    expect(cfg.onRestartExhausted).toBe(cbs.onRestartExhausted)
  })

  it('每次调用返回独立配置对象（缺省注入不共享可变面）', () => {
    expect(resolveManagerConfig()).not.toBe(resolveManagerConfig())
  })
})

describe('R0916-7-P3-2 启动前置：buildChildArgs 纯组装', () => {
  it('最小面：只带 --user-data 与 --port，且 argv 面不含 token（E-9b）', () => {
    const args = buildChildArgs({ workDir: null, userDataPath: '/ud' }, '0')
    expect(args).toEqual(['--user-data', '/ud', '--port', '0'])
    expect(args.join(' ')).not.toContain('token')
  })

  it('可选面：workDir/book/mirrorConsole 就位即追加，缺省不追加', () => {
    const full = buildChildArgs(
      { workDir: '/wd', userDataPath: '/ud', book: '书名', mirrorConsole: true },
      '51999',
    )
    expect(full).toEqual(['--user-data', '/ud', '--port', '51999', '--dir', '/wd', '--book', '书名', '--mirror-console'])

    const bare: false | null | undefined = null
    const noBook = buildChildArgs(
      { workDir: '/wd', userDataPath: '/ud', book: bare, mirrorConsole: false },
      '0',
    )
    expect(noBook).toEqual(['--user-data', '/ud', '--port', '0', '--dir', '/wd'])
  })

  it('重启钉住端口：portArg 原样落到 --port（S-1 复刻面）', () => {
    expect(buildChildArgs({ workDir: null, userDataPath: '/ud' }, '51234').at(-1)).toBe('51234')
  })
})

describe('R0916-7-P3-2 启动前置：buildChildEnv 受控键清洗与注入', () => {
  it('注入受控四键：token / CLW_LOG_STDOUT=1 / appVersion / osKek hex', () => {
    const kek = Buffer.from([0xab, 0x01])
    const env = buildChildEnv({ workDir: null, userDataPath: '/ud', appVersion: '1.2.3' }, 'tok', kek)
    expect(env['CLW_STUDIO_TOKEN']).toBe('tok')
    expect(env['CLW_LOG_STDOUT']).toBe('1')
    expect(env['CLW_APP_VERSION']).toBe('1.2.3')
    expect(env['CLW_OS_KEK']).toBe('ab01')
  })

  it('缺省不注入：无 appVersion / osKek=null → 两键缺席（child 回落自带缺省）', () => {
    const env = buildChildEnv({ workDir: null, userDataPath: '/ud' }, 'tok', null)
    expect(spellings(env, 'CLW_APP_VERSION')).toHaveLength(0)
    expect(spellings(env, 'CLW_OS_KEK')).toHaveLength(0)
  })

  it('宿主残留混写变体逐键清除：每个受控键只剩注入侧一种拼写（R1W-6 双键穿透）', () => {
    // 造宿主残留：大小写混写的 7 键 + 一个无关键
    vi.stubEnv('CLW_STUDIO_TOKEN', 'host-token')
    vi.stubEnv('clw_log_stdout', 'host-log')
    vi.stubEnv('clw_dev_ui', 'host-devui')
    vi.stubEnv('CLW_dev_CORS', 'host-cors')
    vi.stubEnv('clwWriting_Resources_Dir', '/host/res')
    vi.stubEnv('clw_os_kek', 'host-kek')
    vi.stubEnv('clw_app_version', '0.0.1')
    vi.stubEnv('CLW_UNRELATED_KEEP', 'keep-me')

    const env = buildChildEnv({ workDir: null, userDataPath: '/ud', appVersion: '9.9.9' }, 'tok', null)
    // 注入侧 3 键（token/log-stdout/app-version）各剩一种拼写；纯清洗 3 键与不注入的
    // osKek 键残留被清空（本用例 osKek=null）——「只剩注入侧拼写」而非「键必存在」
    const expected: Record<(typeof CONTROLLED)[number], number> = {
      CLW_STUDIO_TOKEN: 1,
      CLW_LOG_STDOUT: 1,
      CLW_DEV_UI: 0,
      CLW_DEV_CORS: 0,
      CLWRITING_RESOURCES_DIR: 0,
      CLW_OS_KEK: 0,
      CLW_APP_VERSION: 1,
    }
    for (const name of CONTROLLED) {
      expect(spellings(env, name), `${name} 拼写数`).toHaveLength(expected[name])
    }
    // 注入侧取值胜出，宿主残留无一致命
    expect(env['CLW_STUDIO_TOKEN']).toBe('tok')
    expect(env['CLW_LOG_STDOUT']).toBe('1')
    expect(env['CLW_APP_VERSION']).toBe('9.9.9')
    expect(env['CLW_DEV_UI']).toBeUndefined()
    expect(env['CLWRITING_RESOURCES_DIR']).toBeUndefined()
    // 非受控宿主变量照常继承（清洗不误伤）
    expect(env['CLW_UNRELATED_KEEP']).toBe('keep-me')
  })

  it('只动拷贝：process.env 残留原值不被改写/删除', () => {
    vi.stubEnv('CLW_STUDIO_TOKEN', 'host-token')
    vi.stubEnv('clw_log_stdout', 'host-log')
    buildChildEnv({ workDir: null, userDataPath: '/ud' }, 'fresh', null)
    expect(process.env['CLW_STUDIO_TOKEN']).toBe('host-token')
    expect(process.env['clw_log_stdout']).toBe('host-log')
  })

  it('返回新对象（与 process.env 非同引用）', () => {
    const env = buildChildEnv({ workDir: null, userDataPath: '/ud' }, 'tok', null)
    expect(env).not.toBe(process.env)
  })
})

describe('R0916-7-P3-2 重启退避：nextBackoffMs 读数表', () => {
  it('默认退避表 [0,5000,15000]：第 1/2/3 次取表项，第 4 次起夹在表尾', () => {
    const table = [0, 5_000, 15_000]
    expect([1, 2, 3, 4, 9].map((n) => nextBackoffMs(n, table))).toEqual([0, 5_000, 15_000, 15_000, 15_000])
  })

  it('空表 → 0ms（立即重试兜底）；单元素表恒取该值', () => {
    expect(nextBackoffMs(1, [])).toBe(0)
    expect(nextBackoffMs(5, [])).toBe(0)
    expect([1, 2, 3].map((n) => nextBackoffMs(n, [7]))).toEqual([7, 7, 7])
  })

  it('注入表（测试缩短面）逐次推进', () => {
    expect([1, 2, 3].map((n) => nextBackoffMs(n, [1, 2]))).toEqual([1, 2, 2])
  })
})

describe('R0916-7-P3-2 工厂薄壳：句柄形态冻结', () => {
  it('createStudioServerManager 返回 7 个 API 键且不因拆分增删', () => {
    const manager = createStudioServerManager({ logger, isProcessExiting: () => true })
    expect(Object.keys(manager).sort()).toEqual(
      ['killNow', 'restartPinned', 'shutdown', 'start', 'stopChild', 'hasPendingRestart', 'isRunning'].sort(),
    )
    expect(manager.isRunning()).toBe(false)
    expect(manager.hasPendingRestart()).toBe(false)
  })
})

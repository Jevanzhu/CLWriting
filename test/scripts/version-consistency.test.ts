/**
 * R66-42（十四轮）：vue/pinia 双 lockfile 版本一致性守卫。
 *
 * 背景：同批前端代码（src/studio/web-next/src）在根包与子包两套依赖树上各跑一半——
 * 根包 vitest 跑单测（vitest.config.ts alias 把 vue/pinia 钉到根 node_modules 副本），
 * web-next 子包用自己 node_modules 的副本做 vite 构建与 vue-tsc 类型检查。两份
 * lockfile 独立升级可漂移：漂移后「单测验证的运行时 ≠ 构建/类型检查的运行时」，
 * 单测照绿但两态行为分叉（报告 R66-42）。
 *
 * 守卫口径（从宽到严分层，避免落地即红）：
 * ① 声明范围：两处 package.json 的版本范围字符串必须逐字符一致——范围失配是
 *   最常见的漂移形态，硬拒；
 * ② 实装主版本：两份 package-lock.json 实际 resolved 的 major 必须一致——大版本
 *   分叉即两套语义不同的运行时副本，硬拒。minor/patch 允许暂时错开
 *   （2026-08-27 实况：vue 根 3.5.38 / web-next 3.5.40，属已登记的补丁级漂移，
 *   待对齐后可收紧到全等）；
 * ③ lock 条目缺席 = 布局漂移（提升/嵌套结构变化），同样红——守卫依赖该入口定位副本。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const WEB_NEXT = 'src/studio/web-next'

/** vitest alias 钉根副本的前端运行时依赖（@vitejs/plugin-vue 等构建件不在运行时链） */
const GUARDED = ['vue', 'pinia'] as const

interface PkgJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function readPkg(dir: string): PkgJson {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PkgJson
}

/** 声明范围：dependencies/devDependencies 任一处声明即取（根包在 dev、web-next 在 prod） */
function declaredRange(pkg: PkgJson, name: string): string | undefined {
  return pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]
}

/** lock 实装版本：npm lock v3 的 packages 表，顶层 node_modules/<name> 即该树副本 */
function lockedVersion(lockDir: string, name: string): string {
  const lock = JSON.parse(readFileSync(join(lockDir, 'package-lock.json'), 'utf8')) as {
    packages?: Record<string, { version?: string }>
  }
  const entry = lock.packages?.[`node_modules/${name}`]
  if (!entry?.version) {
    throw new Error(
      `${lockDir} 的 package-lock.json 缺 node_modules/${name} 条目——依赖布局漂移，守卫入口失效`,
    )
  }
  return entry.version
}

describe('R66-42: vue/pinia 双 lockfile 版本一致性守卫', () => {
  const rootPkg = readPkg(root)
  const webPkg = readPkg(join(root, WEB_NEXT))

  it.each(GUARDED)('%s：两处 package.json 声明范围逐字符一致', (name) => {
    const r = declaredRange(rootPkg, name)
    const w = declaredRange(webPkg, name)
    expect(r, `根 package.json 须声明 ${name}（vitest alias 依赖根副本）`).toBeTruthy()
    expect(w, `web-next package.json 须声明 ${name}`).toBeTruthy()
    expect(w, `${name} 声明范围漂移：根 ${r} vs web-next ${w}`).toBe(r)
  })

  it.each(GUARDED)('%s：两份 lockfile 实装主版本一致（运行时副本不语义分叉）', (name) => {
    const rootVer = lockedVersion(root, name)
    const webVer = lockedVersion(join(root, WEB_NEXT), name)
    const rootMajor = rootVer.split('.')[0]
    const webMajor = webVer.split('.')[0]
    expect(
      webMajor,
      `${name} 实装主版本分叉：根 ${rootVer} vs web-next ${webVer}——同批前端代码` +
        `的测试副本与构建/类型检查副本语义不一致，须同步升级其一`,
    ).toBe(rootMajor)
  })
})

/**
 * harness 采用面申报对账门口径直测。
 *
 * 本门替两条此前只靠自律的对账值守：副本版本号两处一致、四份空判据门的实文与申报
 * （形状 + 理由）一致。用例锚定判据本身（纯函数），另有一条真实仓库实跑——
 * 申报表与实文脱钩时，那条会红。
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, readRepoFile } from '../helpers/repo-root.js'
import {
  DECLARED_EMPTY,
  problemsForCopyVersion,
  problemsForManifestShapes,
  // @ts-expect-error —— .mjs 直跑脚本无类型声明（不为其维护 d.ts；断言口径靠用例锚定）。
  // 注记须紧贴 `} from` 行（TS 把 TS7016 报在模块说明符所在行），故放字面量末项之后。
} from '../../scripts/check-harness-copy.mjs'

const scriptPath = join(REPO_ROOT, 'scripts', 'check-harness-copy.mjs')

/** 申报表条目（.mjs 无类型声明，此处按实读形状标注；形状漂移由用例断言兜住）。 */
interface DeclaredEmpty {
  file: string
  shape: string
  reason: string
}
const declaredEntries = DECLARED_EMPTY as DeclaredEmpty[]

describe('副本版本对账：两处版本号必须一致且像版本号', () => {
  it('一致 → 无问题；两侧空白容忍', () => {
    expect(problemsForCopyVersion('0.1.8', '0.1.8')).toEqual([])
    expect(problemsForCopyVersion(' 0.1.8\n', '0.1.8')).toEqual([])
  })

  it('不一致 → 点名两侧的值（副本换版而 version.json 未刷新即此形）', () => {
    const problems = problemsForCopyVersion('0.1.9', '0.1.8')
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('.agents/skills/VERSION 是 0.1.9')
    expect(problems[0]).toContain('scripts/harness/version.json 是 0.1.8')
  })

  it('形状不识别（空串/非语义版本/缺号）→ 各自一条，且不再叠报「对不上」', () => {
    expect(problemsForCopyVersion('', '0.1.8')).toHaveLength(1)
    expect(problemsForCopyVersion('v0.1.8', '0.1.8')).toHaveLength(1)
    expect(problemsForCopyVersion(undefined, undefined)).toHaveLength(2)
    expect(problemsForCopyVersion('1.0', '1.0')).toHaveLength(2)
  })
})

describe('空判据门申报：实文形状必须与申报一致', () => {
  const declaredEmpty: () => Record<string, unknown> = () =>
    Object.fromEntries(
      declaredEntries.map((entry) => [entry.file, entry.shape === 'empty-claims' ? { claims: [] } : {}]),
    )

  it('全部空置且形状吻合 → 无问题；每条申报都带理由', () => {
    expect(problemsForManifestShapes(declaredEmpty())).toEqual([])
    for (const entry of declaredEntries) expect(entry.reason.trim()).not.toBe('')
  })

  it('申报为空却填上了 → 点名该文件并提示同步申报（面已开启）', () => {
    const actual = declaredEmpty()
    actual['scripts/harness/doc-budgets.manifest.json'] = { 'AGENTS.md': 900 }
    const problems = problemsForManifestShapes(actual)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('doc-budgets.manifest.json')
    expect(problems[0]).toContain('已开启')
  })

  it('形状漂移（doc-claims 的空 claims 被写成 {}）→ 报形状不符（不叠报未申报）', () => {
    const actual = declaredEmpty()
    actual['scripts/harness/doc-claims.manifest.json'] = {}
    const problems = problemsForManifestShapes(actual)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('与申报的空置形状不符')
  })

  it('申报表里的文件读不到（被删/被清空）→ 报「门在静默消失」，不静默跳过', () => {
    const actual = declaredEmpty()
    delete actual['scripts/harness/test-hygiene.manifest.json']
    const problems = problemsForManifestShapes(actual)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('test-hygiene.manifest.json 读不到')
  })

  it('未申报的空置 manifest → 报「空置必须显式声明」（已接线的面被清空即此形）', () => {
    const actual = declaredEmpty()
    actual['scripts/harness/doc-index.manifest.json'] = {}
    const problems = problemsForManifestShapes(actual)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('doc-index.manifest.json 空置但未申报')
  })

  it('未申报的非空 manifest（doc-index 正常态）→ 不报', () => {
    const actual = declaredEmpty()
    actual['scripts/harness/doc-index.manifest.json'] = {
      index: 'docs/README.md',
      entries: [{ dir: '05-规范', count: true }],
    }
    expect(problemsForManifestShapes(actual)).toEqual([])
  })
})

describe('真实仓库实跑', () => {
  it('本仓申报与实文一致、两处版本号一致 → 退出 0 并打印通过行', () => {
    const r = spawnSync(process.execPath, [scriptPath], { cwd: REPO_ROOT, encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('check:harness-copy 通过')
  })

  it('申报表点名的文件与实文交错（真实树）：四份都真在位且真为空', () => {
    for (const entry of declaredEntries) {
      const parsed = JSON.parse(readRepoFile(entry.file)) as Record<string, unknown>
      const keys = Object.keys(parsed)
      if (entry.shape === 'empty-object') expect(keys).toEqual([])
      else expect(parsed).toEqual({ claims: [] })
    }
    expect(readFileSync(join(REPO_ROOT, '.agents', 'skills', 'VERSION'), 'utf8').trim()).toBe(
      JSON.parse(readRepoFile('scripts/harness/version.json')).version,
    )
  })
})

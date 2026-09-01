/**
 * R29-8（二十九轮）回归：长篇书 布线/ 目录缺失 → 态 1 warning 健康项「布线目录缺失，
 * 防吃书闸与账本回写未生效」。
 *
 * 背景：finalize 的防吃书闸（ee-P1-3）与账本履历回写（ee-P1-4）都以 existsSync(布线)
 * 为生效条件——目录缺失时两者整体静默失效（fail-open 放行 + 跳过回写），作者零感知。
 * 修复后健康检查对长篇（kind 缺省 long）报 wiringMissing；短篇书不建布线是正常形态，
 * 不报（避免误报）。
 */
import { test, expect } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { detectState, routeState } from '../../src/state/state.js'
import { DEFAULT_CONFIG, writeBookConfig } from '../../src/format/yaml.js'
import { makeGitBookWithChapters } from '../helpers/book.js'
import type { BookConfig } from '../../src/format/types.js'

const SHORT_CONFIG: BookConfig = { ...DEFAULT_CONFIG, kind: 'short', book: { title: '夜语集', genre: '悬疑' } }

test('R29-8: 长篇书（kind 缺省 long）布线目录缺失 → 态 1 wiringMissing 健康项', async () => {
  const root = mkdtempTracked(join(tmpdir(), 'r29-wiring-missing-'))
  try {
    writeBookConfig(join(root, 'book.yaml'), DEFAULT_CONFIG)
    mkdirSync(join(root, '写作', '正文'), { recursive: true })
    // 不建 布线/
    const d = await detectState(root, DEFAULT_CONFIG)
    expect(d.state).toBe(1)
    if (d.state !== 1) return
    const issue = d.issues.find((i) => i.kind === 'wiringMissing')
    expect(issue).toBeDefined()
    expect(issue?.humanMsg).toContain('布线目录缺失')
    expect(issue?.humanMsg).toContain('防吃书闸')
    // 路由人话交作者裁决（进门体检不门禁）
    expect(routeState(d).humanMsg).toContain('布线目录缺失')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R29-8: 短篇书（kind: short）无布线 → 不报 wiringMissing（正常形态，不误报）', async () => {
  const root = mkdtempTracked(join(tmpdir(), 'r29-short-nowiring-'))
  try {
    writeBookConfig(join(root, 'book.yaml'), SHORT_CONFIG)
    mkdirSync(join(root, '写作', '正文'), { recursive: true })
    const d = await detectState(root, SHORT_CONFIG)
    // 短篇无布线走短篇分支落态 7，且健康检查干净（无 issues 字段）
    expect(d.state).toBe(7)
    expect('issues' in d).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R29-8: 长篇书布线目录在位 → 不报 wiringMissing（既有健康书不回归）', async () => {
  const root = makeGitBookWithChapters(1, { commitEach: false })
  try {
    const d = await detectState(root, DEFAULT_CONFIG)
    expect(d.state).toBe(7)
    expect('issues' in d).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

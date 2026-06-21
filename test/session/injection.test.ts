import { test, expect } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { makeGitBookWithChapters, makeGitBook, stageIncompleteChapter, seedChapterToCache } from '../helpers/book.js'
import { recordAiCall } from '../../src/ai/calls.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { buildSessionStartInjection, renderSessionStartInjection } from '../../src/session/injection.js'
import { enter } from '../../src/state/state.js'

const FAST_CHAPTER_FIXTURE = { commitEach: false }

test('SessionStart 注入: 复用 enter() 结构化结果，输出有界 AI 近况', () => {
  const root = makeGitBookWithChapters(3, FAST_CHAPTER_FIXTURE)
  const injection = buildSessionStartInjection(root)

  expect(injection.enter_result.recap.currentChapter).toBe(3)
  expect(injection.enter_result.recap.nextChapter).toBe(4)
  expect(injection.text).toContain('# CLWriting SessionStart')
  expect(injection.text).toContain('状态：起草新章')
  expect(injection.text).toContain('下一章：第 4 章')
  expect(injection.text).toContain('不要基于本注入猜测正文内容')
  expect(injection.text).not.toContain('第3章的正文内容')
  rmSync(root, { recursive: true, force: true })
})

test('SessionStart 注入: 与手动 enter 同源同果，并带调用预算余量', () => {
  const root = makeGitBookWithChapters(3, FAST_CHAPTER_FIXTURE)
  recordAiCall({
    workDir: join(root, '工作区'),
    chapter: 4,
    config: DEFAULT_CONFIG,
    step: 'outline',
    calls: 2,
    at: '2026-06-18T00:00:00.000Z',
  })

  const enterResult = enter(root)
  const rendered = renderSessionStartInjection(root, enterResult)

  expect(rendered).toContain('已用 2/8，剩余 6')
  expect(rendered).toContain(`路由：${enterResult.route.action}`)
  expect(rendered).toContain(`状态：起草新章（态 ${enterResult.route.state}）`)
  rmSync(root, { recursive: true, force: true })
})

test('SessionStart 注入: 态 4 续跑信息归属「当前态」段且紧跟调用预算行', () => {
  const root = makeGitBook()
  seedChapterToCache(root, 3, '第3章')
  stageIncompleteChapter(root, 4)

  const enterResult = enter(root)
  const rendered = renderSessionStartInjection(root, enterResult)

  expect(enterResult.detected.state).toBe(4)
  expect(rendered).toContain('- 续跑章：第 4 章，断点 pre-commit')
  // 续跑行在调用预算之后、待办之前（验证不依赖行索引，语义归属当前态段）
  const budgetIdx = rendered.indexOf('调用预算')
  const resumeIdx = rendered.indexOf('续跑章')
  const todoIdx = rendered.indexOf('## 待办')
  expect(budgetIdx).toBeGreaterThan(-1)
  expect(resumeIdx).toBeGreaterThan(budgetIdx)
  expect(resumeIdx).toBeLessThan(todoIdx)
  rmSync(root, { recursive: true, force: true })
})

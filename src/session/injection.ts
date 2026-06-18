/**
 * SessionStart 注入文本 —— 依据 M4 #24。
 *
 * hook 与手动入口同源：只调用 state/enter 的库形态，再把结构化 Recap 渲染为
 * 给 AI 的有界开场上下文；不重新判态、不展开正文/账本内容。
 */

import { join } from 'node:path'
import { getAiCallBudgetState } from '../ai/calls.js'
import { readBookConfig } from '../format/yaml.js'
import { enter, formatRoute, STATE_NAMES, type EnterResult } from '../state/state.js'

export interface SessionStartInjection {
  text: string
  enter_result: EnterResult
}

/** 生成 SessionStart 注入文本；重复调用只读文件，无副作用。 */
export function buildSessionStartInjection(bookRoot: string): SessionStartInjection {
  const enterResult = enter(bookRoot)
  return {
    text: renderSessionStartInjection(bookRoot, enterResult),
    enter_result: enterResult,
  }
}

/** 从 enter() 结果渲染给 AI 的有界注入文本。 */
export function renderSessionStartInjection(bookRoot: string, enterResult: EnterResult): string {
  const { recap, route, detected } = enterResult
  const budgetLine = formatBudgetLine(bookRoot, enterResult)
  const confirmLine = recap.lastConfirm
    ? `- 确认复述：第 ${recap.lastConfirm.chapter} 章，${recap.lastConfirm.mode}，${recap.lastConfirm.hash}，${formatConfirmVerification(recap.lastConfirm.verified)}`
    : '- 确认复述：最近提交没有确认记录。'

  const lines = [
    '# CLWriting SessionStart',
    '',
    '这是会话开始时的有界近况。不要把它当成全文上下文；需要正文、设定或账本细节时，按需精准读取文件。',
    '',
    '## 当前态',
    '',
    `- 状态：${STATE_NAMES[route.state]}（态 ${route.state}）`,
    `- 已定稿：第 ${recap.currentChapter} 章，第 ${recap.currentVolume} 卷`,
    `- 下一章：第 ${recap.nextChapter} 章`,
    `- 路由：${route.action}`,
    `- 是否需要 AI：${route.needsAI ? '是' : '否'}`,
    budgetLine,
    // 续跑信息归属「当前态」段，紧跟其他字段；就地展开避免依赖行索引
    ...(detected.state === 4
      ? [`- 续跑章：第 ${detected.chapterNum} 章，断点 ${detected.resumePoint}`]
      : []),
    '',
    '## 待办',
    '',
    `- ${route.humanMsg.replace(/\n/g, '\n- ')}`,
    '',
    '## 复述校验',
    '',
    `- git：${recap.gitClean ? '干净' : '有问题'}`,
    `- 源文件解析：${recap.parseErrors ? '有错误' : '无错误'}`,
    `- 未入账手改：${recap.handEdits ? '有' : '无'}`,
    confirmLine,
    '',
    '## 操作边界',
    '',
    '- 关键动作前重新调用对应 CLI；SessionStart 只代表会话开始那一刻。',
    '- 不要绕过 confirm / check / review / finalize 硬闸。',
    '- 不要基于本注入猜测正文内容；正文、设定、账本以文件为准。',
  ]

  return lines.join('\n') + '\n'
}

function formatConfirmVerification(verified: boolean | null): string {
  if (verified === true) return '哈希一致'
  if (verified === false) return '哈希不一致，确认后疑似改过细纲'
  return '未复核，工作区细纲已清理'
}

function formatBudgetLine(bookRoot: string, enterResult: EnterResult): string {
  const { config } = readBookConfig(join(bookRoot, 'book.yaml'))
  const chapter = enterResult.detected.state === 4 ? enterResult.detected.chapterNum : enterResult.recap.nextChapter
  const state = getAiCallBudgetState(join(bookRoot, '工作区'), chapter, config)
  if (!state.ok) return `- 调用预算：无法确认（${state.reason}）`
  return `- 调用预算：第 ${chapter} 章已用 ${state.used}/${state.limit}，剩余 ${state.remaining}`
}

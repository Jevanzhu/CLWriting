/**
 * 书级动态规则（源 2：条目库 AI味标签禁词）。
 *
 * 当前状态（A2 前）：readBannedEntryWords 显式排除 AI味标签词
 * （只注入不机检——但实际注入侧也未接线，等于「既不注入也不检验」）。
 * A2 后：toPrompt 注入词列表 + check 检测命中——两侧都有（黄级）。
 */
import { join } from 'node:path'
import { readEntries, ENTRIES_DIR } from '../../format/style-entry.js'
import { ruleStripFm, type WritingRule, type RuleViolation } from './types.js'

/** 条目库 AI味标签词 + 替换建议（说明字段） */
interface FlavorWord {
  word: string
  hint?: string
}

/**
 * 加载书级 AI味标签词规则。
 * 无 AI味标签词时返回 toPrompt=null + check 空的空壳规则（保持接口一致）。
 */
export function loadAiFlavorRule(bookRoot: string): WritingRule {
  const { entries } = readEntries(join(bookRoot, ENTRIES_DIR), '禁词')
  const words: FlavorWord[] = entries
    .filter((e) => e.标签?.includes('AI味'))
    .map((e) => ({ word: e.正文.trim(), hint: e.说明?.trim() || undefined }))
    .filter((w) => w.word)

  return {
    id: 'ai-flavor-words',
    level: 'yellow',
    // draft-save 挂载：作者手改落盘的删除信号要走本规则（B5 闭环，W-P2-5）
    tasks: ['self-heal', 'spawn-write', 'rewrite', 'draft-save'],
    toPrompt() {
      if (!words.length) return null
      return `以下AI味词组应避免：${words.map((w) => w.word).join('、')}`
    },
    check(body: string): RuleViolation[] {
      const text = ruleStripFm(body)
      return words
        .filter((w) => text.includes(w.word))
        .map((w) => ({
          ruleId: 'ai-flavor-words',
          level: 'yellow' as const,
          message: w.hint
            ? `AI味词「${w.word}」——${w.hint}`
            : `AI味词「${w.word}」——删除或替换`,
        }))
    },
  }
}

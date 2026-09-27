/**
 * 书级动态规则（源 2：条目库 AI味标签禁词）。
 *
 * 两侧都已接线（黄级）：注入侧——`applicableRules`（rules/index.ts）按任务过滤后，
 * `rulesPromptParts` 把 toPrompt 的词列表并入「## 写作约束」段（消费点 = tasks/spec.ts
 * 的 runSpec）；机检侧——check 在 self-heal / spawn-write / rewrite / draft-save 四个
 * 任务上检出命中。所以词表非空即两条路都生效，不存在「只注入不检验」的档位。
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
    // draft-save 挂载：作者手改落盘的删除信号要走本规则（闭环）
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
          message: w.hint ? `AI味词「${w.word}」——${w.hint}` : `AI味词「${w.word}」——删除或替换`,
        }))
    },
  }
}

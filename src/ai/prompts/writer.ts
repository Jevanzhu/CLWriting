/**
 * 写稿角色 system prompt（方案 §四③；C2 起资源化——文案唯一源 = resources/prompts/*.md）。
 *
 * 导出名保持不变（specs.ts 等消费方零改动）。段组装机制（PromptSection）见 section.ts，
 * 供新增 prompt 使用；内置文案迭代流程：改资源文件 → 金测夹具同步 → versions.json 追加哈希。
 * prompt 前缀稳定约束（方案 §四①）：角色设定 + 写作准则在前（不变），
 * 变动的章节内容在 messages 后段，保证前缀缓存命中。
 */
import { loadBuiltinPrompt } from './resource.js'

/** 长篇写稿 system prompt（tool_use 路径：self-heal / 自动写章） */
export const WRITER_SYSTEM_LONG = loadBuiltinPrompt('writer-long').text

/** 短篇写稿 system prompt（tool_use 路径：self-heal / 自动写章） */
export const WRITER_SYSTEM_SHORT = loadBuiltinPrompt('writer-short').text

/** 改写 system prompt（局部改写 / 续写） */
export const REWRITER_SYSTEM = loadBuiltinPrompt('rewriter').text

/** 按 kind 选写稿 system prompt */
export function writerSystem(kind: 'long' | 'short'): string {
  return kind === 'short' ? WRITER_SYSTEM_SHORT : WRITER_SYSTEM_LONG
}

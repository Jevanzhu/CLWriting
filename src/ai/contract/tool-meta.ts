/**
 * re-export 桥：实现在 src/shared/contract/tool-meta.ts（消费面横跨后端确认链与
 * web-next 确认卡，见该文件头注）。
 *
 * 为什么保留：ai 侧既有 import 面不断——本模块只转发，不得再承载第二份实现。
 * 新增消费方直引 src/shared/contract/tool-meta.ts。
 */
export { TOOL_META, toolLabel, toolSummary } from '../../shared/contract/tool-meta.js'
export type { ChapterNameLookup, ToolMeta, ToolRisk } from '../../shared/contract/tool-meta.js'

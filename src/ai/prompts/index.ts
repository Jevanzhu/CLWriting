export {
  WRITER_SYSTEM_LONG,
  WRITER_SYSTEM_SHORT,
  REWRITER_SYSTEM,
  writerSystem,
} from './writer.js'
export { ANALYST_SYSTEM } from './analyst.js'
export { REVIEW_SYSTEMS, reviewSystem } from './review.js'
// C1：PromptSection 命名段注册表（新 prompt 组装用；内置文案已资源化，见 resource.ts）
export { assembleSections, interpolate, SECTION_ORDER, type PromptSection } from './section.js'
// C2：内置 prompt 资源层（加载/overlay/迁移/哈希精确匹配）
export {
  loadBuiltinPrompt,
  builtinPromptNames,
  resolvePrompt,
  migratePromptOverlays,
  matchBuiltinPrompt,
  resolveBuiltinSystemPrompt,
  promptHash,
  type PromptRegistry,
  type PromptResource,
} from './resource.js'

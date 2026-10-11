/**
 * re-export 桥：实现在 src/shared/frontmatter-core.ts（浏览器/服务端共用一份，
 * 见该文件头注）。
 *
 * 为什么保留：format 域与后端消费方、既有测试的 import 面零改动——本模块只转发，
 * 不得再承载第二份实现。新增消费方直引 src/shared/frontmatter-core.ts。
 */
export {
  splitFrontMatter,
  hasOpenFrontMatterFence,
  bodyOf,
  firstKeyColon,
  stripInlineComment,
} from '../shared/frontmatter-core.js'

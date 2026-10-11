/**
 * re-export 桥：实现在 src/shared/words.ts（浏览器/服务端共用一份，见该文件头注）。
 *
 * 为什么保留：format 域与后端消费方、既有测试的 import 面零改动——本模块只转发，
 * 不得再承载第二份实现。新增浏览器侧消费方直引 src/shared/words.ts。
 */
export { countWords, parseChapterFileName, chapterFilePrefix } from '../shared/words.js'

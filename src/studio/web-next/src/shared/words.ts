// 与服务端共享的字数/章名纯函数（T2.1）：从主仓 src/format/words.ts re-export。
// words.ts 零 Node 依赖，浏览器端可直接 import；chapters.ts 因 import node:fs 不可跨入。
export { countWords, parseChapterFileName } from '../../../../format/words'

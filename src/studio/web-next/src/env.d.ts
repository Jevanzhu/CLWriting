/// <reference types="vite/client" />

// 让 `import X from './X.vue'` 在本包的类型程序里可解析。
//
// 需要它的是 eslint 侧：.vue 面的 parser 走 raw TS（extraFileExtensions 只把当前
// 文件挂进程序，不解析 SFC），无此通配声明时组件导入解析为 error 类型——
// 脚本块里任何赋值/传参都会触发 no-unsafe-* 一族（存量靠抑制表压着）。
// vue-tsc（typecheck:web-next）解析真实 SFC，通配声明只在解析不到时兜底。
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}

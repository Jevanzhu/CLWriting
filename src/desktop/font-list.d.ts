// font-list 无官方类型，本地声明（主进程枚举系统字体用）。
declare module 'font-list' {
  export function getFonts(options?: { disableQuoting?: boolean }): Promise<string[]>
}

/**
 * `clwriting studio` 子命令薄包装。
 * 转发到 src/studio/server/studio-cli.ts（GUI 代码隔离在 src/studio/，
 * 此文件仅保持 cli/ 下 <cmd>Command 导出惯例，供 cli.ts 分发）。
 */
export { studioCommand } from '../studio/server/studio-cli.js'

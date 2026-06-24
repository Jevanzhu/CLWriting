import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts', 'src/desktop/main.ts'],
  external: ['electron'], // electron 由 Electron 运行时提供,不 bundle
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  clean: true,
  // tsup 默认加 nodeProtocolPlugin 剥离 `node:` 前缀（为兼容 Node <14.18，tsup#1003），
  // 会把 `node:sqlite` 改写成 bare `sqlite`，运行时 Node 去找不存在的 npm 包 `sqlite` 而崩。
  // 本项目门槛 Node ≥24，内置模块原生支持 `node:` 协议，保留前缀。
  removeNodeProtocol: false,
})

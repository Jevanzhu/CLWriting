/**
 * 单次保存的请求体上限（前端预检单源）——RC 源码重审 B-1。
 *
 * 服务端单源 = `src/studio/server/http.ts` 的 `CONTENT_BODY_LIMIT_BYTES`（文档 content
 * PUT / 新建带 content / `/file` PUT 三处走该档）。前端子包不引用服务端模块（零根依赖
 * 惯例），故此处镜像一份数值，两侧等值由 `test/studio/r78-save-body-limit.test.ts` 的
 * 断言钉住——改单边即红，不会静默漂移。
 *
 * 为什么前端要预检：默认档（1MB）对「200 万字」级正文远不够（中文 UTF-8 ≈3 字节/字，
 * 约 34 万字即 413）。旧形态下 413 只落服务端通用分支——作者看到「请求体过大」而无
 * 出路，autosave 每 30s 把整篇重传一次再失败，切书只剩「丢弃并切换」。预检把失败前移
 * 到本地：不发起请求、明确提示拆分、并停掉 autosave 重试（见 stores/doc.ts）。
 */

/** 与服务端 CONTENT_BODY_LIMIT_BYTES 等值（测试钉住）。 */
export const MAX_SAVE_BODY_BYTES = 16 * 1024 * 1024

/** 信封余量：expectedRevision / operationId / origin 等字段与 JSON 转义开销的粗估上界。 */
export const SAVE_BODY_ENVELOPE_BYTES = 4096

/** 内容 UTF-8 字节数（精确）。仅在廉价上界命中时才调用——避免对普通文档每拍全量编码。 */
export function contentByteLength(content: string): number {
  return new TextEncoder().encode(content).length
}

/**
 * 保存前字节预检：内容按 UTF-8 编码 + 信封余量是否超单次保存上限。
 * 快路径 `content.length * 3` 是 UTF-8 字节数的**上界**（BMP 单码元最多 3 字节、代理对
 * 两码元 4 字节 = 每码元 2 字节、孤立代理按替换字符 3 字节），命中上界即无需全量编码。
 */
export function exceedsSaveBodyLimit(content: string): boolean {
  if (content.length * 3 + SAVE_BODY_ENVELOPE_BYTES <= MAX_SAVE_BODY_BYTES) return false
  return contentByteLength(content) + SAVE_BODY_ENVELOPE_BYTES > MAX_SAVE_BODY_BYTES
}

/** 超限提示单源（编辑器状态条 / toast / friendlyError 三处共用，文案不漂移）。 */
export const SAVE_TOO_LARGE_MESSAGE = `文档超过单次保存上限（${MAX_SAVE_BODY_BYTES / (1024 * 1024)} MB），已停止自动保存——请拆分文档后再保存`

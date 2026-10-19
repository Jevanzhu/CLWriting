/**
 * 「本地 API 不可达」文案单源——api 层错误信封与 AI 可达性探测共用同一句人话，
 * 且按形态分流：生产形态不含开发者指令，dev 形态才追加启动指引（只有本地开发
 * 需要知道脚本名）。放在零依赖模块里，避免 api/client 与 shared/error 互相 import。
 */
export const LOCAL_API_DOWN_MESSAGE = '本地服务未连接，请确认 API 服务已启动'

/** 按运行形态取本地 API 不可达文案（isDev 由调用方传 import.meta.env.DEV，便于直测两形态）。 */
export function localApiDownMessage(isDev: boolean): string {
  return isDev ? LOCAL_API_DOWN_MESSAGE + '（开发环境请先运行 npm run dev:api）' : LOCAL_API_DOWN_MESSAGE
}

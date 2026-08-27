import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { redactSecret } from '../../ai/provider/redact.js'

export const JSON_BODY_LIMIT_BYTES = 1024 * 1024

/** R-1（十五轮登记销账）：413 拒绝后排空请求体的宽限上限——超时即 destroy，防慢速
 * 发送方长期 dribble 占住 socket（信任域缓解，非安全边界）。 */
export const PAYLOAD_GRACE_MS = 1500

export class HttpError extends Error {
  /** 机器可判别错误码（信封 {code,error} 的 code；缺省 'ERROR' 兜底） */
  public code: string
  constructor(
    public status: number,
    message: string,
    code = 'ERROR',
  ) {
    super(message)
    this.code = code
  }
}

export function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * 统一错误出口（hh §八-12）：所有非 2xx JSON 错误响应的唯一信封形状 {code, error}。
 * 为什么是独立函数而非 reply 加可选 code 参数：reply 的 body 形状自由（成功响应各异），
 * 错误信封形状必须唯一——独立出口让「只传了 error 漏了 code」这类漂移在编译期就不可能，
 * 且 grep replyError 即可盘点全部错误点。
 * - error 保留中文人话（前端 toast 展示，client.ts 按 error 优先解析 → 前端零改动）
 * - code 机器可判别（复用既有词表 NO_WORKDIR/NOT_FOUND/BAD_INPUT/BAD_PATH/BUSY/...，
 *   无法归类的用 'ERROR' 兜底，禁止自创同义码）
 * - extra（N-2，第十二轮）：可选诊断扩展字段（如机检失败带 details）——仍走本单一
 *   出口，不回退到手拼 reply({ok:false,...}) 混合信封
 */
export function replyError(
  res: ServerResponse,
  status: number,
  code: string,
  error: string,
  extra?: Record<string, unknown>,
): void {
  // R67-14（十五轮）：错误信封单一出口统一脱敏——各 handler 直透 result.error 的窄
  // 路径（非 GenError 逃逸 message）此前靠各点自觉套 redactSecret，8 处直透漏网；
  // 收进本出口后所有非 2xx error 文本一律过 redactSecret（幂等：已脱敏文本再过
  // 无变化，既有调用点的显式脱敏不受影响；中文人话不匹配凭据模式不受影响）
  const safeError = redactSecret(error)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ code, error: safeError, ...(extra ?? {}) }))
}

/** HttpError → 统一信封（dispatch catch / readJson 抛错的兜底出口）。 */
export function replyHttpError(res: ServerResponse, e: HttpError): void {
  replyError(res, e.status, e.code, e.message)
}

/** 常量时间 token 比较，防 timing attack（长度不同直接返回 false）。 */
export function safeTokenCompare(received: string | string[] | undefined, expected: string): boolean {
  if (typeof received !== 'string') return false
  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** M3（二轮复审）：日志用的请求路径（去 query）——SSE 会话令牌走 query（EventSource
 * 不能带 header，设计无奈之举），完整 req.url 进错误日志会把全部写端点的凭证明文落
 * app-*.jsonl 留存 7 天；日志被导出/同步/上报排障时凭证随之外流。 */
export function urlPathOnly(url: string | undefined): string {
  if (!url) return ''
  const i = url.indexOf('?')
  return i === -1 ? url : url.slice(0, i)
}

/** R-19（第十六轮）：req.url → URL 的统一安全解析（Q-1/N-3 口径收编）。llhttp 接受
 *  absolute-form 等畸形请求行（如 `GET http://[bad HTTP/1.1`），new URL 抛 TypeError
 *  ——各 handler 此前六处裸调各管各。畸形 URL 返 null，调用方回 400 BAD_INPUT 信封
 *  （与 static.ts Q-1 同款）。 */
export function parseRequestUrl(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? '/', 'http://localhost')
  } catch {
    return null
  }
}

export function checkToken(req: IncomingMessage, token: string): boolean {
  return safeTokenCompare(req.headers['x-studio-token'], token)
}

/** 读取 JSON body；默认 1MB 上限，避免本地 server 被超大请求顶爆内存。 */
export function readJson(
  req: IncomingMessage,
  limitBytes = JSON_BODY_LIMIT_BYTES,
  graceMs = PAYLOAD_GRACE_MS,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    // 缓冲按 Buffer 收集、一次性 concat 后再解码：逐 chunk toString 会把跨分块边界的
    // 多字节 UTF-8 字符（中文正文常态）切成 U+FFFD，造成静默内容损坏（V-P1-1）。
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (c: Buffer) => {
      if (tooLarge) return
      size += c.byteLength
      if (size > limitBytes) {
        tooLarge = true
        chunks.length = 0
        // 超限即拒绝（Y-P2-7）：不等 end，防悬挂连接长期占用 FD。reject 在前，
        // 上层 catch 后据此回复 413。剩余数据排空丢弃——同步 req.destroy() 会抢在
        // 413 响应刷出前掐断 socket（客户端收到 ECONNRESET 而非 413）；排空让
        // 有限请求体自然到 end，连接随响应正常收口，同样不占 FD。
        reject(new HttpError(413, '请求体过大', 'BAD_INPUT'))
        req.removeAllListeners('data')
        req.resume()
        // R-1（十五轮登记销账）：排空只是让 413 响应先刷出的宽限，不是义务接收——
        // 慢速发送方可长期 dribble 数据占住 socket/FD。宽限到点强制 destroy：本地
        // 回环 413 亚毫秒级已送达，之后断连属预期收口；正常客户端到此早已 end
        // （close 即清定时器，不误伤）。graceMs 可注入，测试用小值保快。
        const grace = setTimeout(() => { req.destroy() }, graceMs)
        req.on('close', () => clearTimeout(grace))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      // 超限已在 data 中 reject；此处仅防御（promise settle 后重复调用无效）
      if (tooLarge) return
      const data = Buffer.concat(chunks).toString('utf-8')
      try {
        // 字面 null 体（JSON.parse('null') = null）兜底为 {}，防端点 body['x'] TypeError
        resolve(data.trim() === '' ? {} : (JSON.parse(data) ?? {}))
      } catch (e) {
        reject(new HttpError(400, `请求体不是合法 JSON：${e instanceof Error ? e.message : ''}`, 'BAD_INPUT'))
      }
    })
    req.on('error', (e) => reject(e))
  })
}

/**
 * RC 源码重审 B-4（Opus-5.5 轮）：「改地址 + Key 留空 = 沿用旧 Key」的跨主机外流闸单源。
 *
 * providers / rag-providers 两族编辑端点都用「apiKey 留空 = 不改」这条便利语义，而地址
 * （baseUrl / endpoint）可改为任意主机（误填域名、换第三方中转站）——沿用旧 Key 即把已存
 * 凭据发往新地址（下一次探测/生成/嵌入的网络往返就送达）。B-4 先在 /api/providers 落闸，
 * 复核时发现 /api/rag-providers 同型（同一段语义、另一份拷贝），故把判定与文案收敛到本
 * 文件（先例 = revision-guard.ts 的三处同名拷贝收敛）：两族端点拒绝语义逐字相同，前端
 * toast 直接透传服务端文案（服务端 message 即作者可见文案，无 FE 侧码表第二份）。
 *
 * 不变量：已存 Key 只会发往它被录入时的那台主机。主机变了就必须由作者在同一请求里显式
 * 重新提交 Key（宁可多填一次也不外流）。
 *
 * 4xx 而非 409：前端 recover409 恢复链把 409 当多窗冲突吞成刷新提示，作者将看不到原因。
 */

/** 拒绝机器码（前端按 code 分发；文案单源，避免两族端点措辞漂移） */
export const API_KEY_HOST_CHANGE_CODE = 'API_KEY_REQUIRED_ON_HOST_CHANGE'
export const API_KEY_HOST_CHANGE_MESSAGE = 'API 地址的主机已变更，为防止已存 Key 被发往新主机，请重新填写 API Key'

/** 两个地址是否同一主机（含端口）——「留空 Key = 保留原 Key」的准入判定。
 *  - 用 host 不用整串：路径/查询串/尾斜杠差异（https://api.x.com → https://api.x.com/v2）
 *    是同一主机上的常见配置调整，不该被索要重填；
 *  - 逐字相等短路：同一串必然同主机，顺带让「两侧都解析失败却完全相同的脏值」（手改
 *    providers.json 的老数据）原样提交时不误伤；
 *  - 任一侧解析失败返回 false = 按「已变更」处理（fail-closed）：判不出主机时不发已存
 *    Key，宁可要求作者重填一次。 */
export function sameEndpointHost(a: string, b: string): boolean {
  if (a === b) return true
  const ha = endpointHost(a)
  const hb = endpointHost(b)
  return ha !== null && ha === hb
}

/** 地址的主机（含端口；URL 归一化大小写/punycode IDN/剥默认端口——这些都不是换主机）；
 *  非 URL 或解析失败 → null（无法判定）。 */
export function endpointHost(raw: string): string | null {
  try {
    return new URL(raw).host
  } catch {
    return null
  }
}

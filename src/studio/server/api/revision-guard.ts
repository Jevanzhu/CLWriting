/**
 * X-25（第五十六轮）：expectedRevision 乐观并发守卫单源。
 *
 * providers / rag-providers / prefs 三处各持一份同名 revisionError 拷贝（providers P4
 * 首创、另两处照抄），校验口径与 409 文案开始漂移（「配置 / 全局偏好」措辞分裂）。
 * 收敛到本文件：判定逻辑唯一（缺失放行——旧客户端/脚本向后兼容；存在且非数字或与
 * 当前 revision 不等 → 409 冲突文案），主体名词经 subject 参数注入（providers 族
 * 「配置」、prefs「全局偏好」），三个端点的既有行为与文案不变。
 */

/** expectedRevision 缺失/为 null → null 放行（兼容旧客户端/脚本）；
 *  非数字或与 current 不等 → 409 冲突文案（调用方 replyError(res, 409, 'REVISION_CONFLICT', …)）；
 *  匹配 → null 放行。 */
export function revisionError(expected: unknown, current: number, subject = '配置'): string | null {
  if (expected === undefined || expected === null) return null
  if (typeof expected !== 'number' || expected !== current) {
    return `${subject}已在其他窗口被修改，请刷新`
  }
  return null
}

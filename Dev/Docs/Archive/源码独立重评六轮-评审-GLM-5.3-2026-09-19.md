# 源码独立重评六轮（非全量精度口径）

- 日期：2026-09-19
- 执行模型：GLM-5.3（主审 = 会话模型；子代理同模型，4 只读分域）
- 基线：`66249256`（五轮重评修复批后树，工作树净；1268 文件 = 7764 过 mac 口径）
- 作者指令：「忽略掉现有文档，重新评审下当前项目源代码，不需要全量精度代码，评审结果形成一个文档。然后全部修复。」
- 口径声明：与前五轮《全量源码独立重评》同链的**第六次独立重跑**，但按作者指令**降精度**——单波 4 只读子代理分域（A 数据与服务层 / B AI 链路 / C 文本管线+桌面+进程 / D web-next 前端+基建），核心/高危模块通读、次要模块抽样（对照：五轮为 8 分域两波逐文件通读）。评审全程不读 Dev/Docs 既有评审文档与 git log，只对源码；主审对子代理全部发现逐条「声称 vs 实态」对码复核后定稿。覆盖面弱于五轮（各域「未读」清单见 §四），结论按此口径采信。

## 一、发现总表

**P2×1 + P3×3，全数真修**；无销案、无缓办、无维持项、无 P1。

| 编号 | 级别 | 位置 | 一句话 | 处置 |
|---|---|---|---|---|
| B101 | P2 | `src/ai/gen.ts:109-146` | 单 timer 重构后 `clearTimeout` 使后续 `timer.refresh()` 全部 no-op，流中挂起检测自第 2 个 chunk 起静默失效 | 真修 + 回归×2 |
| A101 | P3 | `src/events/chat-bridge.ts:216-254` | 持续写失败下溢出裁剪把上一轮垫入的 chat_gap 标记自身裁掉，流内 dropped 计数系统性低估 | 真修 + 回归×1 |
| C101 | P3 | `src/document/structure-split.ts:154` / `structure-merge.ts:138` | 拆分/合并干跑预览按码元截断，第 60 码元劈代理对——确认弹窗尾字符乱码 | 真修 + 回归×2 |
| D101 | P3 | `scripts/verify-responses-relay.ts:63-65` | 注释声称对侧脚本 argValue「宽松直取、待对齐」已失实（对侧早已同口径） | 真修（注释勘误） |

主审对码：**4/4 成立，零翻案**。B101 前提另做独立实证（Node v26.8.1：`clearTimeout(t)` 后 `t.refresh()` 回调永不触发；未清除的 timer 对照组正常）。

## 二、逐条机理与修复

### B101（P2）流中挂起检测静默失效——`withFirstByteTimeout` 单 timer 重构的 Node 语义盲区

- **机理**：R0912-D-P3-4 把「每 chunk 新建 Promise + setTimeout」收敛为「单 timer，每 chunk `timer.refresh()` 重置」，注释声称「语义严格保持」。实态：首个 chunk 到达后代码在 `yield` 悬挂前显式 `clearTimeout(timer)`（:125），而 **Node 语义下已清除的 timer 再 `refresh()` 是 no-op**（timer 已出列；v26.8.1 实测 + Node 文档「refresh on non-active Timeout 无效果」）——此后循环顶的 `timer.refresh()`（:119）永远重启不了计时窗，`stalled` deferred 的 `rejectStall` 永无机会再被调用。**从第二个 chunk 起整条流的 chunk 间挂起检测完全失效**，文件头 P3-8 承诺的「流中途挂起同样超时」只剩注释。
- **触发场景**：provider/中转网关发出首个 delta 后连接静默卡死（TCP 半死、网关上游挂起）。预期：60s 后可重试 `GenError(TIMEOUT)` + `onStall` 主动 abort 在途 HTTP；实态：`Promise.race` 永久悬挂，只能等 runner 10min 总超时 abort → 归因 TIMEOUT_TOTAL 终态失败（**不可重试**），用户等待 60s→10min 且自动重试通道同时丢失、在途连接不被主动 abort。影响面 = `generate()` 是全库 `provider.stream()` 唯一消费入口（chat 轮循环 / self-heal 首稿重写 / rewrite / 摘要补漏 / checkpoint 压缩全经此包装）。首字节超时（chunk#1 之前）不受影响，浅层测试不暴露——正是重构漏网原因。
- **修法**：恢复每 chunk「新 timer + 新 deferred」原实现（分配成本相对 SSE chunk 解析可忽略）；每轮新 deferred 使悬挂期误触发也不污染下一轮 race。R0912-D-P3-4 注释就地勘误记档；R33D-11（任意退出路径关源迭代器）/ Q2（不 await return）/ M-3（吞清理段异常）/ RB-AI-P2-3（onStall 先于清理）语义全部保持。
- **回归**：`test/ai/gen.test.ts` 新增 2 例——①首个 chunk 后流中途挂起 → 快速超时 reject + `onStall` 触发（旧实现下该用例 30s 挂死判红，**钉住验证实测**：回滚修复复红、回贴复绿）；②多 chunk 快速续流全程无超时（防每轮新 timer 误伤正常流）。
- **置信度**：高（Node 文档语义 + 本机 v26.8.1 双实验 + 代码路径逐行核实 + 钉住验证）。

### A101（P3）SessionRecorder 溢出路径把上一轮 chat_gap 断链标记自身裁掉

- **机理**：`flush()` 落库失败且 pending > 256 时丢最旧并在批首垫 `{type:'chat_gap', data:{dropped}}`（B406「丢事件必留痕」凭据）——但垫后 pending 恒为 **257**（1 标记 + 256 存活），下一次失败 flush 的 `dropped = 257−256 = 1`，被裁的第 0 项**恰是上一轮的 gap 标记**：第一轮真实丢弃 N 条的唯一落库凭据被无声替换，新标记只记 1（还把旧标记计成一条「被丢事件」）。持续写失败（正是该降级路径设计针对的场景）下每轮如此，事件流最终只留最后一轮计数，`dropped` 系统性低估累计丢弃量，审计侧无法得知真实断链规模。
- **修法**：裁剪前检查 `droppedEvs[0]` 是否为旧 chat_gap 标记——命中则其 `dropped` 累加进新标记、且不计入本轮被丢事件条数（凭据延续非凭据丢失；标记只由本路径垫在批首、`add()` 只追加，旧标记若在必居 `droppedEvs[0]`）。warn 文案同步（本轮真实丢弃数 + 合并上轮计数 → 累计）。
- **回归**：`test/events/session-recorder-gap-marker.test.ts` 新增 1 例（三轮连续溢出：45 → 合并保持 45 → 45+50=95；保留段边界 / 恢复落库恰一条 gap / 折影与校验链安全忽略全断言）。
- **置信度**：高（机制直接读码可证；标记只在最终成功 flush 落库、无其他补偿通道已核）。

### C101（P3）拆分/合并干跑预览按码元截断劈代理对

- **机理**：`tailPreview` / `sourcePreview` = `canonicalizeText(...).trim().replace(/\n+/g,' ').slice(0, 60)`——`slice` 按 UTF-16 码元计数，第 60 码元落在增补平面字符（CJK 扩展 B 生僻字、emoji）内部时劈出孤立高代理，确认弹窗预览尾字符渲染 U+FFFD 乱码。影响面止于预览显示（不落盘；apply 侧有 B101 代理对光标守卫），但与本仓既有码位截断纪律（R-11 `clipByCodePoints` / D401 伏笔码点回退 / B001 拆分光标守卫）口径不一、无注释声明码元语义，属漏网非取舍。
- **修法**：`clipByCodePoints` 自 `src/process/summary.ts` 下沉 `src/shared/text.ts` 单源（沿用 codePointLength 复审-0914-优化 A2 下沉先例；summary.ts re-export 保住既有 10 处消费方 import 面不变）；两处预览改 `clipByCodePoints(..., 60)`（document→shared 无依赖倒挂）。
- **回归**：拆分/合并两测试文件各新增 1 例（80 个 `𠮷` U+20BB7 → 预览恰 60 码位/120 码元整字符）。拆分用例置于文件末尾新 describe（本文件用例按执行顺序连续取号断言 max+1，高章号垫中间会搅既有用例的取号/文件名预期——批内自纠如实记档）。
- **置信度**：高。

### D101（P3）verify-responses-relay.ts 注释指向不存在的待办缺陷

- **机理**：:63-65 注释称 calibrate-tokens.ts 的 argValue「宽松直取形态（会吞 `--flag` 作值，待另行对齐）」——实态该处已含严格口径并自带 R0912-3 #49 对齐标记，两脚本判式等价。行为无缺陷，但注释误导后续维护者（可能据此去「修」对侧或在安全审计中误报）。
- **修法**：注释就地勘误（两脚本已同口径，勿据旧注再修对侧）。
- **置信度**：高（两文件亲读核对）。

## 三、干净面（各域核实过无问题的方向，一句带过）

- **A 域**：事件库核心（INSERT RETURNING 血缘 / 迁移锁 + 墓碑 + 自愈）、投影/分支/遮蔽、HTTP 面（Host/Origin/token 三闸、SSE 背压击杀、静态 canonical 判界）、删书/改名生命周期（case-only dev+ino 判定）、providers 凭据面（全遮蔽 + revision 双重乐观锁）、fs 原语（tmp+fsync+rename / 锁 payload 校验 / realpath 判界）、cache 重建 / worker 壳 / 日志脱敏 / git exec / 崩溃恢复逐一核过。
- **B 域**：三适配器流式聚合（usage 末见 wins / toolAccum / finish_reason 守卫 / 伪流回填）、错误处理链（非 2xx / 建连 400 降级 / 传输截断 / B-12 通道）、Unicode 全线码点口径、红线「模型可见 ⟺ 已记录」（visibleInjections 与注入条件镜像、CLW_VERIFY_VISIBLE 抽样在位）、记账与凭据（跨进程锁 / HKDF→KEK→DEK / redactSecret 单源）、RAG（embed 超时与非 2xx body.cancel / 唯一键防重 / 分批续传）、chat 编排（六出口回滚遮蔽 / checkpoint 截断回落）。
- **C 域**：desktop 全 24 件（os-kek v2 防误重建 / kill 升级链 / quit 不可回头点 / IPC 白名单 / 字体枚举三平台单源）、format 统计与截断（countWords 单遍码点 / ngram 双哈希 astral 判别 / sanitizeFileNamePart NFC+保留名+双封顶）、process 保存链（回收站双认领→锁→复核→isUtf8→journal 配对→fsync）、拆分/合并/undo 守卫族、install/check 的穿越与 NUL 拒绝。
- **D 域**：切书链三段确认 + 脏路由冲刷、全库 useStaleGuard 代守卫三件套、错误路径残留清理（F102/F103 修复面在位）、内存泄漏（rAF/timer/监听成对清理）、保存/冲突链（乐观锁→双出路→refresh 重对齐）、SSE/心跳（ticket 两段式 + fail-closed）、基建 13 脚本 + workflows + 根配置互检（SHA 钉版 / 观察档到期锚未过期 / 三 check 契约一致）。

## 四、覆盖面（非全量精度，如实记档）

- **全文读**：`src/events/` 全部；`src/studio/server/` 核心（index/http/router/static + api 22 件含 audit/chat-history/stream 族/books 族/providers/files/snapshots/settings）；`src/fs/` 全部；`src/cache/`·`src/state/`·`src/git/`·`src/log/`·`src/shared/`·`src/export/`·`src/driver/(cc,index)`·`src/knowledge/`·`src/learn/(commit)`；`src/ai/` 主链（gen/runner/calls + provider 全件 + prompts 全件 + orchestrate 主链 + tools/contract 主件）；`src/rag/` 全部；`src/desktop/` 全 24 件；process 主链（draft-pipeline/retry/gui-active/summary）；format 9 件；check 4 件；web-next stores 全 16 件 + composables/views/editor/api/shell 主链；scripts 13 件全读；workflows/action/根配置全读。
- **抽样**：metrics/style、short-index 前 200 行、learn/index 前半、document/service 关键段、web-next shared/*（经消费方调用链核对）。
- **未读**（不代表无缺陷）：`src/studio/server/api/` 其余 ~33 件（documents 族/draft/review/analysis/overview/search/check/config/prefs/onboard/outline/progress/rag 族/rewrite/rhythm/foreshadows/knowledge/cost-stats/trace-stats/ai-status/heartbeat/startup-notices/state/style 族/chat-branches/lead-updates）；C 域 document/format/process/check/install/review 的编排与迁移件约 30 件；D 域 web-next 纯展示组件（Wb*/shelf/overview/style/learn/relations/Settings*/Ribbon/TabBar/Modal 类等，由 :key 重建 + store 守卫结构性覆盖）；B 域 ai/contract、rules、tools、prompts 的薄声明/文文件。

## 五、修复面与门

- **修复 4 项全量真修**：src 6 件（`ai/gen.ts` 每轮 timer+deferred / `events/chat-bridge.ts` gap 标记合并 / `shared/text.ts` clipByCodePoints 下沉 / `process/summary.ts` 改 re-export / `document/structure-split.ts` 与 `structure-merge.ts` 预览码点截断）+ scripts 1 件（注释勘误）。
- **测试**：净 +5 用例/±0 文件（gen×2 / gap-marker×1 / 拆分×1 / 合并×1），全无平台门。
- **门 = L2 九门 mac 亲跑一次全绿**：vitest 全量 1268 文件 = **7769 过 + 8 跳 0 败（154.15s 一次净跑）** + tsc 0 + vue-tsc 0 + eslint 0/0 + 三 check 过（counts 1268/7769/33/54 README 修账后对账绿 / packaging / knowledge）+ e2e 51 过 3 跳 40.2s（跳 = 发布门 spec 预期口径）+ coverage 阈值门红 0 条（实录见批记行）。差值锚 68 维持（win 静态推演 7701 过待实跑核对）。
- **钉住验证**：B101 回归用例对旧实现复红（30s 挂死）后回贴修复复绿。

## 六、遗留与边界

- 《四轮修复复核-评审-GLM-5.3-2026-09-19》仍未收口在位（01-评审/），其 P3×4 处置面维持「随作者另令」，本批不涉。
- 六轮发现中无一与前五轮修复面重叠（五轮 C102 知识注入截断与本轮 C101 预览截断同族但不同点位——前者已修点位零复发，后者为漏网点位新发现）。

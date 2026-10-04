# 多库多窗-评审-DeepSeek-V4.1-Flash-2026-10-04

- 执行模型：DeepSeek-V4.1-Flash（ZCode；会话模型标识 `new-provider/deepseek-v4.1-flash`）
- 评审对象：commit `d63cf868`「多库多窗：一库一实例落地」（29 路径 / +1011 −130；win 分支 HEAD，mac 分支同提交）及其直联上下游——桌面启动链、跨进程锁、全局偏好 API、窗口几何、e2e/CI 接线
- 评审方式：按指令忽略既有文档结论——先全量重读本批 diff 与相关模块源码，再在本机（win32）实测复跑；既有设计文档仅在成稿前用于核对「已登记残余项」，不作为结论依据。只产报告，不修复
- 结论速览：**实现质量高、复用克制、注释与测试纪律明显高于均值**；但 win 线存在 **1 处确定性红**（新增单测平台依赖断言，win 腿必红），另有 **2 处 P2**（新入口失败面反噬主进程；核心 e2e 零 CI 接线）。批次当前在 win/mac 双线上**不满足「全绿」口径**，不满足收口条件

---

## 一、评审范围与实测（本机 win32，2026-10-04）

| 检查项 | 命令 | 结果 |
|---|---|---|
| 全量单测 | `npx vitest run` | 3 档红 / 4 用例红（档 1282 绿 / 7 跳过；用例 8746 绿 / 75 跳过 / 4 红；总 8825 与 mac 侧 8817+8 一致） |
| 新增启动解析单测 | `npx vitest run test/desktop/startup-instance.test.ts` | **2 用例确定性红**（= §三 P1-1） |
| 服务端静态两档复跑 | `npx vitest run test/studio/server/static.test.ts test/studio/server/static-fallback-canonical.test.ts` | 绿——全量并行负载下曾红一次，单跑不复现（见 §六） |
| 类型 / 风格 | `npx tsc --noEmit`；`npm run lint` | 净 |
| 五 check | `check:counts` / `check:docs` / `check:comments` / `check:knowledge` / `check:packaging` | 全过；README 计数 8392 单测 / 1292 档 / 34 spec 与实测一致 |
| spawn 失败面 | Node 最小复现（不存在可执行体） | `'error'` 事件无监听 → **uncaughtException**（= §三 P2-1 机理） |
| e2e CI 接线 | `grep -rn "multi-instance" .github/` | **零命中**（= §三 P2-2） |
| 打包态 e2e 本机复跑 | — | 未跑：`dist-electron/` 为 2026-09-13 旧包（不含本批代码），未重建，如实声明 |

---

## 二、总评（三问）

**1. 代码是否足够优雅简洁？** 是，整体良好偏优。本批几乎全部建在既有基座上而非新造：跨进程锁直接复用同步/异步孪生与陈锁接管（`fs/cross-process-lock.ts`），路径折叠复用 `platformCaseFold`，spawn 双形态复用 `scripts/electron-smoke.mjs` 先例，目录校验链复用 `pickLibrary`；守卫链抽单源 `guardLibraryDir` 顺带解掉 `registerIpc` 超长；窗口几何迁移取「读侧回落共享根、写侧恒实例目录」最小面；e2e 期望值直接调真实现算（不手抄公式）。扣分只在注释漂移（P3-5）与一处等值薄壳（P3-6），无结构级新债。

**2. 完成质量是否足够高？** 高，但有「win 线不成立」的硬伤。设计与落地对位充分（抽查 D2 实例 key、D3 目录拆分、D4 原生锁涌现，均与源码逐条吻合）；测试事故（用例写盘覆写作者真实 workdir.json）如实入册 + 按语义反推还原 + 静态守卫门升格为机器门，是全批最亮眼的质量动作；新增测试锚点克制（解析序、落盘、e2e 走用户可见面）。但 P1-1 使 win 线（本机与 CI win 腿）确定性红——「L2 全绿」的声称只在 mac 侧自洽。

**3. 有没有正确性隐患？** 产品主体逻辑未发现 P1 级缺陷。新入口有一处失败面缺陷（P2-1：spawn 的异步错误未接管，可把整个应用带崩）；一处防线口径不一致（P3-1）与一处已登记的静默降级（P3-2）属低概率残余。

---

## 三、问题清单

### P1-1 新增单测平台依赖断言——win 线确定性红（含 win CI 腿）

- **靶**：`test/desktop/startup-instance.test.ts:53-70`（两用例）。
- **现象**（本机实测）：用例以 posix 字面值断言，而实现走 `path.resolve()`（平台语义）。win 上 `resolve('/libs/Arg')` → `G:\libs\Arg`，断言必败：

  ```
  FAIL test/desktop/startup-instance.test.ts > --dir 优先于 workdir.json.current 与 cwd 发现
  AssertionError: expected { dir: 'G:\libs\Arg', source: 'arg' } to deeply equal { dir: '/libs/Arg', source: 'arg' }
  FAIL …无 --dir → 读 workdir.json.current（相对路径 resolve 为绝对）
  AssertionError: expected { dir: 'G:\libs\Stored', … } to deeply equal { dir: '/libs/Stored', … }
  ```

- **影响**：`ci.yml` windows-latest 腿（Node 24）跑全量 `npm test` → 该档必红；win 分支本机无法通过 L2。产品代码本身（`dirArg`/`stripDirArg`/解析序）无缺陷——纯用例期望值未平台化；mac/linux 侧 `resolve()` 对绝对 posix 路径恒等，故 mac 侧 L2 自洽。
- **定级理由**：确定性、可复现、发生在出货平台的持续门上（门级 P1，非产品面缺陷）。
- **建议修法**：期望值经同一 `resolve()` 归一（如 `expect(r).toEqual({ dir: resolve('/libs/Arg'), source: 'arg' })`），或改用 `join(tmpdir(), …)` 合成路径；改后 mac/linux 语义不变。

### P2-1 spawn 异步错误未接管——失败时反噬整个应用

- **靶**：`src/desktop/new-instance.ts:21-38`（spawn 调用在 24-31 行未挂 `'error'` 监听）。
- **机理**：`child_process.spawn` 的启动失败（ENOENT/EACCES/EMFILE 等）是**异步 `'error'` 事件**；无监听时 EventEmitter 将其抛出 → main.ts 的 `uncaughtException` 链（记日志 → stopChild → `process.exit(1)`）→ **全部窗口随主进程退出**。函数内 try/catch 只接得住同步抛出（参数类型类），返回 `false` 的契约与调用方（菜单错误框 / IPC `{ok:false,reason}`）的失败路径在该类故障下均不可达。本机最小复现证实：spawn 至不存在可执行体 → 500ms 内 `UNCAUGHT: ENOENT`。
- **影响**：触发概率低（execPath 缺失/权限/句柄耗尽/杀软拦截），后果重（点一次菜单即全应用退出）——与仓内既有判例（「裸 void 调用下 dialog reject → 点一次菜单 = 应用静默退出」按缺陷处理）同标准。
- **建议修法**：至少 `child.on('error', (e) => log.error(...))` 吞住并留痕（保持「进程已发起」契约）；若要保住「失败弹框」语义，改异步确认（首拍无 error 再返回，或子进程就绪信号）。

### P2-2 多库多窗 e2e 未接任何 CI——核心新功能只有手跑门

- **靶**：`test/e2e/multi-instance.spec.ts`（:33 挂 `CLWRITING_E2E_RELEASE` 门）与 `.github/workflows/desktop.yml`。
- **现象**：全仓工作流零调用方（`grep -rn "multi-instance" .github/` 空）。常规轮因 env 门计入跳过；`test:e2e:release` 只点名 `release-smoke`；desktop.yml 只显式加跑 `packaged-app-smoke`（:342-349）。即本批**最核心的用户可见功能**（异库并行 / 同库单实例 / 实例目录隔离）的自动化只有「手动跑」——与 H101 对 `packaged-app-smoke`「零调用方死 spec」的结论同型，且本 spec 比它更贴发布链。
- **建议修法**：desktop.yml 在 mac 腿 `packaged-app-smoke` 步旁加一行 `CLWRITING_E2E_RELEASE=1 npx playwright test test/e2e/multi-instance.spec.ts`（同款 glob 定位 `CLWRITING_E2E_APP_BIN`）；win 腿需先补 `build:desktop:dir` 产物步（win 腿现无），按需评估。

### P3（便宜随批，或记理由后登记）

1. **实例 key 的折叠口径与 `samePath` 不一致（darwin 缺 NFC）**：`libraryInstanceKey`（`src/fs/user-data-path.ts:69-71`）用 `platformCaseFold`（仅小写化），而同文件 `samePath`（:85-90）在 darwin 已叠 NFC 归一。后果：(a) mac 上同一库的 NFD/NFC 两种拼写可能派生两个 key，同库单实例防线被绕过；(b) `main.ts:378` 的「key 与实际库不一致」诊断用 `samePath` 判定——key 真的分裂时它反而判「一致」不告警，两个原语互相拆台。触发需非 ASCII 组合字符路径（CJK 无分解形态，实际多为西文重音），概率低；win 侧**不得**加 NFC 折叠（NTFS 对 NFC/NFD 敏感，`samePath` 注已明示）。设计仅登记过大小写漂移形态，建议随批补 darwin-only 归一或如实登记。
2. **bootstrap 与实例 key 不一致的降级仅 `log.warn`，用户不可见**（`main.ts:376-383`）：该形态（current 失效 → 回落 cwd 发现他库）下本会话的同库双写防线静默降级。仓内 `startupNotices` 横幅机制现成，建议接上或至少在文档声明「仅留痕」的取舍已定。
3. **workdir.json「清空形态」旧防御分支随重写消失**（`workdir-controller.ts:140-153`）：旧实现存在「读失败闸置位 + 重读成功 + 盘上有真内容 → 拒写清空形态」的兜底（原文自注「防未来新增写方」）；新实现只按「锁内读失败」拒写。当前无写方触达（rollback 快照在读失败时按无基线处理，:202-216），属口径变化而非现行缺陷；但新注释称「按字面写入（原语义）」，对旧防御分支的退场未记，建议补一句。
4. **第二实例在锁判定前已写启动日志**（`main.ts:119-124` 先于 :131 锁请求）：同库二次拉起时向持锁实例的日志文件并发 append 1~2 行（G4 同源微窗）。设计 §4.4 留了「实施时定是否延后 initLogging」，实施未动、也未记取舍——建议记一句（保留现状可，理由写清）。
5. **注释漂移两处**：`src/desktop/workdir-store.ts:4` 仍写「持久化文件 userData/workdir.json」（现为共享根，词义已变）；`src/desktop/startup-instance.ts:14-16` 称「本模块只服务『算 key』这一件事」，但 `main.ts:334` bootstrap 已消费其解析结果（`source`/`dir`）。仓内口径「失实备案比没有备案危险」，建议随批修正。
6. **等值薄壳**：`pickLibraryDirForNewWindow`（`workdir-controller.ts:556-559`）是已导出 `pickLibrary`（:578）的等值别名 + 一条意图注释——可删（直接调）或明示「别名」，当前两个名字指向同一行为。
7. **dev HMR 形态下多库多窗不成立（未登记）**：`CLW_DEV_UI=1` 时 main 不起 server（`main.ts:397-402`），渲染层经 Vite 固定代理连 dev:api（7878，单 workDir，`scripts/dev-api.ts:49-55`）——spawn 出的第二个 dev 实例仍指向同一库。属开发面、非产品面；建议注释或设计登记一句。

---

## 四、已核无问题与高质量点（防误报清单）

- **启动序三约束全部守住**：instanceKey 零磁盘 IO（未用 `trueCasePath` 那条失联卷冻结链）、`setPath('userData')` 之前同步算出、单实例锁请求在 `setPath` 之后（`main.ts:112-137`）；welcome 固定 key 与 hex key 不同形不撞（`WELCOME_INSTANCE_KEY`）。
- **argv 清洗与解析序互补**：`dirArg` 双形态取值 / `stripDirArg` 双形态摘除，`app.relaunch({ args: stripDirArg(process.argv.slice(1)) })` 显式传参（对齐 Electron 缺省 `argv.slice(1)` 语义），切库重启不再被旧 `--dir` 顶回。
- **「同库单实例、异库多实例」确由 Electron 原生锁作用域涌现**（实例目录 = userData）；`app-instance-guard` 锁文件随实例目录，同库提权双开防线保留；e2e 第三实例 `exit 0` 断言与该路径一致。
- **workdir.json 写改为「锁内以盘上真身重放 setCurrent」**：单实例下与旧行为逐位等价，多实例下他实例新增 recent 不丢（单测 G3 两条：合并保留 + 读失败拒写，`switch-library-cancel-rollback.test.ts`）；锁获取失败契约化上抛，不静默裸写。
- **global.json RMW 双闸分工正确**：跨进程异步锁治丢更新、revision 乐观锁治用户可见冲突，超时契约化 500；与 providers.json 先例同构，无死锁面（无嵌套取锁）。
- **window-state 迁移面收敛最小**：读侧「实例档 → 共享根旧档」一次性回落，写侧恒实例目录（`windows.ts:389-421`）；e2e 反向断言共享根不再产生新档。
- **共享面逐一核查无新缺口**：端口 `--port 0` OS 分配（双实例无冲突）；事件库按 bookHash 分库 + 迁移锁（异库天然并存）；providers.json 已有锁 + revision；studio-token（G6：各实例各连自己的 server，末写者胜仅影响下次读值）与 os-kek（G5：通道搁置中）均已登记在案；prompts overlay 迁移同 hash 表驱动、原子写幂等，双实例并发等价（未加锁但无差异化写入）。
- **测试纪律**：新单测锚解析序（回退即红）；e2e 直接引 `libraryInstanceKey` 真实现算期望值、cwd 取中立目录防「兜底假绿」、第三实例起退断言防「锁失效假绿」；隔离门自带正反例自检（不空转）。事故处置「如实入册 + 反推还原 + 机器门」值得保留为例。
- **声称的 L2 数字自洽**：win 侧复核 `tsc` / `eslint --max-warnings 0` / 五 check 全绿，README 计数与实测一致；mac 侧数字（8817+8=8825）与本机总数吻合。

---

## 五、收口条件（建议）

1. **必办**：P1-1 一行修（期望值 `resolve()` 归一）→ win 全量复跑绿——否则 win 线不成立，本报告不得收口。
2. **建议同批**：P2-1（挂 `'error'` 监听）、P2-2（desktop.yml 加一行 e2e 步）；P3-5 注释两处顺手；P3-1 视成本（darwin 一行 normalize）。
3. **可登记**：P3-2/3/4/6/7 记理由或随批。
4. **复跑门**：win 全量 + 五 check；动 CI 接线时 release 门三 spec 同跑取证；mac 侧复验（本机无 mac 产物，未能代验——如实声明）。
5. 本报告完成 ≠ 收口：P1/P2 修复 + 回归通过后方可收口归档。

---

## 六、附录：观测与声明

- **并行负载 flake 观测**（与本批无关，供甄别）：全量单跑时 `test/studio/server/static.test.ts` 与 `test/studio/server/static-fallback-canonical.test.ts` 各红 1 例（`TypeError: fetch failed / Caused by: Error: bad port`，抛自 `test/helpers/studio-token-setup.ts:82`），单档复跑全绿——服务端静态托管/端口 helper 路径，不在本批改动面。是否登 `win腿间歇红台账`（「未定位到具体用例」族或有归并价值）由作者定夺。
- **未执行项**：打包态 e2e（multi-instance / packaged-app-smoke）未在本机复跑（现有产物为多库多窗前旧包）；mac 侧未复验。评审未覆盖发布链与 CI 工作流以外的运行时环境差异。
- **登记项核对**（成稿前对照既有设计文档，仅用于核对登记，不作结论依据）：G5（os-kek 通道恢复）、G6（studio-token 并发创建）与「CJK 平台折叠残余」均在案；本报告 P3-1（NFC）为其同族**新形态**，建议并入同一登记条目。

---

## 七、收口记录（2026-10-05；执行模型：ZCode / DeepSeek-V4.1-flash）

**结论：P1×1、P2×2 全办结，P3 七条全处置（实修 6 / 记理由 1），§五 收口条件满足。**

### 7.1 P1/P2（3 条，全实修）

| 条 | 处置 |
|---|---|
| P1-1 单测平台依赖断言 | 期望值经 `resolve()` 归一（`test/desktop/startup-instance.test.ts`）——win 上 `resolve('/libs/Arg')` → `G:\libs\Arg` 与实现同源；mac/linux 对绝对 posix 路径恒等，语义不变。本机 win 实测：修前该档 2 用例确定性红、修后绿 |
| P2-1 spawn 异步错误反噬 | `spawnLibraryInstance` 改 Promise 化：'spawn'/'error' 二择一先到先落（settled 门防双发），'error' 有监听即被消费、不再升级 uncaughtException；同步抛（参数类）try/catch 原样保留。调用方 `main.ts` 菜单与 `ipc.ts` 改为 `await`（错误框 / `{ok:false,reason}` 契约面自此真可达）。新增 `test/desktop/new-instance.test.ts`（4 例：打包/dev argv 形态、异步 ENOENT → false 且不抛、error 先到后 spawn 迟发的 settled 门） |
| P2-2 e2e 零 CI 接线 | `desktop.yml` 双腿接线同名步「多库多窗冒烟（multi-instance…）」：mac 腿置于 packaged-app-smoke 之后（同款 RUNNER_TEMP 副本 + glob + `test -x` 防假绿），win 腿置于 window-cycle 冒烟之后（pwsh 定位副本 + `$LASTEXITCODE` 真失败不吞）。本地以同命令形态实跑取证（见 7.4）；CI 实跑待推送（如实声明） |

### 7.2 P3（7 条：实修 6 / 记理由 1）

- **P3-1（实修）**：`libraryInstanceKey` darwin 臂叠 NFC 归一（`src/fs/user-data-path.ts`），与 `samePath` darwin 臂同口径——NFD/NFC 两种拼写归同 key；win32 维持纯小写（NTFS 对 NFC/NFD 敏感，不折叠）、linux 全等不变。单测 2 例：darwin NFD/NFC 折同 key（前置断言两拼写确非同形路径）、win32/linux 不折叠。
- **P3-2（实修，升级为真防线）**：bootstrap 检测「实例 key 与实际采用库不一致」时，向**实际库**的实例目录补挂一道实例守卫（`main.ts` bootstrap 尾）——此后任何以该库为 key 的实例经 `acquireAppInstanceGuard` 见其在持即自退，本会话的同库单实例防线恢复；补挂时若实际库已在他窗口打开（`supplement.acquired === false`）则 `showErrorBox` 明示后自退本实例，不静默双开。`app-instance-guard.ts` 单槽释放改 `activeReleases` 多槽注册表（exit 钩子逐条释放，`releaseAllGuards` 导出供测试锚定）；锁面异常 fail-open 与既有口径一致。新增多槽单测（双目录双守卫并存 + 逐条释放）。
- **P3-3（记理由）**：`workdir.json` 清空形态旧防御分支的退场按建议补记于 `workdir-controller.ts` writeStore 头注——存续唯一无 current 写方（rollback）在快照读失败时按无基线处理、不触达该路，旧分支为零调用路径；若未来新增清空写方须在写方侧按同判据补防线（通用写入层重加会把合法回滚一并拦死）。
- **P3-4（实修）**：诊断启动行（「实例启动：key=…」）自顶层移入锁判定后的 else 分支——未持锁瞬态实例不再向持锁实例日志混入该行；`initLogging` 留原处（幂等、更早失败行仍可落盘），取舍已记入设计正本 §4.4。
- **P3-5（实修）**：注释漂移两处修正——`workdir-store.ts` 头注「userData/workdir.json」→「`<共享根>/workdir.json`（多库多窗起脱离 Electron userData）」；`startup-instance.ts` 头注补「main bootstrap 同时消费其解析结果（`source === 'arg'` 显式意图优先）」。
- **P3-6（实修）**：删除等值薄壳 `pickLibraryDirForNewWindow`（`workdir-controller.ts`），`main.ts` 菜单改直呼 `pickLibrary`。
- **P3-7（实修）**：dev HMR 形态边界（`CLW_DEV_UI=1` 起多库多窗不成立——渲染层连固定单库 dev:api）补入 `new-instance.ts` 头注（开发面既定边界，产品面只认打包/常规 dev 形态）。

### 7.3 附批（报告外，本批顺带根治）

- **win 腿「bad port」间歇红根因修复**（§六观测 → 根治）：`test/helpers/safe-port.ts` 受限端口表为 2026-09-01 手抄，较 undici 现行常量表缺 4190/6679 两条，恰落本机自定义动态段（1024-15000）内——随机抽中即整档红。已补全，并新增机器门 `test/helpers/safe-port.undici-sync.test.ts`（从 undici 源文本取真值双向比对，缺/多均红）防再漂移；win 台账登记条目处置态同步更新为「已修」（销账依据 = 根因修复批入库）。
- **packaged-app-smoke win 形态补全**（收口复跑时发现）：该 spec 原断言「原生 select + options」为 mac 形态（`FontPicker.vue` win 走自绘浮层：触发钮 `[aria-haspopup=listbox]` + Teleport `[role=listbox]/[role=option]`），win 腿此前从未接线过该 spec、无暴露。断言改双形态分支：win 走浮层（触发钮可见 → 展开 → option 数 ≥2 → Esc 收起），非 win 走原断言逐字不动。

### 7.4 回归（全门实录，2026-10-05，本机 win 腿）

```
npx tsc --noEmit                                  exit 0
npm run lint（eslint --max-warnings 0）            exit 0
npx vitest run                                    1294 文件（1287 通过 / 7 跳过）/ 8759 用例通过 + 75 跳过（8834），360.9s，exit 0
npm run check:counts                              exit 0（1294 文件 / 8401 单测；34 spec / 55 用例；Archive 22 篇）
check:docs / check:comments / check:packaging / check:knowledge   exit 0
打包 + release 门三 spec（本机 win，CLWRITING_E2E_RELEASE=1 定向逐跑）
  ├─ multi-instance.spec.ts                       1 passed（打包态新产物：异库并行 / 同库第三实例起退 / 实例目录隔离全链）
  ├─ release-smoke.spec.ts                        2 passed
  └─ packaged-app-smoke.spec.ts                   1 passed（双形态补全后；补全前 win 形态红=7.3 第二项）
```

全量单测首跑即全绿（对比评审时 3 档 4 用例红 → 0）；单测 +9 例（新开 2 档 `new-instance.test.ts` 4 例 / `safe-port.undici-sync.test.ts` 2 例，既有档补 3 例：user-data-path 2 / app-instance-file-lock 1），README 计数 8392→**8401**、1292→**1294** 档，`CLAUDE.md` 档数同步（`check:counts` 实测对账）。

**效力边界**：本节为本机 win 腿实测；**mac 侧未复验**（本机无 mac 产物/环境，如实声明）——mac 兼容性依据：P1-1 期望值归一在 posix 语义下逐位不变、e2e 双形态分支非 win 走原断言逐字不动、P3-1 的 NFC 臂 darwin-only 由单测以 mock 平台钉住。打包踩坑记录（环境面，非仓内改动）：本机到 GitHub releases 的网络不通，`build:desktop:dir` 卡在 winCodeSign 下载——已从 npmmirror 取官方 `winCodeSign-2.6.0.7z`（sha256 与 app-builder-lib 内嵌校验一致）预置 electron-builder 缓存后打包通过。

### 7.5 收口归档

- 上一轮 09-30 复审报告（已收口）随批移入 `Archive/`（21→22 篇）；本报告置「已收口」态留在 `01-评审/`，待下一轮评审落地时随批归档。计数与地图同步 `Dev/Docs/README.md` + 总览 §1.3。
- 设计正本 `02-执行/多库多窗-设计方案-2026-09-29.md` 随批回填：§4.4 D4 日志位置定案；§六.5（大小写/规范化残余 → darwin 归一后处置完毕）、§六.6②（bootstrap 降级残余 → 补挂守卫升级为真防线）处置态更新。

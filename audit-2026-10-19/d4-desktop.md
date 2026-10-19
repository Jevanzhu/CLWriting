# 域4 审计报告:桌面壳 / 安装更新 / 知识层与检索 / 共享层

- 审计对象:CLWriting-Main(G:\02^Workspace\01^Codes\CLWriting\CLWriting-Main),HEAD 1160 commits。
- 范围:src/desktop(28 档)、src/install(12 档)、src/update(6 档)、src/knowledge(11 档)、src/rag(8 档)、src/shared(22 档);对照 test/desktop(60 档)、test/install(35)、test/update(4)、test/knowledge(13)、test/rag(41)。
- 证据纪律:仅源码/配置/测试/提交记录;docs/、知识层/、.agents/notes/、README.md 的结论与数字一律未采信。所有结论可复核(file:line)。
- 只读声明:本报告为唯一产出,未修改任何源码/配置/测试,未执行 commit 类操作。未跑全量测试与 coverage(仅静态阅读 + 计数型 pwsh/grep)。
- 逐档行数(Measure-Object 口径):desktop 8251、install 2590、update 841、knowledge 1796、rag 2397、shared 1729;六域 87 档、Get-Content 口径 18636 行。
- 提交史抽样:触达本域的提交 desktop 170 / install 115 / rag 87 / knowledge 41 / shared 20 / update 11;主题含「修复/竞态/锁/shutdown/幂等/损坏」者 146 条。改动最频文件:main.ts 120 次、books.ts 53、rag/index.ts 53、server-manager.ts 50、rag/store.ts 41。结论:本域经 10 余轮全量重评修复批,残存问题以「防线纵深/信任模型」与「注释纪律」为主,未发现可达的 P0。

## A. 问题清单

| ID | 严重度 | 类型 | 证据(file:line) | 影响 | 建议 | 置信度 |
|---|---|---|---|---|---|---|
| A-1 | P2 | 供应链/信任模型:校验值与被校验对象同源,下载域名不校验 | src/update/asset.ts:49-57(`digest` 取自同一 releases 响应)、src/update/download.ts:142-147(给定 sha256 优先)、:153(直接 fetch `checksumsUrl`)、src/update/check.ts:169-175(结果内嵌 asset/checksumsUrl)、src/desktop/update-controller.ts:175-185(把同一响应的 url/checksumsUrl 交给下载) | releases JSON 被篡改(系统代理/TLS 中间盒/GitHub 账号失陷)即可让应用下载任意 URL 的包,并以同源提供的 sha256「校验通过」;便携包无代码签名校验,最终由更新助手换进应用目录并拉起 | 校验值走独立信任锚(内嵌公钥签名或独立域发布的清单);对 `asset.url`/`checksumsUrl` 加域名白名单(github.com / objects.githubusercontent.com) | 高(代码路径确定)/触发概率低 |
| A-2 | P2 | 解压面缺总量与条目数上限(解压炸弹/写满盘) | src/update/extract.ts:74-83(仅 `validateEntrySizes`,无累计字节与条目数封顶)、src/desktop/update-helper.ts:279-285(空间预检 = zip 体积 ×3) | 高压缩比包可在用户机器上写满系统盘(解压以用户权限、写向 `-new-<版本>`);助手侧无回滚面以外的资源保护 | 解压中累计解压字节/条目数封顶(如 ≤ zip 体积 ×N 且 ≤ 绝对上限),超限整体失败并清理 | 高 |
| A-3 | P2 | 更新助手 argv 无来源校验:任意 `--target` 目录可被改名/搬走 | src/desktop/update-helper.ts:87-111(argv 解析)、:294-321(`swapDirs` 对 targetDir rename + 递归删 newDir)、:247-269(`precheck` 仅查 payload 存在与可选 sha256/实例;:253 `if (inv.sha256)` 缺省即跳过包体复核;:263 `--home` 缺省即跳过实例检查) | 同权本地进程可构造 `--apply-update --payload <任意 zip> --target <任意目录>` 让应用改名/搬走/覆盖任意目录(数据自伤面;非权限提升——同权攻击者本可直接改盘) | targetDir 必须等于 `dirname(process.execPath)` 且含 `PORTABLE_EXE_NAME`;payload 必须位于 `updateCacheRoot` 下;sha256 缺失改为拒绝(测试显式开关放行) | 高 |
| A-4 | P2 | 安装链缺显式防降级断言 | src/desktop/update-controller.ts:209-226(`prepareUpdateApply` 仅比对 `pending.toVersion === opts.version`,无版本大小断言)、src/desktop/update-helper.ts:328-407(全程不比较 from/to);对照检查链 src/update/check.ts:167(`tag <= current` 直接 return) | 端到端链路当前闭合(检查只在更高版本时产 pending),但任一处漂移(前端传参、未来接线、内存态残留)即可把旧版本装回,且全链无一处 fail-closed 版本断言 | `prepareUpdateApply` 与助手各加 `compareSemver(to, from) > 0`;不符即拒绝 | 高(缺口)/可达性中 |
| A-5 | P2 | 一次性结果信箱「读后即删」语义零本域测试 | src/update/cache.ts:131-139(`takeUpdateAttemptNote`,读后 rm、删除失败仍返回);test/ 全目录 grep `takeUpdateAttemptNote` 零命中(本域测试只用 `readUpdateAttemptNote`,见 test/desktop/update-helper.test.ts:15,208) | 该信箱是「新版起不来」场景唯一反馈通道(旧进程已退、界面未出现);读后即删 + 删失败容忍的语义无自动守护,回归即静默重复提示或永久丢失 | 补最小用例:首次取到 → 二次取为空;删除失败仍返回本次内容 | 高 |
| A-6 | P3 | 删库顺序:先主库后 `-wal/-shm` | src/rag/store.ts:185-186(`for (const suffix of ['', '-wal', '-shm'])`) | 主库已删而侧车因占用/权限滞留时,下次建库会带着不匹配的旧 WAL 开工(salt 不匹配通常被重置,属概率性残余);与 :104-127 迁移侧车的谨慎处理不对称 | 改为先删 `-wal/-shm` 再删主库,或任一失败即整体报错 | 中 |
| A-7 | P3 | 同名函数跨文件语义不同(易误用) | src/desktop/update-helper.ts:114-120 `rmDirQuietly`(纯 rm 吞错) vs src/desktop/update-controller.ts:354-368 `rmDirQuietly`(先摘 asar 叶再重试) | 差异本身合理(助手进程已 `process.noAsar = true`,见 src/desktop/main.ts:75),但同名跨文件语义不同,误引即「asar 目录删不掉」类缺陷复现 | 改名区分(如 `rmDirQuietlyPlain` / `rmDirQuietlyWithAsarRetry`) | 高 |
| A-8 | P3 | session-end 自愈窗口与停机链预算紧贴 | src/desktop/lifecycle.ts:235(观察窗 5s)、:239(flush 预算 2s)、:502-519(flush → finally `serverManager.shutdown()`);src/desktop/server-manager.ts:50(总超时 3.5s)、:74(等停机收口上限 5s) | 最坏串行 ≈2s + 3.5s = 5.5s > 观察窗 5s,到点时常仍需再等 ≤5s 收口,「服务已恢复」最长 ~10s;慢盘/多书 abort 时 flush 预算内未落定即丢最后一段键入(注释已明示,属有界取舍) | 自愈判定改为「停机收口后 + 短延迟」而非固定 5s;或把 flush 预算与停机预算之和纳入观察窗预算 | 高(参数)/中(实际收益) |
| A-9 | P3 | `SqliteSchemaTooNewError` 在 RAG 状态链未归并为态 | src/rag/build.ts:263-277(`ragIndexState` 只把 corruption 收成返回值,其余 throw)、src/shared/sqlite-migrate.ts:149 | 库版本超前(旧代码打开新库)时 status 端点 500,前端无法给出「请升级应用」指引;损坏态已有 `corrupt` 第三态先例 | 归并为第四态(`too-new`)返回值,由端点透出 | 高 |
| A-10 | P3 | 知识层运行期不读 manifest,一致性只在 CI/commit 链 | src/knowledge/manifest.ts:59-110(校验器,sha256 + fm 一致)、src/knowledge/catalog.ts:12-13(注释明示运行时不再读 manifest) | 随包语料在用户机上被替换/截断时运行期零检测(CI 门覆盖仓库态,不覆盖 bundle 态);注入内容失真只表现为「模型参考变差」,无可观测面 | 起服或首次注入前对随包篇目做一次存在性 + 前缀抽查(成本极低) | 中高 |
| A-11 | P3 | `migrateSqlite` 步不包外层事务的「半程」态 | src/shared/sqlite-migrate.ts:23-28(显式裁定与代价记档) | 当前 rag 仅 1 步不可达;新增「改型/改名/搬迁」步后崩溃会留「部分 DDL + 旧版本号」,靠下次打开重跑收敛(依赖步自身幂等) | 维持现状,但把「新增步必须幂等且可重入」写成步定义处的硬契约并加一条阶梯契约测试 | 高(现状无害) |
| A-12 | P3 | 同步爬祖扫描仍在若干入口同步执行(失联卷冻结残窗) | src/desktop/workdir-controller.ts:296-298(`canSwitchLibraryDir` → `findWorkDir`/`statSync`)、:534(`findGitAncestor` 同步)、src/install/init.ts:141(同族判定) | 既有「失联网络卷冻结主进程」病根的残余面,仅剩「预探通过后瞬断」TOCTOU 残窗(多处注释已记档);非新问题 | 维持记档;若再加一道,可对 `findWorkDir` 也设预算 | 高 |
| A-13 | P3 | 测试以假件为契约,真实 Electron 进程语义无自动守护 | test/desktop/server-manager-fixtures.ts:27-41(`FakeChild extends EventEmitter`,`kill()` 后 `queueMicrotask` 发 exit;:30-32 pid 可 undefined 靠注释约定);真实进程回归仅严格 opt-in(src/desktop/main.ts:561-563 `CLW_SMOKE_WINDOW_CYCLE`) | kill 返回值/pid 生命周期/`error` 三参事件/EPERM 类平台差异与假件模型的偏离无自动判据,靠注释与一次性真机实测记档(如 :79-84 的 pid 复用窗、src/desktop/server-proc.ts:79-86) | 把已记档的真机结论反向钉成「假件行为契约」测试,或在 CI 增加一次受控真机冒烟 | 中高 |
| A-14 | P3 | 实例在持判定的调用形态不对称 | src/desktop/update-helper.ts:167-180(`otherInstancesRunning(homeDir, excludeKey?)`)、:263(`precheck` 单参调用 → 无排除);对照 src/desktop/update-controller.ts:222(IPC 预检传 `currentInstanceKey()` 有排除) | 当前无害(助手运行时旧进程已退,锁自然不在持),方向亦保守(多算则 abort);但语义不对称,未来助手在「旧进程未退净」形态下工作会多算一个实例 | 助手侧显式传本机已知 key,或把「排除自身」写进函数契约 | 中 |
| A-15 | P3 | 中断自愈窗口:目录缺席需等「下一次助手启动」 | src/desktop/update-helper.ts:16-21(文件头明示)、:127-156(`recoverInterruptedSwap`)、src/desktop/update-controller.ts:389-407(target 缺席时不擦 `.old-*`) | 用户若始终无法再启动任何副本,`<target>` 永久缺席、快捷方式落空,只能重装或人工改名(作者已如实记档,但恢复面是「外部动作依赖」) | 增加一个不依赖应用启动的还原入口(如安装目录旁的恢复脚本/bat),或让快捷方式指向带自愈的首启包装 | 高(事实)/收益中 |

严重度统计:P0 = 0;P1 = 0;P2 = 5(A-1…A-5);P3 = 10(A-6…A-15)。

> A-1 备注:若把供应链威胁模型上调为「发布账号失陷亦须防」,A-1 可升 P1;按当前威胁模型(HTTPS 为唯一信任锚、同权本地攻击者已有等权能力)维持 P2。

## B. 实现完成度(按模块 + 证据)

**src/desktop(28 档 8251 行)— 高(~95%)。** 进程编排与退出竞态是全域最厚处:
- 双显式状态机,状态容器唯一存真 + 机器可读转移表 + 单一转移点 + 非法转移记 error 拒绝:src/desktop/server-manager.ts:210-251(`isLegalTransition`,11 事件 × 相位 × 停机面穷尽枚举)、:478-529(`transition`);src/desktop/lifecycle.ts:86-117(`isLegalExitTransition`)、:123-163。相位由载荷派生(server-manager.ts:451-456),停机面以三值类型取代两布尔旗(server-manager.ts:167-174)。
- 启动/握手/退避/自愈/幂等停机/强杀兜底:server-manager.ts:660-718(fork 后停机检查即杀、握手、稳定窗清零)、:725-774(退避 0/5s/15s + 封顶决断)、:993-1075(三路竞速 + SIGKILL 升级 + 幂等 join + 收口唤醒等待者)、:1103-1139(自愈有界等停机收口)。红线(「main 兜底 ≥ child 兜底之和」)在 :44-50 写明并有常量对齐(child 侧 src/desktop/graceful-shutdown.ts:24-28)。
- 单实例双防线:src/desktop/main.ts:154(Electron 锁)+ :160-162(跨提权文件锁),second-instance 直达链含失联卷预探(main.ts:175-230);CSP 与 IPC 可信 sender 单点:main.ts:105-116、src/desktop/ipc.ts:172-179;外链白名单用 URL 解析逐字段判(ipc.ts:154-164)。
- 退出链三链(session-end / close / before-quit)顺序不变量「先 flush 后停服」写死并有注释锚:lifecycle.ts:485-519、:602-745。
- 测试守护真实:test/desktop 60 档 14604 行,含 server-manager-shutdown-races / state-machine / restart-pinned / restart-shutdown-wait / stop-shutdown / repeated-signal-hard-exit / main-lifecycle-exit / app-instance-file-lock / update-helper 等针对竞态与退出面的用例。
- 缺口:真机进程回归仅 opt-in(见 A-13);main.ts:856-892(uncaughtException/unhandledRejection 尾段)未读(见 §D)。

**src/install(12 档 2590 行)— 高(~90%)。** books.jsonl 单源 + 读失败拒写纪律(src/install/books.ts:146-199,读失败即拒绝改写,防清空登记);双维判重(名字 + dev+ino 物理身份,books.ts:158-170);半成品 scaffold 幂等恢复与 case 漂移对账(src/install/init.ts:190-209、:263-287);布局迁移 v2/v3 与「回收站登记先于移文件」(src/install/migrate-layout-v3.ts:38-58)、未识别条目留痕不静默(:121-136);同步/异步锁孪生按调用面分发(books.ts:108-141,GUI 端点全走 async,避免 Atomics.wait 冻服务进程)。35 档 4556 行测试。缺口:repairBooks 自愈族(books-repair)未逐行读,其「报告 missing 不清除」口径未独立复核。

**src/update(6 档 841 行)— 中高(~85%,本域最年轻)。** 检查:三态结局不可合成 null(src/update/check.ts:92-107)、只提示正式版且不可解析即当不存在(:133-137、src/update/semver.ts:27-40 严格三方组)、失败静默只留 info(:161-165)。下载:先 `.part` 后原子改名、失败零残留(src/update/download.ts:174-238)、校验值优先 digest 回落 SHA256SUMS(:137-167)。解压:路径越界/符号链接/加密条目/非常规压缩法全拒(src/update/extract.ts:37-71)。助手:等旧进程退出 → 预检 → 解压 → 换目录 → 拉起,三态结局 + 中断自愈(src/desktop/update-helper.ts:328-407)。启动维护只清可识别残留、target 缺席不擦回滚源(src/desktop/update-controller.ts:387-439)。
- 完成度缺口(证据):本域仅 11 次提交(六域最少),测试仅 4 档 719 行(rag 为 41 档)。`src/update/cache.ts`(140 行,一次性信箱)无本域测试档;`armPendingUpdateIfAny` 虽有 test/desktop/update-controller.test.ts:283-350 覆盖。信任模型缺独立锚(A-1)、解压缺资源上限(A-2)、助手 argv 无来源校验(A-3)、防降级缺断言(A-4)。

**src/knowledge(11 档 1796 行)— 高(~90%)。** manifest 校验器对坏形状全面降级为 issue 不裸崩(src/knowledge/manifest.ts:59-110、:119-136),路径安全统一委托 `resolveWithinRoot` + 解析后前缀复核(:215-225);commit 链跨进程锁 + fm 注入与 manifest 写失败的双向回滚(state 两文件一致)(src/knowledge/update.ts:186-398);篇目注册表以「目录即分类」声明,faces 为实际消费面的事实陈述不虚报(src/knowledge/catalog.ts:12-16、:128-155)。13 档 2017 行测试(含 manifest 畸形/fsync/行尾保真/casefold 判重)。缺口:运行期无 manifest 一致性检查(见 A-10)。

**src/rag(8 档 2397 行)— 高(~95%,覆盖密度最高)。** SQLite 使用成熟:WAL + `user_version` 版本阶梯(shared 单源)、损坏窄判定(errcode 低 8 位 26/11,绝不误判 BUSY/IO)(src/rag/store.ts:131-145)、删库自愈只对确认损坏(store.ts:178-209)、开库序列 busy_timeout 归零 + 稳态复位 5s(store.ts:240-264、:323-356)、norm 列形态迁移与数据回填分离、回填分页 ≤512 行且单事务(store.ts:495-530)、部分索引只收 NULL 行(store.ts:344-353)、召回流式打分(内存峰值 O(元组))(store.ts:664-750)、建索引「指纹集合 == 已索引章集合」不变量 + 增量/续传/取消零写入(src/rag/build.ts:379-417、:552-560、:654-744、:760-810)、召回候选子集惰性指纹过滤 + 截断随结构化出口上抛(src/rag/index.ts:239-317)。41 档 5809 行测试含 db-corruption-recovery / buildindex-corruption-selfheal / store-migration-race / norm-column-race / poison-* / scale。缺口:A-6、A-9。

**src/shared(22 档 1729 行)— 高(~92%)。** 迁移阶梯四条 fail-closed 语义裁定 + `assertLadder` 红线(step 必须恰为 1..target 连续升序)(src/shared/sqlite-migrate.ts:11-35、:92-166);prepared 缓存 ephemeron 断链单源与「关库必走 closeWithPrepared」契约(src/shared/sqlite-prepared.ts:11-51);回滚单点 rollbackQuietly/rollbackToSavepointQuietly(:53-76)。提交仅 20 次,漂移最小。

## C. 简洁与优雅度

**正面(有代码证据的口径)**
- 同一范式贯通两处最难的并发面:状态容器 + 转移表 + 单一转移点 + 派生读数(server-manager.ts:151-529 与 lifecycle.ts:16-221 同构);非法转移不静默放行而是记 error 拒绝。这是本域最优雅的一段设计。
- 重复实现已被系统性收敛为单源:errMsg / hashFile / resolveWithinRoot / raceWithTimeout / prepared / rollbackQuietly / testableConst / findWorkDir 判定,均在注释里点名「原各持一份 → 收编单源」。
- 类型卫生极好:六域 87 档 `as any` = 0、`@ts-ignore/@ts-expect-error` = 0、`eslint-disable` = 0;`catch {` 86 处中无注释的空 catch 仅 1 处,`TODO/FIXME/XXX/HACK` 3 处。错误吞没基本「要么留痕、要么写明为何吞」。
- 常量与预算全部单源且带推导(如 server-manager.ts:44-74 四条预算的失配分析、src/rag/store.ts:240-281 的开库档推导),注释写的是不变量与平台差,不是流水账。

**负面**
- **修复史/来历措辞与项目注释纪律相悖(主要可维护性问题,建议单列一批清理)**:六域内「此前/原实现/修复前/原口径/原语义」共 156 处;`阶段 N` 字样 37 处。样例:src/rag/build.ts:552-555(「此前无事务:块插一半崩…」)、:566-567(「修复前全量一次性单 POST…」)、:75-78(「原实现把 fmRaw 掺进哈希…」)、src/rag/store.ts:157-170、src/desktop/ipc.ts:341(「(win线并树随行)」)、src/desktop/server-manager.ts:316-318。项目正本明确「注释只写作用与需说明的东西;不写来历与出处,修复史归 git」——本域是这条纪律的最大违例面(测试侧以 `R09xx-` 锚注为追溯手段属另一套约定,本域源码内批次锚计数为 0,故问题不在锚而在散句修复史)。建议:批量把「此前/原实现/修复前」句改写为「约束/原因」句或删除,保留 git 追溯。
- 注释体量偏大:server-manager.ts 1187 行中注释行 420(35%)、main.ts 913/333(36%)、rag/store.ts 844/351(42%)、build.ts 811/264(33%)。密度本身是取舍(该域并发正确性难以从代码直读),但单文件 800-1200 行 + 三分之一注释,新人索引成本高;可考虑把「历史取舍」段下沉到就近的 ADR/决策记录,文件内只留一句结论 + 指针。
- 同名函数跨文件语义不同(update-helper.rmDirQuietly vs update-controller.rmDirQuietly,见 A-7);同名 + 行为差异是未来误引的直接来源。
- re-export 桥(books.ts:294-324 逐名透传、rag/index.ts:46-55)保住了消费方 import 面,代价是「到底谁拥有实现」需靠注释确认;方向单向合理,属可接受成本。

## D. 无法判断项及原因

1. **main.ts:856-892(uncaughtException 的 200ms backstop / unhandledRejection 兜底)未读**:预算用尽前未覆盖该尾段;只能从 server-manager.ts:311-318 的 `killNow` 契约注释与 main.ts:843-850 的信号链间接推断存在「延迟一拍落日志 → killNow → exit」形态。其与 `signal-hard-exit` 二拍的交互是否正确,需补读。
2. **未读档(完成度判断的抽样边界)**:src/desktop/windows.ts(633)、font-cache.ts(432)、win-fonts.ts、os-kek.ts、server-utility.ts、server-main.ts、server-boot.ts、new-instance.ts、startup-instance.ts、bootstrap-runner.ts、signal-hard-exit.ts;src/install/scaffold.ts(372)、books-repair.ts(287)、books-store.ts(235)、migrate-layout-v2.ts、migrate-defaults.ts、migrate-finalized-revision.ts;src/rag/embed.ts、chunk.ts、config.ts、resolve.ts、schema.ts;src/knowledge/seed.ts、genre.ts、inject.ts、select.ts、corpus.ts;src/shared/*(除 sqlite-migrate / sqlite-prepared)。上述面在本报告中只做结构性判断,不作结论。
3. **`takeUpdateAttemptNote` 的实际消费点**在 studio 域端点(/api/app-info),本域 grep 零命中,故「读后即删」是否被跨域正确使用无法在本域判定(见 A-5)。
4. **真机平台语义**:Windows 上 `process.kill(pid,'SIGKILL')` 对 utilityProcess 的实际效果、`EBUSY/EPERM` 在杀软/索引器占用下的分布、mac 上 `app.relaunch` 与 `releaseSingleInstanceLock` 的实际时序——均需真机实验,本任务书禁止起真实 Electron/服务进程,故只按代码与注释记「已记档」。
5. **规模/性能结论未验**:rag/store.ts:573-577 与 :664-670 的内存-延迟量化(3.5 万块 320-350ms、10 万块 ≈4MB 元组)来自注释与测试档(scale.test.ts 存在但按禁令未跑);本报告不采信其数字。
6. **行数口径差异**:同一组文件在 `Measure-Object -Line`(17604)与 `Get-Content .Count`(18636)下不同,差异源于空行/末尾统计口径;本报告只在「同一口径内比较」时使用这些数字。
7. **跨域一致性**:shared/contract/*.conformance.ts、contract 形状与前端 web-next 的对齐、以及 ipc.ts 的 `desktop:*` 通道与 preload/d.ts 的三处同步——本次只读了主进程侧,渲染侧与 preload 未读,无法判断契约是否三处一致。
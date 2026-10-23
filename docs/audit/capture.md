# 采集侧（electron/capture、electron/native）代码审计报告

审计人：capture-auditor（Team 成员）
范围：`electron/capture/**`、`electron/native/**`（独占写入）
基线：typecheck 通过、453 测试全绿、native 可编译。本次目标是找真实缺陷，不是修红灯。

验证方式（全部按任务纪律执行，未运行 build/electron/verify 脚本）：

| 验证 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查（我的范围） | `npx tsc --noEmit -p tsconfig.json`（收尾复跑全仓库 0 错误） | 0 错误 |
| 未使用告警（我的范围） | 同上加 `--noUnusedLocals --noUnusedParameters` | 0 告警 |
| 新增单测 | `npx vitest run tests/capture` | 5 文件 / 61 用例全绿 |
| 全量单测 | `npx vitest run` | 28 文件 / 786 用例全绿（审计过程中曾观察到 compositor/editor-math 失败，均已由各自负责人修复） |
| C# 编译（C# 5） | `csc /nologo /optimize+ /out:%TEMP%\... grabber.cs|audio.cs` | 两个都 exit 0、0 警告；8KB / 18KB |

> 说明：审计期间其他 agent 在并行改 `electron/main.ts`、`src/renderer/**`。审计中段全量 tsc 曾报这些文件的错误，收尾复跑已恢复通过；本范围在两个时间点都单独确认干净（含 `--noUnusedLocals`）。

---

## 一、问题清单

### P0

| # | 位置 | 根因 | 修复 | 验证 / 真实表现 |
| --- | --- | --- | --- | --- |
| P0-1 | `captureEngine.ts:287`（start）、`:1211`（cancel） | 状态机只在 `Idle` 允许开始录制；`stop()` 之后停在 `ReadyToEdit`，而 `cancel()` 对 `ReadyToEdit` 直接 `return`，没有任何路径回到 `Idle`。CAPTURE_TRANSITIONS 本身允许 `ReadyToEdit/Cancelled/RecoveryReady/RecoverableFailure → Idle`，但没人调用。 | `start()` 先走 `resetFinishedSession()`（等残余 drain/摄像头任务收尾 → 清残留 worker → 迁回 Idle）；`cancel()` 对 `ReadyToEdit` 只复位状态、不动工程。 | 新增用例：`ReadyToEdit` 复位到 Idle、cancel 完成后状态 Idle。真实表现：**录完第一场后第二场必然报「已有录制会话在进行中」，只能重启应用**。 |

### P1

| # | 位置 | 根因 | 修复 | 验证 / 真实表现 |
| --- | --- | --- | --- | --- |
| P1-1 | `captureEngine.ts:535`（handleVideoFrame） | `doStop()` 先 `transition('Stopping')` 再等 grabber 排空 stdout，但 `handleVideoFrame` 开头只接受 `state === 'Recording'` —— 排空阶段读到的、停止前已采集的 1~2 秒帧被状态守卫全部丢弃。第 1124 行注释声称「已修 18s→20s」，实际被这个守卫吃掉。 | 允许 `Stopping && stopping` 期间继续收帧/收音频，并用 `clock.stopQpc` 丢弃停止命令之后采集的样本（`:556`、`:669`）。 | 用例「Stopping + 停止边界之前的帧仍被接收、之后被丢弃」。真实表现：**20 秒录制只成片 18 秒左右，覆盖率 ~90%**。 |
| P1-2 | `captureEngine.ts:995`（pause）、旧 `maybeSliceByTime` 的 `boundary-target` 算法 | ① 暂停边界在 drain **之后**才 `clock.pause`，drain 期间媒体时间前进但没有帧被接受（状态已 Pausing），恢复后暂停点附近出现「时间走了没画面」的空洞；② 暂停时 flush 出短段后栅格没有重基，恢复后下一段起点被算回上一格起点，**同一段媒体时间被编码两次**。 | 暂停时先取 `pauseQpc`、立刻 `clock.pause(pauseQpc)` 再 flush；分段状态抽成 `SegmentGrid`（`segmentPlanner.ts`），`flush()` 后从真实结束时刻重开栅格，切段显式维护 `startTick` 而非 `boundary-target`。 | `tests/capture/segmentPlanner.test.ts` 12 例 + 引擎用例「flush 后下一段 startTick = 上一段 end」；旧行为会断言失败（重叠）。真实表现：**每次暂停恢复后成片时间轴重复约 1 秒、段总时长大于录制时长、导出后音画错位并出现重复画面**。 |
| P1-3 | `captureEngine.ts:652`（splitAudioPackets）、`:923`（writeWav） | `audio.exe` 的 `startFrame` 是「该路流自身累计采样号」，两路设备启动时刻不同（回环实测晚 ~0.9s），且暂停时设备仍在计数。旧主进程把它原样传给编码窗口当段内偏移（`recorderRuntime.mixAudio` 用 `offset = packet.startFrame`），WAV 也按包顺序从头拼接 —— 两路音频整体前移一个设备启动延迟，暂停后继续漂移。 | 切段时用包携带的 QPC 经 `SessionClock.mediaTickAt`（自动扣暂停）换算媒体时间 → 减去段起点 → 改写 `startFrame` 为段内 48kHz 偏移（`audioAlign.ts`）；越过段尾的包 carry 到下一段，避免段边界丢 20~40ms；flush 时用真实媒体时长延长段尾，末帧到暂停/停止点之间的音频不再被裁掉；WAV 按偏移落盘、不足补静音、超出截断；未启用音轨不再写静音 WAV。 | `audioAlign.test.ts` 12 例、引擎音频对齐/WAV 用例；真实表现：**音画偏差数百毫秒、麦克风与系统声相对错位约 0.9 秒、暂停恢复后继续漂移**。 |
| P1-4 | `captureEngine.ts:968`（scheduleCameraSegment），旧 `encodeSegmentFromSlice` 内 await 摄像头 | 旧实现把 `commitCameraSegment` 串在屏幕段编码循环里 await。摄像头段要「实时」采集满 durationTicks（~1.6s），屏幕编码还要 ~0.4~0.8s，于是每 1.6s 的段落实际耗时 >2s，`pendingSegments` 持续增长并触发 `MAX_PENDING_SEGMENTS=2` 背压，**丢掉中间屏幕段**。 | 摄像头提交改为在**切段瞬间**启动、放到独立串行 Promise 链（`cameraChain`），不阻塞屏幕编码；`doStop`/`start` 时 `drainCameraJobs()` 等待落盘。 | 引擎用例「摄像头提交未完成时 drainSegmentQueue 仍能结束」。真实表现：**开摄像头录制的项目频繁 `segment-dropped`，屏幕轨缺段，摄像头轨与屏幕轨逐段错位**。 |
| P1-5 | `captureEngine.ts:388`（grabber.onExit） | 只在 `state === 'Recording'` 时把采集进程崩溃上报为失败。在 `Paused/Pausing/Resuming/Countdown` 崩溃时只清引用不报错，恢复后继续「录制」但永远没有画面。 | 扩展为 Recording/Paused/Pausing/Resuming/Countdown 均 `failSession(E_SOURCE_CLOSED)`。 | 代码级证明（状态判断 + failSession 迁移均合法）。真实表现：**暂停时采集进程崩掉，恢复后录到的是静止帧/零帧，直到用户停止才发现整段丢失**。 |
| P1-6 | `workers.ts:76`（StderrParser）、`:259/:451`（failStart）、`:67`（guardStreamErrors） | ① `READY`/`QPCFREQ` 按单个 stderr chunk 匹配，一行被管道分块截断时永远匹配不到 → 3 秒启动超时；② 启动超时/spawn error 只 reject、**不 kill 子进程**，半启动的 grabber 变成持续抓屏的孤儿；③ 未给 stdin/stdout 挂 error 监听，进程已退出时写 `q\n` 的 EPIPE 会变成未捕获异常**打崩主进程**。 | stderr 改为累计文本解析（并带 seen 标记）；失败路径统一 `failStart()` → reject + `killChild()`；三条管道挂空 error 监听；`start()` 失败时引擎再 `grabber.stop()` 兜底并断开引用（`:366`）。 | `workers.test.ts` 4 例（READY 分块、超时 kill、spawn error kill、ARGS_ERROR 立即失败）。真实表现：**偶发「无法启动屏幕采集」但任务管理器残留 grabber.exe 占着 GDI；偶发主进程直接崩溃退出**。 |
| P1-7 | `wireProtocol.ts`（新增）、`workers.ts` 解码路径 | 旧解析在长度非法时 `buf = Buffer.alloc(0); break;` 静默丢弃剩余 chunk，但长度前缀协议没有同步标记 —— 从此永久失步，后续帧全是垃圾且用户无感；未校验 JPEG SOI；音频用 `total < 24` 判非法会把 code/message 很短的真实设备错误包（20~23 字节）整块丢掉；错误包 codeLen/msgLen 未做越界校验。 | 抽出 `FrameStreamDecoder`/`AudioStreamDecoder`：半包/粘包、长度上下限（视频 16MB/音频 8MB）、JPEG SOI 校验、错误包最小 20 字节且长度字段越界即报错；失步时 worker 记录 `PROTOCOL_ERROR` 并 kill 子进程 → exit 通知 → 引擎进入 RecoverableFailure（而不是静默写错帧）。 | `wireProtocol.test.ts` 14 例（含逐字节半包、短错误包、失步后先返回已解出的帧）。真实表现：**长时间录制偶发花屏/黑帧且无任何错误；麦克风被占用等设备错误在日志里完全消失**。 |

### P2

| # | 位置 | 根因 | 修复 | 验证 / 真实表现 |
| --- | --- | --- | --- | --- |
| P2-1 | `captureEngine.ts:1053`（doStop） | 停止只在 Recording/Paused 时迁移到 Stopping。倒计时阶段点停止会一路收尾到 `transition('Finalizing')` 才抛「不允许的状态转移」；Pausing/Resuming 并发停止同样在收尾阶段抛错，此时 worker 已停、定时器已清 —— 引擎卡死。 | `waitForTransientState()` 等 Pausing/Resuming/Preparing 落定；Countdown 走 `Countdown→Recording→Stopping` 收尾成空工程（保住 main 的 `stop→store.load` 契约）；RecoverableFailure 走清理后回 Idle 的独立分支。 | 代码级 + 状态机表证明。真实表现：**倒计时/刚点暂停时点停止，报「停止录制失败」，之后引擎任何操作都报非法状态，只能重启**。 |
| P2-2 | `native/grabber.cs:209` | 帧间隔剩余不足 1ms 时 `waitMs=(int)(remain/1000)=0`，`Thread.Sleep(0)` 后 `continue`，在 for 循环里原地空转最多 1ms/帧；且只有成功出过帧（`frames>0`）才进入等待，持续抓帧失败时 100% CPU 忙循环。 | 剩余时间向上取整、至少 Sleep(1ms)、上限 50ms 保证响应 q；去掉 `frames>0` 条件让首次失败后也按节拍等待。 | csc 编译通过；逻辑证明。真实表现：**空闲但持续录屏时 CPU 占用偏高、风扇噪音**。 |
| P2-3 | `native/grabber.cs:61` | `quit` 是被闭包捕获的局部 bool，非 volatile，JIT 无义务在循环中重读（当前循环有外部调用才侥幸生效）。 | 改 `private static volatile bool _quit`。 | 编译通过。真实表现：极端情况下按停止/父进程关闭 stdin 后采集进程不退出。 |
| P2-4 | `native/audio.cs:595`、`:692`、`:720`、`:749` | COM `hr != 0` 判断把成功码（S_FALSE/AUDCLNT_S_BUFFER_EMPTY 等正数）当失败；`GetBuffer` 非 INVALIDATED 错误时 `break` 回外层再取包长，错误持续时形成 100% CPU 忙循环。 | 统一改 `hr < 0`（FAILED 语义）；GetBuffer 失败直接 `WriteError` 并退出该流。 | 编译通过；逻辑证明。真实表现：**设备切换/驱动异常时音频线程空转烧 CPU，日志误报设备丢失**。 |
| P2-5 | `native/audio.cs:351/581`（枚举器）、`:181`（WriteFloatLE）、`:736`（静音缓冲） | 每路流的 `IMMDeviceEnumerator` RCW 从不在 finally 释放（ListDevices 同样）；每写一个采样 `BitConverter.GetBytes` 分配小数组（~10 万次/秒）；静音包每包 `new byte[]`。 | 枚举器在 finally `ReleaseComObject`；用显式布局 union 手写 little-endian float（零分配）；静音包复用零缓冲。 | 编译通过。真实表现：**长时录制音频线程 GC 压力大、偶发爆音/丢包**。 |
| P2-6 | `native/audio.cs:266`（GetFriendlyName） | 非 VT_LPWSTR 时直接 return，没调 `PropVariantClear`，像 VT_BSTR 之类持有指针的类型会泄漏 COM 内存。 | 非字符串/空指针分支也调用 `PropVariantClear`。 | 编译通过。 |
| P2-7 | `captureEngine.ts:1268`（addMarker） | 没有会话时也记录标记：`mediaTick` 恒为 0，journal 因 session 为空不落盘 —— 幽灵标记。 | 无会话或非录制/暂停状态抛 `E_INVALID_COMMAND`；`recordClick` 同样加状态守卫。 | 用例「没有会话时 addMarker 抛错」。 |
| P2-8 | `captureEngine.ts:1341`（writePointerLog） | meta 行把整份 events 再写一遍，文件体积翻倍（读取方 main.ts 只用行事件 + meta.clicks）。 | meta 行 `events: []`，事件只保留逐行版本。 | 代码级；读取方 `project:read-pointer-log` 已确认会把行事件拼回。 |
| P2-9 | `captureEngine.ts:902`（writeAudioSegment） | 未启用的音轨也每段写全静音 WAV，工程收尾时被注册成音轨。 | 按 `config.microphoneEnabled/systemAudioEnabled` 决定是否落盘。 | 用例「未启用音轨不落盘」。真实表现：**没开麦却多出一条静音轨，磁盘每分钟多约 23MB**。 |

### 已知线索结论：`segmentIndex` / `segmentInFlight` / `nextSegmentDueAt` / `heldSlice` / `fs` / `TICKS_PER_SECOND` / `spawn` / `ChildProcess`

结论：**全部是死代码/废弃导入，不是遗漏逻辑**，已删除。逐项证据：

- `segmentIndex`：唯一写入点 `encodeSegmentFromSlice` 里 `this.segmentIndex = index`，全仓库无读取。段的权威数据是 `segments: SegmentRecord[]` 与 journal，编号由 `nextSegmentNumber` 生成。删除后无行为变化。
- `segmentInFlight`：仅在编码函数首尾 true/false，无任何读取。它想表达的「避免并发编码」已由 `draining` + `drainSignal` 完整实现（注释里记录了轮询版死锁的历史），属于旧实现的残留标志。
- `nextSegmentDueAt`：声明后从未赋值/读取。注释「补偿 setTimeout 调度延迟」对应已被废弃的定时器切段方案；现行方案是帧到达驱动的绝对栅格（`SegmentGrid`），定时器只做 drain 兜底。
- `heldSlice`：声明、赋值 `null`（`flushRemainingFrames` 末尾），从未读取。它对应更早的「等下一段首帧来确定上一段结束边界」设计；现行设计在切段瞬间就固定段边界，不需要 held slice。
- `fs`（同步版）、`TICKS_PER_SECOND`、`spawn`/`ChildProcess`：均为历史实现的未清理导入；文件实际只用 `fsp`、`secondsToTicks`，主进程也不 spawn 子进程（spawn 在 workers.ts）。
- `maybeSliceByTime` 的 `segmentBoundaryTick` 字段被 `SegmentGrid` 取代（显式 `startTick` + `boundary`），旧字段已删。

---

## 二、架构性改动（为可测试性/正确性）

| 新文件 | 职责 |
| --- | --- |
| `electron/capture/wireProtocol.ts` | stdout 二进制协议纯解码器（帧流/音频流），半包粘包、长度上限、JPEG SOI、错误包边界。 |
| `electron/capture/segmentPlanner.ts` | `SegmentGrid`：绝对栅格切段 + flush 后重基，保证相邻段 `[start,end)` 首尾相接不重叠。 |
| `electron/capture/audioAlign.ts` | 媒体时间 → 段内 48kHz 偏移、WAV 偏移落盘、缓冲长度推导。 |

`workers.ts` 增加可注入的 `SpawnFn`（默认 `node:child_process.spawn`），用假 ChildProcess 覆盖启动超时/kill/排空/协议失步等真实 spawn 难以稳定复现的路径。

---

## 三、未修复风险（有判断依据的残留）

1. **`Preparing` 阶段并发 stop（UI 不可达）**：`captureStart` 未返回前 UI 的停止按钮处于 loading/禁用；若被外部 IPC 强行调用，start 会在后续 `transition('Countdown')` 处抛错，可能残留已 spawn 的 worker。修复需要把整个 `start()` 包进可取消的事务，改动面较大，暂记为残留。
2. **`Pausing` 的 drain 超过 5 秒**：`waitForTransientState` 超时后停止仍会尝试 `Pausing→Stopping` 并抛非法迁移。只在编码器卡死时出现；比旧行为多了 5 秒等待与明确报错，但未做到彻底幂等。
3. **摄像头轨整体晚一段的架构问题**：`cameraRuntime.encodeSegment` 是「实时采集 durationTicks」语义，切段时才开始采集，因此摄像头段 i 的内容实际对应屏幕段 i+1 的时间窗；停止时最后一段还会把停止后的画面录进去。本次修复消除了「串行 await 造成丢段/逐段累积延误」，但**时间偏移必须在 cameraRuntime 里改成持续缓冲取帧才能根治**（跨范围，见下）。
4. **暂停期间摄像头仍在采集**：屏幕暂停时摄像头窗口不知道暂停，暂停段对应的摄像头内容错位/多录。
5. **暂停边界的音频包仍会丢 ≤20ms**：carry 机制已把越界包交给下一段，flush 也已延长到真实暂停/停止边界；唯独「包首采样在暂停前、其余样本在恢复后」的跨暂停包会整包丢弃（按样本切分暂停区间成本高、收益仅 20ms）。
6. **journal 与资产非原子**：`segment-commit` 之后才写 WAV/摄像头段，崩溃在中间会出现「视频段已提交、音轨缺段」；恢复逻辑只保证视频段，不校验音频/摄像头一致性。
7. **`startFrame` int32 上限**：音频流累计帧号在约 12.4 小时溢出为负；对齐后该字段只作调试与契约输入（主进程会重写），不影响时间轴，但日志/诊断会显示负数。
8. **`FrameServer` 是死代码**：`startFrameServer` 全仓库无调用方，注释里的 `/segment?index=N` 路由未实现、`served()` 恒为 0（帧在切段瞬间就移出内存，已无法按索引回放）。建议后续直接删除。
9. **`recordClick` 无调用方**：指针点击轨当前只有 `move` 事件与 `pointerClicks`（供教程），点击的全局钩子尚未接入。
10. **`finalizeProject` 的类型断言**（`as RecordSession` 附带 `segments/markers/durationTicks`）依赖 main.ts 的隐式契约，未强类型化；属于跨进程边界设计债。
11. **编码窗口 base64 常数开销**：`main.ts requestSegment` 每段把 JPEG 转 base64 拼成 JS 源码（`executeJavaScript`），峰值内存与 CPU 都高；属 main.ts 范围，本轮只记录。

---

## 四、跨范围发现（只记录，未修改）

| 位置 | 问题 | 影响/建议 |
| --- | --- | --- |
| `electron/main.ts` captureStart（约 :823） | UI 已经在 `RecordView.beginCountdown` 做过 3 秒倒计时，仍把 `config.countdownSeconds` 原样传给引擎，引擎 `start()` 再倒计时 3 秒。这 3 秒里 grabber 已在抓屏但 `handleVideoFrame` 因状态 Countdown 丢弃 → 用户看到「录制已开始」后约 3 秒无画面，且会话起点被推后。 | 建议 UI 调用 `startCapture` 前把 `countdownSeconds` 置 0（或引擎/UI 二选一执行倒计时）。 |
| `electron/main.ts` `finalizeSessionProject`（约 :686） | 音轨资产只注册 `media/mic|system/<第一个 wav>`（`files[0]`），但 `durationTicks` 填整场时长；摄像头轨同样只用 `cameraFiles[0]`。 | 编辑器/导出实际只能拿到 1.6 秒音频/摄像头素材，后续段丢失。需要按段拼接或按段建 clip。 |
| `src/renderer/recorderRuntime.ts` `mixAudio`（约 :82） | 用 `packet.startFrame` 当段内偏移（语义正确的前提是主进程已按 QPC 改写，本次已在引擎侧满足）；两路各 0.7 增益后直接相加再硬裁剪，不是真正的混音/限幅。 | 若有人绕过主进程直接喂原生包，偏移会错；混音策略在双路同时大声时仍会削顶。 |
| `src/renderer/cameraRuntime.ts` `encodeSegment`（约 :215） | 摄像头段按「实时 sleep 逐帧」编码，单段耗时约 durationTicks；`setTimeout(..., floor(1000/fps)-2)` 在 30fps 下每帧 31ms，实际约 32ms/帧 → 长时间录制摄像头轨比屏幕轨慢约 2~3%。 | 摄像头轨会缓慢落后；应在 cameraRuntime 内持续取帧并按时间切片，而不是每次现采。 |
| `electron/main.ts` `requestSegment`（约 :490-575） | 每段把 JPEG 转 base64 拼 JS 源码 + `executeJavaScript`，且主动 `gc()`；段数据在时间轴上依赖引擎传入的 `startTick/durationTicks`。 | 已知性能优化点，未动。 |
| `tests/renderer/editor-math.test.ts` | 审计中段全量测试唯一失败：`editor-math.test.ts:281` → `shouldUseSyntheticPreview` → `isMockMode`（`src/renderer/lib/wcs.ts`）。另观察到 `tests/media/compositor.test.ts` 的 `mapSourceRectToScreen` 失败。 | 均为并发 agent 的中间态，收尾时全量 786/786 已全部通过；与本范围无关。 |
| `electron/main.ts` / `src/renderer/components/Timeline.tsx` | 审计期间 tsc 报 `allowRoot` 未定义、`Promise<string>` 当 PathLike、`isAudioRow` 未定义等错误。 | 并行编辑的中间态，收尾时全量 tsc 已恢复通过；非本范围缺陷。 |
| `electron/main.ts` `project:read-pointer-log`（约 :1050） | 读取方式兼容本次 `pointer.jsonl` 的 meta 精简（行事件 + meta.clicks）。 | 无需改动；若其他读方假设 meta.events 有数据需同步。 |

---

## 五、修复文件清单

- 新增：`electron/capture/wireProtocol.ts`、`electron/capture/segmentPlanner.ts`、`electron/capture/audioAlign.ts`
- 修改：`electron/capture/captureEngine.ts`（状态机/切段/暂停/停止/音频对齐/摄像头调度/死代码清理）、`electron/capture/workers.ts`（协议解码、stderr 累计解析、失败 kill、stdout 排空、EPIPE 防护、可注入 spawn）
- 原生：`electron/native/grabber.cs`（忙等/volatile/Dispose）、`electron/native/audio.cs`（HRESULT/COM 释放/零分配 float/静音缓冲/PropVariant）
- 测试：`tests/capture/{wireProtocol,segmentPlanner,audioAlign,captureEngine,workers}.test.ts`（61 用例）

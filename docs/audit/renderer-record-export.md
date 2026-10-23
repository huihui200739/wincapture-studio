# 录制 / 导出 / 悬浮窗 UI 与隐藏窗口运行时审计报告

> 范围（独占写入）：`src/renderer/views/RecordView.tsx`、`views/ExportView.tsx`、`views/OverlayWindow.tsx`、
> `src/renderer/recorderRuntime.ts`、`exporterRuntime.ts`、`cameraRuntime.ts`、`src/renderer/styles.css`，
> 以及为此新增的纯逻辑模块 `src/renderer/uiSync.ts` 与测试 `tests/renderer/uiSync.test.ts`。
> 主进程 / preload / captureEngine / store 等跨范围问题只读核对、不修改，统一列在「跨范围发现」。

## 0. 结论摘要

- 修复缺陷 **30 项**：P0 0 项（未发现真正“永不 resolve”的 promise）、P1 17 项、P2 13 项。
- 关键问题集中在四类：**隐藏窗口的错误被当成正常返回值**、**取消/启动存在丢失窗口**、
  **UI 显示与主进程真实状态不一致（含假的设备/目录提示）**、**每段不释放编码器导致内存线性增长**。
- 验证：`npx tsc --noEmit -p tsconfig.json` 通过（exit 0）；`npx vitest run` **28 个文件 / 786 个测试全绿**
  （其中本轮新增 `tests/renderer/uiSync.test.ts` 43 个测试）。
- 未运行 `npm run build` / `pack` / `verify:*` / electron（纪律要求）；隐藏窗口 IPC 的端到端行为仍建议由 Lead 跑一次
  `verify:e2e` / 手动录制-导出回归。

## 1. 架构核对（先理解协议，再判断缺陷）

| 窗口 | 创建位置 | role 判定 | 主进程调用方式 | 本报告核对结论 |
| --- | --- | --- | --- | --- |
| `#recorder` | `main.ts:createRecorderWindow` | preload `location.hash` → `wcs.role` | `executeJavaScript('window.__wcsRecorder.encodeSegment(payload)')` | 方法名/参数/返回值一一对应；但**失败分支资源不释放**、**失败段会整段丢** |
| `#exporter` | `main.ts:createExporterWindow` | 同上 | `executeJavaScript('window.__wcsExporter.run(req)')` | 对应正确；但 **run() 把异常吞成正常返回值**、取消信号注册太晚 |
| `#camera` | `main.ts:createCameraWindow` | 同上 | `__wcsCamera.open/encodeSegment/close/snapshot` | 对应正确；但 **失败/成功路径都不释放编码器**、open 部分失败不释放设备 |
| `#overlay` | `main.ts:createOverlayWindow` | 同上 | 主进程直接 `send(IPC.captureStatus)` + `sendOverlayCommand` | 推送与命令链路（main-auditor 已接通）可用；本窗口此前**吞掉按钮 IPC 错误**、**无丢事件兜底** |

- `window.wcs.overlay` 只在 overlay 角色存在（`preload.ts:109`），主窗口无法调用 `overlay.update()`；
  **OverlayWindow 并不依赖 `update()`**（状态用 capture:status 推送 + 新增 1.5s 轮询兜底），该 API/通道目前无调用方，建议删除或明确归属。
- `recorderRuntime` / `exporterRuntime` 此前在**所有窗口**无条件安装 `window.__wcsRecorder` / `__wcsExporter`
  （main.tsx 静态 import 所有窗口共享同一 bundle）。现已按 role 守卫，避免主窗口被误调用时抢占 GPU 编码上下文。

## 2. 问题表

### 2.1 隐藏窗口运行时：recorderRuntime.ts

| # | 级别 | 位置 | 根因 | 修复 | 验证方式 | 用户可见表现 |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | P1 | `recorderRuntime.ts:158`（`includeAudio:false`） | 段载荷里的 `audio[].startFrame` 是**音频工作进程启动以来的全局采样序号**（`electron/native/audio.cs` 的 `_frameCursor`），而本窗口只有 2 秒段载荷、没有“会话零点→音频采样零点”的映射。旧代码直接拿它当段内偏移：第 1 段偏移 < 段长，于是把**倒计时期间的麦克风声音**混进 MP4；后续段偏移 ≥ 段长被整段丢弃 → MP4 音轨静音。 | 段 MP4 不再内嵌音频（`includeAudio:false`、删除错误的 `mixAudio`）。屏幕段音频的真实来源是主进程按段写出的 `media/mic|system/*.wav`，导出时由时间映射混音；内嵌音轨没有消费方，只是重复编码/放大体积。 | 代码审查（音频偏移语义 + 导出 `buildAudioMixIntervals` 只读 mic/system 轨）+ typecheck | 无直接 UI 表现；修复前“用播放器打开段 MP4 无声/第一段是倒计时杂音”，修复后不再产生误导性音轨 |
| R2 | P1 | `recorderRuntime.ts:105`、`:241` | 旧实现只在 `finalize()` 成功后 `encoder.dispose()`；任何编码异常（JPEG 解码失败、`commitVideoFrame` 抛错）走 catch 只 `abort()`，硬件 `VideoEncoder` 的 GPU 上下文与 8MB `OffscreenCanvas` 只能等 GC。连续失败段会线性涨内存。 | 抽出 `releaseActiveEncoder()`，在 `finally` 里对**成功/失败/防重入**三条路径统一 `dispose + canvas 尺寸置零`；用 `ownsEncoder` 防止“防重入提前返回”误杀另一个正在编码的实例。 | `tsc` + 代码审查（所有 return 分支都会经过 finally） | 长录制/编码降级时内存不再随失败段增长（旧版实测 40s 涨到 3GB 的那类问题） |
| R3 | P1 | `recorderRuntime.ts:209` | 单帧 JPEG 损坏（grabber 截断、内存压力）会让 `decodeJpeg` 抛错，整段 2 秒画面被丢弃（日志只见“段编码失败”）。 | 逐帧 try/catch：坏帧只跳过并沿用画布上一帧，时间轴照常推进；记录跳过错帧数，段整体成功。 | typecheck + 代码审查 | 偶发坏帧不再造成 2 秒画面空洞 |
| R4 | P2 | `recorderRuntime.ts:264` | 运行时被安装到所有窗口；主窗口/悬浮窗也持有编码入口，误调用会在可见窗口里做同步编码。 | 按 `window.wcs.role`（兜底 hash）仅在 recorder 窗口安装，与 `cameraRuntime` 的既有做法一致。 | 代码审查 + `main.tsx` 角色路由 | 无 |
| R5 | P2 | `recorderRuntime.ts:22`（`planFramePicks`） | 选帧算法埋在 .tsx 里不可测，且重复帧会重复解码。 | 纯函数移入 `uiSync.ts` 并加 4 个测试（抽样/补帧/边界/单调性）。 | `tests/renderer/uiSync.test.ts` | 无 |

### 2.2 隐藏窗口运行时：exporterRuntime.ts

| # | 级别 | 位置 | 根因 | 修复 | 验证方式 | 用户可见表现 |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | P1 | `exporterRuntime.ts:409` | `new AbortController()` 放在 `makeMediaProvider` / `makePointerLookup`（两次 IPC 往返，几百 ms）之后。这期间用户点“取消”，`window.__wcsAbort` 还是 undefined → 取消被静默丢失，导出继续跑完并写文件，而界面已显示“已取消/已清理”。 | 在任何 await 之前注册 AbortController；`finally` 里只清自己那一个（`__wcsAbort === controller`），不会误清新任务。 | 代码审查 + `ExportView` 取消流程联动 | 取消不再“点了没用”，也不会出现“界面说取消了、文件却生成了” |
| E2 | P1 | `exporterRuntime.ts:413`、`:495` | 导出异常被 catch 后**以正常返回值带回**（`{video,tutorial,snapshotHash,error}`），主进程 `export:start` 原样透传，IPC 外层是 `ok:true`。调用方若只看 `ok` 会把失败/取消显示成“导出完成”。 | 返回值补 `cancelled:boolean` 与 `errorCode`；catch 里按 signal/code 判定取消 vs 失败，并**主动上报一条终态进度**（phase=cancelled/failed），保证界面即使等不到主进程返回也有确定信号。界面侧同步用 `classifyExportBundle()` 归类（见 V1）。 | 单元测试 `classifyExportBundle`（视频失败/取消/无产物/部分成功 9 个用例）+ typecheck | 编码失败、磁盘不足、取消不再显示成“导出完成” |
| E3 | P1 | `exporterRuntime.ts:362` | 教程包导出把所有截图 PNG 攒在 `images[]` 里最后统一写：100 张 1080p PNG 未压缩状态可达数百 MB；且 `makeMediaProvider` 创建的 `VideoFrameSource` 从不 `close()`（文件句柄 + 段解码器一直占着）。 | 先建目录、逐张截图立刻写盘（内存只留当前一张）；`makeMediaProvider` 返回 `{provider, disposeSources}`，教程包 `finally` 关闭全部解码器；教程过程也检查取消信号。 | typecheck + 代码审查（解码器 close 幂等性已核对 `decoder.ts:close/closeEntries`） | 长教程（几十步）导出不再内存暴涨/句柄泄漏；取消能中断教程生成 |
| E4 | P2 | `exporterRuntime.ts:517` | 视频导出路径的 media provider 图省事复用，取消/失败早退时可能留下未关闭解码器。 | `run()` finally 兜底 `media?.disposeSources()`（exportProject 内部已关闭它解析到的 provider，二次 close 幂等无副作用）。 | 代码审查 | 无 |
| E5 | P2 | `exporterRuntime.ts:85` | 运行时被安装到所有窗口；主进程“取消导出”会向所有窗口广播 `__wcsExporter.cancel()`，旧实现每个窗口都有一份（无害但语义混乱；也让 mediabunny 注入发生在所有窗口）。 | 按 role 守卫安装 + 只在 exporter 窗口注入 mediabunny。 | typecheck + main.ts 广播逻辑核对 | 无 |
| E6 | P2 | `exporterRuntime.ts`（`probeVideo`） | `probeVideo` 异常路径不 `dispose()` Input，verify 脚本反复探测会留句柄。 | 闭包持有 dispose，`finally` 统一释放；顺手去掉 `wrapped as any` 的不安全强转（用 `WrappedCanvas.canvas`）。 | typecheck | 无 |
| E7 | P2 | `exporterRuntime.ts` | 未使用导入 `TimeMap`、未使用参数 `step`（已知线索 :27 / :310）。 | 删除导入；`imagePath` 参数改 `_step`。 | typecheck（无未使用项） | 无 |

### 2.3 隐藏窗口运行时：cameraRuntime.ts

| # | 级别 | 位置 | 根因 | 修复 | 验证方式 | 用户可见表现 |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | P1 | `cameraRuntime.ts:120` | `open()` 里 `getUserMedia` 成功但 `video.play()`（或首帧等待）失败时直接进下一轮重试，**没有 stop 已拿到的 MediaStream**：摄像头指示灯常亮、设备被永久占用，后续录制拿不到摄像头。 | 每轮 catch 先 `await close()` 释放流；首帧等待抽成 `waitForFirstFrame()`，超时/成功都清掉 `onloadeddata` 与定时器。 | typecheck + 代码审查（所有 catch 分支） | 摄像头偶发打开失败不再“卡住设备/灯不灭” |
| C2 | P1 | `cameraRuntime.ts:310` | 每段新建 `SegmentEncoder`（硬件 VideoEncoder + OffscreenCanvas），但**任何路径都不 dispose**；旧代码只在 `written===0` 时 `abort()`（abort 不是释放）。长时间录制里摄像头段反复失败会线性涨内存/GPU 上下文。 | `finally` 统一 `encoder.dispose()`；`written===0` 直接返回（取消由 dispose 承担）；加 `encoding` 防重入（协调器本身串行，双保险）。 | typecheck + `encode.ts:dispose` 语义核对 | 长录制内存不再随摄像头段数增长 |
| C3 | P2 | `cameraRuntime.ts:268` | 时间戳用 `Math.round(i/fps*1e6)` 逐帧重算，与 recorder 已修复的“整数微秒累加”不一致；每段多出约 5.3ms，30 段累计 160ms，摄像头轨与屏幕轨逐渐错位。 | 改为 `frameStepUs = round(1e6/fps)` 后按 `i * frameStepUs` 递交。 | 代码审查（对照 recorderRuntime 同款修复注释） | 长录制画中画与屏幕口型/动作逐渐错开（旧版） |
| C4 | P2 | `cameraRuntime.ts:93` | 首帧等待用裸 `setTimeout`+`onloadeddata`，超时后 handler 残留。 | 见 C1 的 `waitForFirstFrame`。 | typecheck | 无 |

> 说明：摄像头段“采集耗时≈段时长”是协议层设计问题（主进程按段边界**事后**拉取实时画面，隐藏窗口只能实时睡满一段）。
> 已由 capture-auditor 改为串行 Promise 链，不再阻塞屏幕段队列；但摄像头画面相对屏幕仍滞后约一个段，根治需要
> “隐藏窗口持续录制 + 段边界切片”，见「未修复风险」。

### 2.4 录制页：RecordView.tsx

| # | 级别 | 位置 | 根因 | 修复 | 验证方式 | 用户可见表现 |
| --- | --- | --- | --- | --- | --- | --- |
| V1 | P1 | `RecordView.tsx:62` | 主进程 `captureListDevices` 明确返回 `video: []`（注释写“视频设备由渲染进程枚举后回传”），但界面从未实现这段枚举 → 摄像头下拉永远只有“系统默认”，面板永远显示“没有检测到摄像头”。 | 新增 `enumerateVideoDevices()`（`navigator.mediaDevices.enumerateDevices`，未授权时给可读兜底名）；空列表时回填；`devicechange` 热插拔（300ms 防抖）只刷新摄像头列表并纠正失效选择；摄像头面板加“重新检测摄像头”。 | typecheck + 代码审查（`main.ts:1461` 注释与实现对齐） | 有摄像头却提示“没有摄像头”、无法选具体设备 |
| V2 | P1 | `RecordView.tsx:433`~`:511` | **双重倒计时**：界面先做 `countdownSeconds` 秒倒计时，随后 `store.startRecording` 把同一个 `config.countdownSeconds` 原样传给采集引擎（`captureEngine.ts:439` 再倒计时一次）。点“开始录制”后实际要等约 6 秒才出画面，且中间 3 秒没有任何提示（引擎的 countdown 事件无人订阅）。 | 在**本文件内**规避：进入启动时把 `countdownSeconds` 临时置 0，用置 0 后那一次 render 的 `startRecording` 发请求（引擎 0 秒立即进入录制），请求结束后恢复用户设置；启动期间按钮显示“正在启动采集…”，`pendingStart` 状态机防止卡死/重复启动。 | typecheck + 逻辑走查（StrictMode、卸载、启动失败 finally 恢复） | “倒计时结束后又干等 3 秒”“两点开始、六秒后才真正录” |
| V3 | P1 | `RecordView.tsx:417` | 切换“显示器/窗口”分栏只改本地 `sourceKind`，`config.sourceId` 仍指向上一个分栏 → 界面显示“窗口”，实际按旧显示器开录；`blockedReason` 也不校验一致性。 | 新增收敛 effect：用 `pickSourceForKind()` 把选中项收敛到新分栏（可用则保留、否则第一个可用、再否则清空）；`blockedReason` 增加 `isSourceInKind()` 校验，不一致时禁止开始。 | 单元测试 `pickSourceForKind` / `isSourceInKind`（7 个用例） | 录到的对象和界面选的不是同一个 |
| V4 | P1 | `RecordView.tsx:281` | 空闲电平动画的清理只 `cancelAnimationFrame(raf)`，而节拍在 `setTimeout` 里；卸载瞬间停在 timeout 窗口内时取消 rAF 是空操作，`tick` 继续排下一轮 → 卸载后每 90ms 仍 setState（反复切视图累积计时器）。 | 加 `cancelled` 标志并同时清理 rAF 与 timeout。 | 代码审查 | 长时间使用后掉帧/内存缓慢上升；控制台 React 警告 |
| V5 | P1 | `RecordView.tsx:260`（`openOutputDir`） | “更换输出目录/选择可写目录”按钮调用 `wcs().pickDirectory()` 后**直接丢弃返回值**：主进程没有“设置输出目录”的 API，录制目录固定为系统视频目录 → 按钮什么也没做，用户以为换了目录，实际磁盘不足仍会中断。 | 改为“打开输出目录”（`openPath(videosPath)`，用 `unwrap` 显示失败原因）；磁盘面板明确说明“录制产物固定保存在系统视频目录，导出时可另存”。 | typecheck + 与 `main.ts` 目录策略核对 | “换了目录还是提示空间不足”“点了没反应” |
| V6 | P1 | `RecordView.tsx:888` | 摄像头预览是 `syntheticCamera()` 合成画面，却标 `Badge tone="ok">设备就绪` —— 用户以为看到了真实取景，实际拍出来完全不同（还可能在没摄像头时显示“就绪”）。 | 改为“示意画面 · 不占用摄像头”，并说明真实取景由独立采集窗口完成（预览不抢占设备）。 | UI 文案审查 | 预览与成片不一致、无设备也显示“设备就绪” |
| V7 | P1 | `RecordView.tsx:115`~`:131` | `loadAll()` 无请求代号：快速点两次“重新检测/重试”时，先发的慢请求晚返回会覆盖后发的新结果；卸载后仍 setState。 | `loadGeneration` 递增 + 请求前后比对；`mountedRef` 兜底；`finally` 只在仍是当前请求时结束 loading。 | 代码审查 | 设备列表/来源偶发“回退成旧值” |
| V8 | P2 | `RecordView.tsx:511` | 倒计时文案写“取消（Esc）”，但只绑了按钮点击，没有 keydown 监听。 | countdown 打开期间监听 `Escape` → `cancelCountdown()`，卸载/结束后移除。 | 代码审查 | 按 Esc 没反应，只能点按钮 |
| V9 | P2 | `RecordView.tsx:139`~`:200` | `checkDisk()` 在 `system` 未加载时用 `checkPath('')`，主进程 `path.dirname('')='.'` → 检查的是进程工作目录，显示一个与真实输出目录无关的剩余空间。 | 路径为空时直接跳过检查（清空 freeBytes/pathCheck），等系统信息回来再查。 | 代码审查 | 启动瞬间“可用空间”显示与实际磁盘不符 |
| V10 | P2 | `RecordView.tsx:533` | 能力表“分辨率-实际能力”用来源尺寸，区域录制时输出其实是区域尺寸；降级后的 effective 也要优先。 | `effectiveResolution`：先 `capture.effective`，再区域尺寸，再来源尺寸；“受源限制”徽标同样按区域宽度判断。 | 代码审查 | 区域录制时显示的输出分辨率错误 |
| V11 | P2 | `RecordView.tsx:539` | 摄像头降级原因（主进程 `camera-degraded`/`session.degradation`）只在能力表 long note 里，摄像头面板看不到。 | 摄像头面板显示真实降级原因（仅当 degradation 含“摄像头”）。 | 代码审查 | 摄像头没录上，用户不知道为什么 |
| V12 | P2 | `RecordView.tsx` | `loadAll` 的 `config` 闭包/默认来源选择分散、`starting` 与 `busy.capture` 双状态；启动按钮在倒计时/启动中仍可点。 | 统一用 `configRef` 读当前配置；启动期间禁用按钮并显示进度态；`startingRef` 同步挡双击。 | typecheck | 连点“开始录制”出现两次启动/一个失败 toast |

### 2.5 导出页：ExportView.tsx

| # | 级别 | 位置 | 根因 | 修复 | 验证方式 | 用户可见表现 |
| --- | --- | --- | --- | --- | --- | --- |
| X1 | P1 | `ExportView.tsx:208`、`:169` | 导出窗口把失败/取消当**正常返回值**带回（见 E2），本页只按 `try/catch` 判断成功 → 编码失败、磁盘不足、取消都会走 `setStatus('done')` 并弹“导出完成”。 | 用 `classifyExportBundle()` 归类 `{video.ok,tutorial.ok,error,cancelled,errorCode}`：失败显示真实错误、取消显示已取消、视频成功但教程失败显示“完成（有告警）”。 | 单元测试 9 个用例 + typecheck | “提示导出完成，打开文件夹没有文件/文件损坏” |
| X2 | P1 | `ExportView.tsx:260` | 点“取消导出”立即 `setStatus('cancelled')` 并宣称“临时文件已清理”，但取消信号可能还没到导出进程（见 E1），实际仍在写文件。 | 引入 `cancelling`：只标记“正在取消…”，最终状态等 `startExport` 的 Promise 结算后由结果决定；文案改为“正在等待导出进程停止”。 | typecheck + 与 E1 联动走查 | “显示已取消，但文件后来还是生成了” |
| X3 | P1 | `ExportView.tsx:100` | 默认输出路径只在 `outputPath` 为空时算一次：换工程后仍沿用上一个工程的路径，二次导出**静默覆盖**上一份产物；工程名含非法字符时还可能拼出无效路径；fallback 里硬编码了开发者本机路径。 | `deriveDefaultOutputPath()` 跟随“视频目录 + 当前工程名”，非法字符收敛；用户手动改过（`pathTouched`）后不再自动改写；系统信息未加载时留空而不是猜路径。 | 单元测试 + typecheck | 换工程后导出覆盖旧文件 |
| X4 | P1 | `ExportView.tsx:565` | 成功但没有展示告警：教程包失败、完整性校验未通过时仍只显示“导出完成”，用户不知道产物不完整。 | 结果卡展示 `warnings[]`，标题变“导出完成（有告警）”，并额外弹 warn toast。 | typecheck | 教程没生成/校验未过却毫无提示 |
| X5 | P2 | `ExportView.tsx:76`、`:91` | 无“正在导出”的同步守卫：两个按钮（顶部与失败卡里的“重试导出”）同一 tick 连点会启动两次；输出路径没有任何前端校验（可填目录、无扩展名），主进程才报错。 | `runningRef` 同步挡重复启动；`validateOutputPath()` 校验非空/非目录/`.mp4`，开始按钮在路径无效时禁用并提示原因；输入框 blur 自动补 `.mp4`。 | 单元测试 + typecheck | 重复导出、写文件失败后才报错 |
| X6 | P2 | `ExportView.tsx:108` | 进度订阅不区分任务：上一任务迟到事件会覆盖新任务进度条。 | `jobIdRef` 过滤非当前 jobId 的事件，且只在 `running` 状态接受进度。 | 代码审查 | 新任务进度条跳到旧任务数值 |
| X7 | P2 | `ExportView.tsx:184`（`revealOutput` 等） | `showInFolder/openPath` 未 `unwrap` IPC 响应：主进程失败时静默无反应（“错误被吞”）。 | 三个动作统一 `unwrap` + `pushError`。 | typecheck | 点“打开文件夹/播放”没反应也没提示 |
| X8 | P2 | `ExportView.tsx:298`（`resetToIdle`） | “再导出一份/返回”只改 status，不清 progress/error/warnings，二次导出前短暂显示上一轮残留。 | `resetToIdle()` 清空进度/错误/告警；顶部按钮在 done 态显示“再导出一份”。 | typecheck | 二次导出前残留旧进度条 |
| X9 | P2 | `ExportView.tsx`（侧栏“磁盘可写”） | 只要 `systemInfo` 非空就显示“已检测”，实际没检查输出目录可写。 | 改为“输出路径可用于导出/原因”徽标（基于 `validateOutputPath`），“磁盘可写”说明由主进程在导出时检查（`checkPath` 并未在导出前调用）。 | 代码审查 | 假的“磁盘可写”结论 |

### 2.6 悬浮窗：OverlayWindow.tsx

| # | 级别 | 位置 | 根因 | 修复 | 验证方式 | 用户可见表现 |
| --- | --- | --- | --- | --- | --- | --- |
| O1 | P1 | `OverlayWindow.tsx:175`（`runAction`） | 暂停/继续/停止/标记按钮：先乐观 `pulse('暂停中')` 再调 `api.pauseCapture()`，**从不检查返回值**。暂停失败（状态不是 Recording）、停止失败、标记失败时仍然显示“已暂停/已标记”，错误被完全吞掉。 | `runAction` 改为 await IPC 并检查 `ok`：失败时状态文字显示“失败 · 原因”（悬浮窗无 toast，这是唯一出口）；同时用 `pendingRef` 同步挡连点。 | typecheck + 代码审查 | 点了暂停但画面还在录，悬浮条还显示“暂停中” |
| O2 | P1 | `OverlayWindow.tsx:23`、`:368` | capture:status 是“推送可丢失”的（窗口刚创建/主进程忙/窗口重载），旧实现丢一条就永久停在旧状态：计时不走、状态不更新，直到下一条事件。 | `createStatusCoalescer()` 做 100ms 合并（§14.3 ≤10 次/秒、窗口内保留最后一次），并加 1.5s 轮询兜底纠偏；卸载时 flush+dispose。 | 单测 5 个用例（合并/最后一次不丢/≤10 次每秒/flush/dispose） | 悬浮条计时“冻住”、状态与主进程不一致 |
| O3 | P1 | `OverlayWindow.tsx`（`onCommand`） | 旧代码订阅 `overlay:command` 但当时主进程没有任何发送方（死链路），快捷键标记的“备忘录当前行作为备注”永远不生效。 | 保留订阅（main-auditor 已补齐 `sendOverlayCommand` 链路），并给每条命令加返回值检查与 console 告警；按钮路径不依赖该链路。 | 与 `main.ts:sendOverlayCommand` / `overlayReady` 交叉核对 | Ctrl+Alt+M 添加的标记没有备注 |
| O4 | P2 | `OverlayWindow.tsx:146` | “标记”按钮在 Idle/Stopping 等状态下仍可点；主进程 `addMarker` 不校验状态，于是弹“已标记”但实际没有有效时间点。 | 只有 Recording/Paused/Pausing/Resuming 可标记（`canMark`），其他状态禁用。 | typecheck | 非录制状态点标记“成功”却无意义 |
| O5 | P2 | `OverlayWindow.tsx`（`memoMarkNote`） | 取备注时用“光标之前的半行”，光标停在行中间会把备注截成半句（“第二行内容”→“第二”）。 | 取光标所在**整行**（向前找行首、向后找行尾），空行再回退最后一行非空；移入 `uiSync.ts` 加 4 个测试。 | 单测 | 标记备注被截断 |
| O6 | P2 | `OverlayWindow.tsx` | `OverlayBar` 的 `onMemoTextChange` 属性从未被使用（textarea 由外层渲染）；`Kbd` 导入未用。 | 删除死属性与未用导入。 | typecheck | 无 |

### 2.7 样式：styles.css

| # | 级别 | 位置 | 根因 | 修复 | 验证方式 | 用户可见表现 |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | P2 | `styles.css:1390` | RecordView 使用 `.check-hint`，样式表只有 `.check-hint-text`，说明文字与按钮容器没有间距约束。 | 新增 `.check-hint`（纵向 flex + gap + 最小宽度）。 | class 审计脚本 | 开始前检查区域排版拥挤/错位 |
| S2 | P2 | `styles.css:1468` | OverlayWindow 在窄窗时加 `.is-narrow`，但无 `.rec-bar.is-narrow` 规则；目前完全靠行内样式覆盖 620px 最小宽度。 | 补 `.rec-bar.is-narrow` 及其子元素规则（min-width:0、紧凑字号/间距、状态文字省略号），行内样式可后续移除。 | class 审计脚本 + `docs/screenshots/verify-overlay.json`（460×132 无溢出）对照 | 一旦行内样式被移除，460px 悬浮条被裁切 |
| S3 | P2 | `styles.css:1569` | `.overlay-memo-popover` 类名在组件中使用但样式表没有定义（纯靠行内样式）。 | 按行内同等数值补类级规则（position/尺寸/边框/背景/阴影/纵向 flex），并把 textarea 的 `resize:none` 收进 CSS。 | class 审计脚本 | 备忘录浮层样式只存在于行内，重构即丢失 |
| S4 | P2 | `styles.css:443`、`:573`、`:1279` | 其他 agent 组件在用但样式表缺失的类：`.wcs-btn-label`（每个 Button 的文字节点）、`.wcs-field-control`（Field 控件容器）、`.wcs-canvas-frame`（CanvasFrame，当前未被视图使用）。 | 补三条规则（按钮文字省略、字段控件纵向布局、画面框比例裁切）。 | class 审计脚本 | 按钮长文案溢出/字段布局散；CanvasFrame 若启用则无边框背景 |
| S5 | P2 | `styles.css`（未使用类） | 扫描出 30+ 个“样式表有、源码无”的类（`device-*`、`quick-action-*`、`overlay-stage`、`overlay-under`、`rail-mode`、`timeline-empty`、`tl-scrub-layer`、`swatch-gradient` 等，部分是其他 agent 动态拼接）。 | **未删除**：动态类名（`is-${tone}`、`is-${size}`）无法静态判定，删除风险大于收益；清单见本文附录 A。 | class 审计脚本 | 无（死样式） |

## 3. 新增的纯逻辑与测试

- `src/renderer/uiSync.ts`（新文件，无 React/DOM 依赖）：
  - `createStatusCoalescer()`：悬浮窗状态合并节流（≤10 次/秒，保留最后一次）。
  - `classifyExportBundle()`：导出结果归类（done/cancelled/failed + warnings）。
  - `sanitizeFileStem()` / `deriveDefaultOutputPath()` / `normalizeOutputPath()` / `validateOutputPath()`：导出路径。
  - `memoMarkNote()`：备忘录当前行 → 标记备注。
  - `pickSourceForKind()` / `isSourceInKind()`：来源分栏收敛。
  - `planFramePicks()`：录制分段选帧（抽稀/补帧）。
- `tests/renderer/uiSync.test.ts`：**43 个测试**，覆盖上述全部函数（含边界输入、取消/失败分支、目录与非法字符、单调性）。

## 4. 跨范围发现（未修改，已核对当前代码状态）

> 以下文件不属于本任务写入范围，未做修改；行号基于本轮审计时的代码状态。

| # | 级别 | 位置 | 问题 | 状态 / 建议 |
| --- | --- | --- | --- | --- |
| A1 | **P1** | `electron/main.ts:2118`（`sendAppEvent('shortcut',{action:'start-recording'})`） | 全局快捷键 Ctrl+Alt+R 在 Idle 时只向渲染进程发 `capture:event`，但**整个 renderer 没有任何 `onAppEvent` 订阅**（`grep onAppEvent` 仅命中 mock 实现）→ 快捷键“开始录制”完全无效果。同时 `camera-degraded`、`marker-added`、`shortcut-conflict`、`overlay-protection-unsupported`、`countdown` 事件也无人消费。 | **未修复（跨范围）**。建议 ui-core 在 store 统一订阅 `onAppEvent`：shortcut→startRecording/stop、marker-added→toast、camera-degraded→降级提示、countdown→记录剩余秒数（当前只有引擎倒计时会发）。 |
| A2 | **P1** | `src/renderer/lib/store.tsx:677` + `electron/capture/captureEngine.ts:439` | 双重倒计时根因：`startRecording` 原样把 `config.countdownSeconds` 传给引擎，引擎在 `engine.start()` 内部再倒计时一次。RecordView 的临时规避（V2）只覆盖 UI 入口，未来任何其他调用方仍会踩。 | **未修复（跨范围）**：建议 `store.startRecording(options?: {countdownSeconds?: number})` 支持覆盖，或引擎改为“不自行倒计时、由 UI 驱动”；届时可删掉 RecordView 的临时置 0/恢复逻辑。 |
| A3 | P2 | `electron/main.ts:811`（`serializeAudio(info.audio.mic)`） | 段载荷仍把整段 PCM 序列化成 JSON 传给 recorder 窗口（每段数 MB 文本 + 主进程序列化阻塞），而 recorder 已不再内嵌音频（R1）→ 纯浪费。 | **未修复（跨范围）**：建议主进程不再把 audio 放入段载荷；若未来要启用段内嵌音轨，应先提供**段内相对采样偏移**。 |
| A4 | P2 | `electron/main.ts:1921`（`export:start` `return result`） | 主进程不检查导出窗口返回的 `video.ok/error/cancelled`，把业务失败当成功 IPC 返回；本轮已在 `ExportView` 侧用 `classifyExportBundle` 兜住，但其他调用方（verify 脚本）仍可能误判。 | **未修复（跨范围）**：建议主进程在 `result.error` 或 `video?.ok === false` 时抛 `E_EXPORT_FAILED`（窗口销毁已有 finally 兜底，不会泄漏）。 |
| A5 | P2 | `electron/main.ts:1461` | `captureListDevices` 返回 `video: []`，注释写“界面自行枚举”；现在 RecordView 已补枚举（V1），但 Settings/其他视图若也用该接口会得到空列表。 | **已部分缓解**：建议主进程直接返回摄像头枚举结果（或返回能力探测），避免每个渲染入口各写一份枚举。 |
| A6 | P2 | `electron/preload.ts:109` + `main.ts:2050`（`window:update-overlay`） | `window.wcs.overlay` 只在 overlay 角色暴露，主窗口无法调用 `overlay.update()`；`window:update-overlay` 通道目前没有任何 renderer 调用方（主进程直接推 capture:status 已足够）。 | **确认不需要**：OverlayWindow 不依赖 `update()`；建议删除 `OverlayApi.update` 与对应通道，或明确由主窗口在某处使用。 |
| A7 | P2 | `src/renderer/views/HomeView.tsx:289` | `.recent-open` 类在 styles.css 无定义（目前靠组件行内样式兜底）。 | **未修复**：建议 ui-core 把行内样式收敛成类，由本文件补 CSS；当前无布局 bug。 |
| A8 | P2 | `src/renderer/components/ui.tsx:961`（`CanvasFrame`） | 组件与 `.wcs-canvas-frame` 均无任何视图使用（疑似死代码）；本轮已补该类的样式，避免将来启用时裸奔。 | 待 ui-core 决定删除或启用。 |
| A9 | P2 | `electron/main.ts`（`captureStart` 在 `engine.start` 之后才 `createOverlayWindow`） | 悬浮窗在引擎倒计时**结束之后**才创建，所以它永远看不到 `Countdown` 状态；“倒计时中可取消”只能靠主窗口。 | 目前 RecordView 已在主窗口完成倒计时（V2），悬浮窗只需承担录制中控制，影响可控；若未来改为引擎倒计时，需把 `createOverlayWindow()` 提到 `engine.start()` 之前。 |

## 5. 未修复风险

1. **摄像头轨与屏幕轨的时间语义**：`cameraRuntime.encodeSegment` 必须在调用期间实时睡满一个段落（否则全是同一帧）。
   即使主进程已改成串行 Promise 链，摄像头画面仍比屏幕滞后约一个段（约 2s），且同一段内边缘帧可能重复。
   根治方案是“隐藏窗口持续采集 + 段边界切片/环形缓冲”，属于 capture 层重构，不在本任务范围。
2. **录制端 `capture.effective` 依赖主进程推送**：能力表在“录制开始后”才显示真实编码器/帧率；
   若主进程不再推送 `capture:status`（例如窗口创建失败），界面只能回退到“开始录制后确认”，无法提前探测可用编码器。
3. **临时倒计时规避的边界**：在“正在启动”的极短窗口内修改倒计时设置会被启动流程覆盖并恢复为启动前的值；
   若 `store.startRecording` 未来支持覆盖参数，应删除该逻辑（已在代码注释中标注）。
4. **端到端未验证**：本轮只做静态审查 + typecheck + 单测；隐藏窗口的 `executeJavaScript` 往返、取消时序、
   悬浮窗命令链路需要真实 Electron 环境回归（建议 `npm run verify:e2e` / 手动录制 30s + 取消导出）。
5. **样式未做像素级回归**：新增/修改的规则只在 460×132 悬浮窗与常规窗口的静态类名层面核对，
   建议用 `npm run verify:layout` / `verify:overlay` 复跑截图对比（本轮按纪律未运行）。

## 6. 验证记录

```
npx tsc --noEmit -p tsconfig.json         → exit 0（无错误）
npx vitest run                            → Test Files 28 passed, Tests 786 passed
  └ tests/renderer/uiSync.test.ts         → 43 passed（本轮新增）
class 审计（临时脚本 .tmp/class-audit2.mjs，不入库）：
  本范围内 RecordView / ExportView / OverlayWindow 使用的 className 100% 存在；
  剩余缺失仅 .recent-open（HomeView，行内样式兜底）与动态拼接类误报。
```

## 附录 A：styles.css 中静态未使用的类（未删除）

`device-icon`、`device-main`、`device-name`、`device-row`、`device-sub`、`device-text`、`export-summary`、
`is-accent`、`is-countdown`、`is-finalizing`、`is-info`、`is-lg`、`is-md`、`is-mic`、`is-mock`、`is-muted`、
`is-rec`、`is-recording`、`is-secondary`、`is-success`、`overlay-demo-note`、`overlay-stage`、`overlay-under`、
`quick-action`、`quick-action-desc`、`quick-action-icon`、`quick-action-text`、`quick-action-title`、`rail-mode`、
`step-toolbar`、`swatch-gradient`、`timeline-empty`、`tl-scrub-layer`。

> 注意：`is-countdown` / `is-finalizing` / `is-recording` / `is-paused` 等由 OverlayWindow 的
> `visualFor()` 以对象属性值动态返回（`className: 'is-recording'`），静态扫描会误报为未使用，实际在用。
> 其余（`device-*`、`quick-action-*`、`overlay-stage/under` 等）疑似历史组件残留样式，删除前需要确认没有
> 其他 agent 正在接入的计划。

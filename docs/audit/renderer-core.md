# 渲染层核心审计修复报告（lib / App / main / ui / Home / Settings）

- 范围：`src/renderer/lib/**`、`src/renderer/App.tsx`、`src/renderer/main.tsx`、
  `src/renderer/components/ui.tsx`、`src/renderer/views/HomeView.tsx`、`src/renderer/views/SettingsView.tsx`
- 基线：typecheck 通过；453 个 domain 测试通过；UI 无自动化单测（`verify-ui.cjs` 覆盖主窗口/悬浮窗截图）。
- 方法：逐文件静态审计 + 状态机推演 + 纯逻辑抽离后单测。**行号均为修复前基线行号**。
- 验证：`npx tsc --noEmit -p tsconfig.json`（本范围 0 error）；`npx vitest run tests/renderer` 全绿。

## 一、结论摘要

共确认并修复 **22 个缺陷**（P0 × 2、P1 × 12、P2 × 8），新增 4 个纯逻辑测试文件（57 例）。
两条 P0 都会造成「用户看到的状态与真实磁盘/真实媒体不一致」：一是启动/悬浮窗替用户弹出并吞掉
「打开工程」对话框，二是示例数据模式把保存与导出伪装成成功。

主要改动文件：`lib/store.tsx`（状态一致性/竞态）、`lib/wcs.ts`（超时与 mock 诚实性）、
`lib/hooks.ts`（空格快捷键/焦点输入保护/长按去重）、`lib/format.ts`（取消与空结果语义）、
`lib/settings.ts`、`lib/state.ts`（新增纯逻辑模块）、`components/ui.tsx`（Modal/错误边界/ARIA）、
`App.tsx`、`main.tsx`（错误兜底与窗口角色）、`views/HomeView.tsx`、`views/SettingsView.tsx`。

## 二、问题表

### P0

| # | 位置（修复前） | 根因 | 修复 | 验证 | 用户可见表现 |
|---|---|---|---|---|---|
| P0-1 | `lib/store.tsx:622-645`（启动引导）、`main.tsx:71-77` | 启动 effect 无条件调用 `wcs().openProject()`；真实模式下主进程该 IPC 会 `showOpenDialog`。overlay 窗口也挂了 `AppProvider`，悬浮窗一出现就再次触发主窗口初始化（含该对话框）。取消对话框时主进程返回 `ok(null)`，旧 `unwrap` 返回 `null`，`handle.project` 抛 TypeError 被吞成「打开工程失败」。 | 启动只在 `apiMode()==='mock'` 时载入示例工程；新增 `unwrapOptional` 明确区分「用户取消」与失败；overlay 不再挂 `AppProvider`（`OverlayWindow` 本来也不使用它）。 | 代码级：`unwrapOptional` 用例覆盖 `ok:null/ok:false/undefined`；typecheck。 | 真实模式每次启动（录制时每次悬浮窗出现）弹出系统「打开工程」对话框、取消后还报错。 |
| P0-2 | `lib/store.tsx:431-451`、`lib/wcs.ts:427-521`（mock `startExport`） | 无 preload 时 `wcs()` 静默回退 MockWcs：`saveProject` 返回成功 → store 清 dirty 并提示「工程已保存」；`startExport` 返回 `verified:true` 的 42MB 假结果，实际一个字节不写。演示/探针能力变成了对用户的假承诺。 | mock 导出改为**显式失败**（`E_EXPORT_FAILED`，说明未连主进程、不会写文件）；保存成功文案在 mock 下改为「示例数据模式：未写入磁盘」；mock 模式跳过自动保存；mock 删除工程同步清理最近列表。 | 单测（设置/状态）+ 代码级；verify-ui 不点导出，不受影响。 | 断掉 preload 的安装包/演示环境里，用户以为工程已保存、视频已导出。 |

### P1

| # | 位置（修复前） | 根因 | 修复 | 验证 | 用户可见表现 |
|---|---|---|---|---|---|
| P1-1 | `lib/store.tsx:394-414`（save） | ① 无并发保护，手动保存与自动保存可同时发两次 IPC，旧响应覆盖新状态；② 保存期间继续编辑，响应回来直接 `setDirty(false)`，这段编辑再也不会被保存；③ 自动保存每 2 秒弹「工程已保存」；④ 失败时每 2 秒弹一次错误。 | 引入 `savingRef` 串行化 + `pendingSaveRef` 补存；成功后比较 `projectRef.current === 快照` 才清 dirty；自动保存成功静默；失败进入 15 秒退避且每分钟最多提示一次；保存超时 30s（`withTimeout`）。 | 竞态推演 + typecheck；退避延迟由 `nextAutoSaveDelay` 单测覆盖。 | 编辑被打断后「已保存」但内容丢失；刷屏提示。 |
| P1-2 | `lib/store.tsx:300-324`（openProject） | 无请求序号：先点 A 再点 B，A 响应后到会覆盖 B，出现「打开的是 A，标题是 B」；失败时也会把 `projectLoading` 重置。 | `projectRequestSeq` 序号，迟到结果整体丢弃；抽 `adoptProject` 统一重置撤销栈/选择/播放头；`openProject` 返回 `boolean`。 | 代码级 + HomeView 调用方按返回值跳转。 | 连续打开工程后显示错误工程；加载状态卡住。 |
| P1-3 | `lib/hooks.ts:36-44`、`:60-68` | ① `normalizeEvent` 对空格返回 `' '`，而 EditorView 注册的是 `combo:'space'`，**空格播放/暂停永远不触发**；② 长按重复事件没有过滤，按住空格会以键盘重复率反复播放/暂停，按住 Ctrl+B 会连续分割、按住 Ctrl+Z 连续撤销。 | 新增 `normalizeShortcutEvent`：空格→`space`、`Esc`→`escape`；`useShortcuts` 默认忽略 `event.repeat`，仅方向键保留连按（可用 `allowRepeat` 覆盖）。 | `tests/renderer/state.test.ts`（空格/组合键归一化回归）。 | 按空格不能播放；按住快捷键会触发几十次操作。 |
| P1-4 | `lib/store.tsx:719` | `capturing` 仅排除 4 个状态，`RecoverableFailure` 被算作「正在录制」。 | 抽出 `isCaptureActive`（排除 Idle/ReadyToEdit/Cancelled/RecoveryReady/RecoverableFailure），补全量状态单测。 | `state.test.ts` 逐状态断言。 | 录制已经失败，顶栏仍显示「正在录制 00:00:xx」。 |
| P1-5 | `lib/store.tsx:570-582`（cancelRecording） | `await wcs().cancelCapture()` 未 `unwrap`，`{ok:false}` 被静默吞掉还提示「已取消录制」。 | `unwrap(await withTimeout(...))`，失败走 `pushError`。 | 代码级。 | 取消录制失败时用户以为素材已清理。 |
| P1-6 | `components/ui.tsx:764-812`（Modal，effect deps `[onClose]`） | 父组件传内联 `onClose`，每次渲染都重建 keydown 监听并 `focus()` 首个可聚焦元素（实际是右上角关闭按钮）；无 Tab 焦点陷阱、无焦点恢复、无背景滚动锁，嵌套模态框的 Esc 会一起关闭。 | `onCloseRef` 脱离依赖；模态栈（Esc 只关最上层）；Tab 循环焦点陷阱；初始焦点优先输入框/页脚首个按钮（危险确认默认落「取消」）；关闭恢复触发元素焦点；锁定 `body` 滚动；`aria-labelledby` 替换字符串 aria-label。 | 代码级 + 焦点顺序推演；带内联 onClose 的 HomeView 删除确认实测路径。 | 在确认框里打字会被抢焦点；Tab 能跑到弹窗后面；Esc 连关两层。 |
| P1-7 | `lib/store.tsx:506-508` + `lib/store.tsx:64-73`、`views/SettingsView.tsx:166-203` | ① 设置页文案承诺「修改会立即生效并保存在本机」，但 `config` 只是 React state，重启全丢；② 设置页只改 `qualityId` 不改 `fps`，于是会出现 1080p60 档位 + 30fps 的错配录制。 | 新增 `lib/settings.ts`：capture 默认值/窗口置顶/最近目录持久化到 localStorage（带损坏回退与字段规整）；`updateConfig` 改走 `mergeCaptureConfig`，画质档位强制同步 fps；倒计时夹到 0..10。 | `tests/renderer/settings.test.ts`（13 例）。 | 重启后所有录制设置回到默认；选了 60 帧仍按 30 帧录。 |
| P1-8 | `views/HomeView.tsx:44-66`（handleOpen/handleRecover） | `openProject` 内部吞错返回 void，调用方无条件 `setView('editor')`：打开失败/取消也跳编辑器，编辑器里是旧工程或空；恢复会话成功但打开失败时还提示恢复成功。 | `openProject` 返回 boolean，只有成功才跳转；恢复流程先刷新可恢复列表，打开失败不再提示成功。 | 代码级。 | 对话框点取消后被带到编辑器；恢复提示与实际不符。 |
| P1-9 | `views/HomeView.tsx:44-47` | 有未保存修改时直接打开另一个工程，静默丢弃修改（自动保存 2 秒窗口内的编辑必丢）。 | 新增「当前工程有未保存修改」确认框：保存并打开 / 放弃修改并打开 / 取消；保存失败时保留对话框。 | 代码级 + store.save 返回值。 | 切换工程丢最近改动且无提示。 |
| P1-10 | `views/HomeView.tsx:94-107`、`:264` | ① `void wcs().revealProject()` 忽略 `{ok:false}`，打开资源管理器失败无反馈；② 删除工程时主进程还会再弹一次系统确认，主进程侧取消返回 `ok(null)`，渲染层却提示「工程已删除」；③ 删除的是当前打开工程时 store 仍持有 `projectPath`，之后保存会写回已删除目录。 | 新增 `format.isCancelledError`（统一识别 `E_EXPORT_CANCELLED`）：取消时只提示「已取消删除工程/已取消恢复会话」等中性信息，绝不显示失败或成功；其余错误走 `pushError`；删除当前工程时调用 `closeProject()`；恢复会话丢弃改为二次确认模态框。 | 代码级（主进程取消语义见「跨范围」；两种取消实现 ok(null) 与错误码均兼容）。 | 删除失败/取消却提示成功；删除后继续编辑再保存把目录“复活”。 |
| P1-11 | `lib/store.tsx:601-620`（录制状态订阅） | 主进程按 ~10Hz 推送状态，只要 `status.error` 非空就每次 pushToast，错误持续时产生提示风暴。 | 按 `code:message` 去重，只有新错误才提示；恢复后重置。 | 代码级。 | 录制出错时提示条连续弹出、盖住界面。 |
| P1-12 | `lib/store.tsx:552-568`（stopRecording） | 停止录制时主进程会先推 `ReadyToEdit` 状态、再返回 stop 结果：状态订阅和 stopRecording 各打开一次工程。 | `stopFlowRef` 标记停止流程，订阅不再重复打开；打开成功才跳编辑器。 | 代码级。 | 停止后工程被加载两次、白屏/闪烁，最近工程重复刷新。 |

### P2

| # | 位置（修复前） | 根因 | 修复 | 验证 | 用户可见表现 |
|---|---|---|---|---|---|
| P2-1 | `views/HomeView.tsx:226-281` | 最近工程行是 `role="button" tabIndex=0`，内部又放 3 个 `IconButton`：嵌套交互违反 ARIA，键盘 Space/Enter 与内部按钮冲突。 | 外层改普通容器；打开动作改为真实 `<button class="recent-open">`（内联样式占满前两列），操作按钮成为兄弟节点；缩略图 `alt` 置空避免重复朗读（按钮已带名称）。 | 结构审阅；需样式 agent 补 `.recent-open:focus-visible`（全局 `:focus-visible` 已提供 focus ring）。 | 读屏器把整行当按钮又读到 3 个按钮；键盘操作错乱。 |
| P2-2 | `App.tsx:206-250`、`main.tsx:63-83` | 无 React ErrorBoundary；任一视图渲染抛错 → 整个窗口白屏（Electron 里等于假死）。`#root` 缺失时直接 throw。 | `ui.tsx` 新增 `ErrorBoundary`：App 内按视图 key 降级、main.tsx 顶层兜底（含 overlay），提供「重试」；`#root` 缺失渲染可读错误而不是白屏。 | typecheck + 结构审阅。 | 某个面板 JS 错误导致整个应用白屏无法返回。 |
| P2-3 | `App.tsx:19-42`、`ui.tsx:764-812` | Toast 容器无 `aria-live`，读屏器不播报；Modal 初始焦点落在「关闭」按钮，危险确认框容易误关。 | Toast 容器 `aria-live=polite`，danger 项 `role=alert`；Modal 初始焦点顺序修正（见 P1-6）。 | 代码级。 | 读屏用户不知道操作结果；Tab 一下就把确认框关了。 |
| P2-4 | `App.tsx:209-223` | 自定义 Ctrl+1..6 监听未复用统一 guard：模态框打开时也切视图，确认框随视图卸载而消失；SELECT/contenteditable 判断不全。 | 改用 `useShortcuts`（输入框保护 + 模态框检测），组合键含 shift 时不再误触发。 | `state.test.ts` 组合键用例。 | 确认框打开时按 Ctrl+2，删除确认直接消失。 |
| P2-5 | `views/SettingsView.tsx:205-228`、`:230-234` | ①「选择目录」调用 `pickDirectory()` 后丢弃返回值 —— 无效控件；② 诊断时间用 `formatDateTime(Date.now())`，每次渲染显示当前时间；③ 置顶失败只弹 toast 不回滚开关，IPC reject 未捕获；④ 系统信息读取失败后永远停在「正在读取…」。 | 「选择目录」改为「打开输出目录」（对 `videosPath` 调 `openPath` 并处理失败）；诊断记录真实导出时刻；置顶失败回滚并保存成功状态，启动时恢复持久化置顶；新增 `refreshSystemInfo` 并接入「刷新数据」。 | 代码级；`settings.ts` 单测覆盖持久化。 | 点「选择目录」什么也没发生；「最近诊断」时间每次刷新都变。 |
| P2-6 | `lib/store.tsx:242-256`（pushToast） | 超过 4 条时用 `prev.slice(-3)` 丢弃旧 toast，但旧 toast 的 timeout 未清理（定时器泄漏）；setState updater 内做副作用，StrictMode 下可能执行两次。 | toast 列表改 ref 持有，丢弃项同时 `clearTimeout`，副作用移出 updater。 | 代码级。 | 长时间使用后无意义定时器累积。 |
| P2-7 | `lib/store.tsx:484-503`（removeSourceAsset） | 移除素材后 `selectedClipId/selectedEffectId/selectedStepId` 可能指向已不存在的对象，播放头可能超出新时长。 | 清除失效选择、`setTick` 收敛到新时长。 | 代码级。 | 属性面板显示已删除片段的“幽灵”属性。 |
| P2-8 | `lib/store.tsx:300-324`、`lib/waveform.ts:245-248` | `clearWaveformCache()` 全仓无调用点：波形缓存键是「素材 id + 字节数 + 采样率 + 声道」，切换工程时若素材 id 相同会命中上一个工程的峰值数据。 | `adoptProject` / `closeProject` 时清空波形缓存。 | 代码级；`clearWaveformCache` 已有 domain 波形测试覆盖其语义。 | 新工程的时间线偶尔显示上一个工程的波形。 |

### 清理项（无功能影响）

- `lib/wcs.ts:40` 未使用的 `secondsToTicks` 导入；`lib/mockData.ts:24` 未使用 `TutorialStep`；`lib/mockData.ts:31` 未使用 `id()`；`mockMarkers()` 全仓无引用（一并删除，缩小 mock 表面）。
- 新增 `withTimeout` / `IPC_TIMEOUT` 并接入保存、列表、系统信息、取消录制、诊断导出（导出/打开工程这类长任务不设短超时）。
- 新增 `lib/state.ts`（捕获状态、播放头收敛、自动保存延迟）与 `lib/settings.ts`（持久化 + 配置派生），把可测逻辑与 React 解耦。

## 三、未修复风险（需后续排期）

1. **无 preload 仍会静默进入示例模式**：这是 `verify-ui.cjs`（不注入 preload）的既定路径，无法仅凭渲染层区分「开发/探针」与「安装损坏」。已用显式失败/明确文案降低欺骗性，但根本上应在主进程做 preload 健康检查并在缺失时显示致命错误页（跨范围，main）。
2. **录制状态 10Hz 更新整个 AppContext**：录制时所有消费 `useApp()` 的视图每 100ms 重渲染（含编辑器画布所在树）。正确修法是拆分 CaptureContext 或对外用 `useRafValue` 节流，涉及全部视图，未在本次范围实施。
3. **波形缓存**：已在切换/关闭工程时清空（见 P2-8）；若后续改为跨工程复用，需要把工程 id/路径并入缓存键。
4. **自动保存窗口**：停止编辑后 2 秒内崩溃仍会丢最后一段修改（设计如此，文档已写明）；关闭窗口的兜底依赖主进程 `beforeunload` 流程，渲染层只能提示。
5. **`useShortcuts` 用 CSS 类 `.wcs-modal-backdrop` 判断模态框**：耦合样式类名，样式 agent 改名会导致全局快捷键穿透。
6. **EditorView 的「打开工程」入口未做未保存确认**（HomeView 已做）；建议复用同一确认组件/流程（跨范围）。
7. **mock 示例缩略图/画面**在真实模式下的误用不在本文件范围（见下节 P0）。

## 四、跨范围发现（只记录，已同步 Lead）

1. **P0 假画面进入真实工程**（Lead 已路由 ui-editor-auditor）：`src/renderer/components/PreviewCanvas.tsx:100-104`、`src/renderer/views/TutorialView.tsx:50/53` 曾无条件使用 `syntheticScreen/syntheticCamera` 作为“已解码源帧”，不看 `apiMode`。真实录制工程在编辑器与教程中的预览永远显示演示桌面（含虚构邮箱/手机号），与“预览=导出所见”的承诺矛盾。
2. **P1 IPC 契约不一致**（Lead 已解决）：`electron/preload.ts:40` `listDisplays` 曾调用 `capture:list-sources` 通道并返回 `CaptureSourceInfo[]`；Lead 已在 `shared/ipc.ts` 新增 `capture:list-displays` 等通道，main-auditor 改造 preload/main。
3. **取消语义**（Lead 已改 `src/shared/api.ts`：`openProject`/`importPack`/`pickSavePath` 声明为 nullable；main-auditor 负责把取消统一成错误码）：我侧 `store.openProject` 对 `data===null` 与 `E_EXPORT_CANCELLED` 两种情况都当作「用户取消」静默返回；Home 的删除/恢复/丢弃/移除用 `isCancelledError` 提示中性「已取消」。剩余风险在其它调用方（如 ExportView 的 `pickSavePath`）仍可能把取消显示成失败，属 ui-editor/ui-record 范围。
4. **P1 删除工程双确认 + 取消假成功**：`electron/main.ts:976-985` 主进程自己再弹一次 `showMessageBox`，取消返回 `ok(null)`；渲染层会提示「工程已删除」。（main + 我 Home 已加防护，建议删一处确认）
5. **P2 隐藏窗口运行时副作用**（Lead 负责并做真机验证，我未改动这三个 runtime）：`main.tsx` 静态 import 三个 runtime，导致主窗口/悬浮窗也执行 `exporterRuntime.ts:58` 的 `configureMediabunny` 与 `console.log`，并把 mediabunny 打进主窗口 bundle。
6. **P2 样式需求**：最近工程行结构改为 `button.recent-open` 后，建议在 `styles.css` 补 `.recent-open { border-radius; }` 与 `.recent-open:focus-visible` 的局部焦点样式（全局 `:focus-visible` 已生效，非阻塞）。（styles 范围）
7. **新增文件说明**：为保持可测性新增 `src/renderer/lib/state.ts`（纯状态推导）与 `src/renderer/lib/settings.ts`（界面偏好持久化），未触碰 ui-editor-auditor 的 `src/renderer/lib/previewSource.ts`（该文件不存在时也未创建）。

## 五、验证记录

- `npx tsc --noEmit -p tsconfig.json`：全仓 **0 error**（本报告定稿时）。
- `npx vitest run`（全量）：**28 个文件、786 例全部通过**（报告定稿时）。
  - 其中我新增 4 个测试文件共 57 例：`tests/renderer/format.test.ts`（14）、
    `tests/renderer/settings.test.ts`（14）、`tests/renderer/state.test.ts`（25）、
    `tests/renderer/ipcTimeout.test.ts`（4）。覆盖 IPC 取消/空结果解包、IPC 超时、
    设置持久化与配置派生、录制状态分类、播放头收敛、自动保存延迟/退避、空格快捷键回归。
- 未运行 `npm run build` / `pack` / `verify:*` / Electron（按团队纪律，避免与其它 agent 并行构建冲突）；
  UI 层修复以代码级推理 + 纯逻辑单测 + `verify-ui.cjs` 依赖路径分析验证。

# 编辑器 / 教程界面审计修复报告

范围（独占写入）：`src/renderer/views/EditorView.tsx`、`views/TutorialView.tsx`、`components/InspectorPanel.tsx`、`components/Timeline.tsx`、`components/PreviewCanvas.tsx`、`components/AudioWaveform.tsx`。
新增（Lead 授权）：`src/renderer/lib/previewSource.ts`、`tests/renderer/editor-math.test.ts`。
未改动：`styles.css`、`src/domain/**`、`src/media/**`、其它视图/组件、`package.json`/`tsconfig.json`。

验证：
- `npx tsc --noEmit -p tsconfig.json`：通过（含 `--noUnusedLocals` 抽查本范围文件，无未使用告警）。
- `npx vitest run`：28 个测试文件 / 786 个用例全绿；其中新增 `tests/renderer/editor-math.test.ts` 35 例覆盖本报告中的坐标/夹紧/门禁逻辑。
- 未运行 `npm run build` / `pack` / `verify:*` / electron（按任务纪律；自动化 UI 脚本只支持 mock 模式，真实解码路径需手工验证，见「未修复风险」）。

---

## 一、问题表

### P0

| # | 文件:行 | 根因 | 修复 | 验证 | 用户可见表现（修复前） |
|---|---|---|---|---|---|
| P0-1 | `PreviewCanvas.tsx:123-148`（旧版 101-104）、`TutorialView.tsx:60-160`（StepThumb 旧版 49-54）；新增 `lib/previewSource.ts` | 预览/教程截图**无条件**用 `syntheticScreen()/syntheticCamera()` 当「已解码源帧」，不判断 apiMode；真实录制工程里显示的是内置演示桌面（含合成邮箱、手机号），与导出（exporterRuntime 解码真实分段）完全不一致，违背 §11.5 预览一致性与 README「所见即所得」 | ① 新增 `previewSource.shouldUseSyntheticPreview()`：仅 `detectApiMode()==='mock'`（真实 Electron 里没有 `window.wcs`）才允许 synthetic；② 真实模式新增 `PreviewMediaCache`：`wcs().listMediaSegments` 取分段 → `wcs().readExportFile` 读字节 → `VideoFrameSource.open()/getFrameAt()` 解真实帧；按 assetId 缓存解码器、请求串行、连续拖拉时旧请求在解码前被最新 token 跳过；③ 解码未就绪时画中性占位（深灰底 +「正在解码预览画面…」），**绝不回退 synthetic**；④ 组件卸载/换工程 `dispose()` 关闭全部 VideoFrameSource；⑤ 摄像头按 `TimeMap.toSource('camera', tick)` 解真实摄像头帧；⑥ EditorView 传入 `projectPath`，TutorialView 用共享 `usePreviewMedia` 给 StepThumb 用 | `tests/renderer/editor-math.test.ts`「预览画面来源」4 例（mock 门禁、绝对路径、帧缓存键）；typecheck；真实解码路径需 native 手工验证 | 真实录制 8s 后进编辑器，预览/教程截图是假的演示桌面；用户以为录错了或隐私内容被替换 |

### P1

| # | 文件:行 | 根因 | 修复 | 验证 | 用户可见表现 |
|---|---|---|---|---|---|
| P1-1 | `EditorView.tsx:344`（旧版 307-312）、`PreviewCanvas.tsx:243-287` | 预览框选遮挡时用 `screenBox` 做「显示→源」换算，**忽略运镜检查（zoom/focus）**；而遮挡框显示走 `toDisplayRect`（含运镜）。有运镜时新建的遮挡矩形与用户框的位置/大小错位 | 抽出纯函数 `sourceRectToDisplayRect` / `displayRectToSourceRect`（与 domain `sourceToOutput` 同一视口公式），`onStagePointerUp` 改用 `toSourceRect` 逆变换；再与 [0,1] 求交、`clampPrivacyRect` 夹紧；框完全在画面外时拒绝并提示 | 单测「源坐标 ↔ 显示坐标」3 例（无运镜往返、2× 运镜往返、放大后源框更小） | 运镜片段里框选敏感信息，保存后遮挡框跑到别的位置或大小不对；已确认的遮挡可能没真正盖住目标 |
| P1-2 | `EditorView.tsx:72-110`、`EditorView.tsx:243-292`、`Timeline.tsx:694` | 删除/波纹删除/撤销重做后：① tick 仍可能大于新时长；② `selectedClipId/selectedEffectId/selectedStepId` 仍指向已不存在的实体。按 Delete 会执行注定失败的命令并弹错误提示；播放头停在内容外 | 新增「播放头夹紧」effect（`tick > timelineDuration` → `setTick(totalDuration)`）；新增「失效选择清理」effect（选中 id 不存在 → 清空）；`deleteSelection` 对三类选择都加存在性检查，失效时清空并提示；Timeline 播放头显示位置也夹到 duration | typecheck；逻辑路径单测未覆盖（需 DOM），已人工走查 | 撤销一次「新建遮挡」后按 Delete 弹「编辑命令无法执行」；删除片段后时间码超过总时长、预览空白 |
| P1-3 | `EditorView.tsx:239-251`、`InspectorPanel.tsx`（片段页「在播放头分割」按钮） | `SplitClip` 在播放头位于片段边界/距端点不足 1ms 时 domain 会静默跳过，但仍压入一条空撤销记录（Ctrl+Z「撤销了寂寞」）；界面无提示 | 新增 `Timeline.splittableTick(project,tick)`（与 domain `splitOne` 的 `tick>start && tick<end` + 两侧 ≥1ms 判定一致），两个分割入口都先校验并给出明确 toast | 单测 3 例（内部/边界/距端点 5ms） | 在片段边界按 Ctrl+B：画面/时间线毫无变化，Ctrl+Z 却要按好几次才生效 |
| P1-4 | `Timeline.tsx:289-340`（拖拽）、`EditorView.tsx:610-635`（键盘/输入框移动）、`InspectorPanel.tsx:389-407` | `MoveClip` 不检查同轨重叠（domain `validate` 把重叠判为 error），拖到另一片段上会生成两个叠在一起、TimeMap 只认先出现片段的坏状态 | 新增 `Timeline.planClipMove()`：候选落点 = 原位置/0/其它片段左右边界，选离目标最近且不重叠的位置；拖拽预览就显示夹紧后的位置，松手提交实际落点；被夹紧时 toast「与同轨片段重叠」；键盘移动与属性面板「时间线起点」输入同样走该规划 | 单测 7 例（空位、重叠回退、前进重叠、负目标、零长片段、不存在、速率换算） | 拖动片段到另一段上，时间线上两块重叠，预览显示的却是另一个片段；保存的工程不通过 domain 校验 |
| P1-5 | `Timeline.tsx:227-230`、`442`（旧版 106/476） | 轨道静音用组件本地 `mutedTracks` 镜像，与工程 `track.muted` 两套状态：撤销/重做、属性面板切静音后时间线图标不变 | 删除本地镜像，`muteOf(kind)` 一律从 `project.tracks` 派生；点击仍发 `SetTrackAudio` 命令 | typecheck；人工走查 | 撤销静音后属性面板已恢复，时间线仍显示「已静音」；或反之 |
| P1-6 | `InspectorPanel.tsx:71-142`、`889-1050` | 遮挡四边滑杆各自独立取值，可组合出 `x=0.9,width=0.5`（框一半在画面外）；时间区间滑杆/「结束设为播放头」可生成零长或反向区间。效果永远不生效，但 `confirmed` 仍显示「已遮挡」，与真实几何不一致 | 新增 `clampPrivacyRect()`：宽高 ∈[0.01,1]、x/y 夹到矩形不出画面；新增 `clampEffectRange()`：0≤start<end≤时长、最短 0.2s，所有遮挡时间编辑（开始/结束/结束设为播放头/新建）统一走它；确认按钮在区间非法时拒绝并说明；已确认但区间为空时显示 danger 提示 | 单测 7 例（矩形夹紧、NaN、超宽、越界区间、零长、空工程、摄像头） | 用户把遮挡框拖出画面/把结束时间设到开始之前，面板仍显示「已遮挡」，导出与教程截图却完全没有遮挡 |
| P1-7 | `InspectorPanel.tsx:1280-1310`、`1373-1386`（自定义背景色输入） | 受控输入在 `onChange` 里只接受完整合法 hex：输入 `#1`、`#10` 等中间值不写回，value 立即被旧值覆盖 —— 用户**根本打不出**一个自定义颜色，只能粘贴 | 改成本地草稿 `backgroundDraft` + 聚焦标记：输入期间只改草稿，回车/失焦校验提交；非法值回退并清空草稿，不留下「看起来已生效」的假颜色 | typecheck；人工走查 | 点自定义色输入框逐字符输入 #RRGGBB，光标乱跳、内容打不进去 |
| P1-8 | `InspectorPanel.tsx:108-131`、`316-341` | 裁剪「时长」上限用**工程总时长**：单片段工程里工程时长 == 当前片段长度，永远无法拉长；且源入点+时长可超过素材总时长，引用不存在的媒体区间 | 新增 `clampTrimSource()`：按素材 `durationTicks` 夹紧源入点/时长（素材未知时不限制）；滑杆上限改为「素材剩余长度」，不是工程时长 | 单测 3 例（不超过剩余长度、同时改入点+时长、素材未知） | 只有一个片段的工程里怎么拖都拉不长；拉长超过素材末尾后导出尾部黑屏 |
| P1-9 | `TutorialView.tsx:203-232` | 编辑字段只在「切换步骤」时同步；撤销/重做改变当前步骤数据后，输入框仍显示被撤销的新文案，一失焦又把旧值写回去（撤销失效） | 用 `syncedStepRef` 记录上次同步的 `{id,title,description,imageTick}`：只有切换步骤或工程值真的变化时才回填；用户正在输入（工程值未变）不覆盖 | typecheck；人工走查（撤销路径） | 改完标题按 Ctrl+Z，左侧列表已恢复旧标题，右侧输入框还是新标题；点一下别处又把新标题写回去 |
| P1-10 | `TutorialView.tsx:574-590` | 标题清空后失焦被静默丢弃：输入框显示空，工程里仍是旧标题；标题无长度上限 | 空标题失焦恢复原标题并 toast「标题不能为空」；`maxLength=120` + trim/slice，说明 `maxLength=2000` | typecheck | 清空标题后列表显示「步骤 N 待补充说明」，实际标题没变；超长标题撑坏步骤卡片 |
| P1-11 | `TutorialView.tsx:42-56`、`700-730` | 截图时间只夹到 `[0, duration-1]`，不绑定步骤区间；「开始/结束设为播放头」可写出 `start==end`、`start>end` 的非法步骤（domain 校验判 error，截图也拍到别的步骤） | 新增 `clampImageTickForStep(intended, sourceRange, duration)`：夹到 `[步骤开始, 步骤结束)` 与工程时长；截图输入/取播放头/新建/拆分全部走它；两个区间按钮保证 start<end 并同步夹紧 imageTick | 单测 4 例（区间内、早于开始、越过结束、空工程）；typecheck | 步骤 2 的截图拍到步骤 8 的画面；点「开始设为播放头」后步骤区间变成 0 长，导出/校验出错 |
| P1-12 | `TutorialView.tsx:270-305` | `buildStepDrafts` 生成的 id 带随机后缀，重复点「由标记生成草稿」会为同一标记新增重复步骤；且草稿 `privacyVersion` 被 domain 写死为 0，工程隐私版本 >0 时新步骤立刻显示「截图待更新」 | 按「标记来源步骤的 sourceRange.start」去重（已存在的跳过并提示数量）；写入时用 `project.privacyVersion` 覆盖草稿值 | typecheck；人工走查 | 连点两次生成按钮，步骤列表出现两份一模一样的内容；新建步骤立即标红「截图待更新」 |
| P1-13 | `TutorialView.tsx:315-330` | 空工程 / 播放头在末尾时「新建步骤」会写出 `start==end` 的步骤（domain 校验 error），且 ID 可能同毫秒冲突 | 空工程直接 toast 拒绝；区间按 `start<end` 构造（start 最多 duration-1，end 至少 start+1）；ID 加随机后缀 | typecheck | 空工程点「新建步骤」后出现一个 0 时长步骤，保存/导出报校验错误 |
| P1-14 | `AudioWaveform.tsx:41-150` | 按 CSS 宽度直接建 canvas：长音频片段 × 高倍缩放可到 60 万像素宽，超过浏览器 canvas 上限 → 拿不到 2D 上下文，波形永久空白且占巨量内存；一旦某次读盘失败 `failed=true` 就早退 `return null`，canvas 被卸载，之后 props 变化也永远无法恢复波形 | 新增 `waveformPaintWidth()` 把物理绘制宽度限制在 4096px（CSS 仍铺满，峰值按比例映射）；失败时 canvas 保持挂载（`display:none`）并在每次 props 变化时重置失败状态、重新尝试 | 单测 3 例（普通/超宽/非法宽度） | 放大时间线后长录音的波形整条消失；打开工程瞬间读盘失败一次，该轨道从此永远没有波形 |
| P1-15 | `EditorView.tsx:239-251`、`Timeline.tsx:412` 等 | 分割/删除/移动的界面校验缺失（详见 P1-3/P1-4）；`Ctrl+B`、工具按钮、属性面板按钮行为不一致 | 三处入口统一走 `splittableTick` / `planClipMove` | 见上 | 同一操作在不同入口表现不一致 |

### P2

| # | 文件:行 | 问题 | 修复 |
|---|---|---|---|
| P2-1 | `Timeline.tsx:440-500` | 视频轨 / 运镜 / 遮挡 / 步骤的轨道标签是 `<button>` 但点击无任何行为（title 承诺「点击选中该轨道片段」） | 视频轨选中播放头所在片段（否则第一段）；运镜/遮挡选中播放头命中的效果（否则第一条）；步骤选中播放头所在步骤 |
| P2-2 | `Timeline.tsx:624-636` | 键盘微移硬编码 30fps（Shift 移动 1 帧），与工程实际帧率不符 | 用 `project.settings.fps` 计算帧 tick |
| P2-3 | `Timeline.tsx:694` | tick 超出时长时播放头画到内容区外 | 显示位置夹到 duration |
| P2-4 | `Timeline.tsx:626` | 片段 aria-label 结束时间用 `+sourceDurationTicks`，忽略播放速率 | 改用 `clipEndTick()` |
| P2-5 | `EditorView.tsx:570-576` | 帧号用 `(tick/frameStep).toFixed(0)`，与 domain `ticksToFrameIndex` 的取整规则不一致（30fps 下会差一帧） | 改用 `ticksToFrameIndex` |
| P2-6 | `EditorView.tsx:274-292` | 框选遮挡途中按 Escape 只清选择，临时框仍在，松手仍会创建遮挡 | Escape 时同时 `setDrag({kind:'none'})` |
| P2-7 | `InspectorPanel.tsx:285-300`、`455-462` | 关联组片段被拖动时只移动本轨，摄像头/音频不跟随（domain MoveClip 无联动语义），用户无感知 | 属性面板显示 warn 提示「当前版本移动只作用于本轨，需用分割+波纹删除保持同步」（联动移动见跨范围 C2） |
| P2-8 | `TutorialView.tsx:243-252` | 截图时间提交即使值未变也执行命令 → 多余撤销记录 | 值相等时不提交 |
| P2-9 | `TutorialView.tsx:406-424` | 「同步遮挡版本」对所有步骤执行命令（含已同步的），无变化时也提示成功 | 只处理落后步骤；全部最新时提示「已是最新」 |
| P2-10 | `AudioWaveform.tsx:100-125` | 峰值桶数与物理像素不一致时按 1px 画，可能只覆盖画布左侧一部分 | 按 `paintW/peaks.length` 比例铺满 |
| P2-11 | 本范围六个文件 | `tsc --noUnusedLocals` 未使用导入/变量：`isTextEntryTarget`、`InlineNote`、`Segmented`、`ticksToSeconds`、`duration`（EditorView）、`Icon`、`Spinner`、`ticksToSeconds`（TutorialView）、`TrackKind`、`TICKS_PER_SECOND`（Inspector）、`Effect`、`Track`、`GUTTER_WIDTH`（Timeline） | 全部清理 |
| P2-12 | `PreviewCanvas.tsx` | `devicePixelRatio` 传给 `drawScene` 但 compositor 未使用（接口与实现不一致，cross-range 记录） | 暂保留（不属本范围，media 侧确认） |

---

## 二、新增/修改文件与测试

新增：
- `src/renderer/lib/previewSource.ts`：真实模式预览解码缓存（`PreviewMediaCache` / `usePreviewMedia` / `paintPreviewPlaceholder` / `shouldUseSyntheticPreview`）。只调用 `src/media/decoder` 公开 API，未改 media。
- `tests/renderer/editor-math.test.ts`：35 例，覆盖
  - `Timeline.planClipMove` / `splittableTick` / `clipEndTick`
  - `Inspector.clampPrivacyRect` / `clampEffectRange` / `clampTrimSource` / `clampCameraRect`
  - `PreviewCanvas.sourceRectToDisplayRect` / `displayRectToSourceRect`（含 2× 运镜往返）
  - `AudioWaveform.waveformPaintWidth`
  - `TutorialView.clampImageTickForStep`
  - `previewSource` 的 mock 门禁 / 绝对路径 / 帧缓存键

修改：本报告问题表中的六个组件/视图文件（不含样式与其它范围）。

---

## 三、未修复风险 / 已知限制

1. **真实模式预览未接入指针日志**：编辑器预览不再伪造指针（真实模式 `pointer: null`），因此录制时的指针/点击波纹在预览里不显示；导出会由 `exporterRuntime` 读 pointer log 绘制。预览与导出在「光标层」仍有差异（画面/遮挡/运镜已一致）。后续可将 exporter 的 `makePointerLookup` 抽到共享模块复用。
2. **真实模式解码是异步的**：播放/连续拖动时预览可能落后若干帧（等待期间保留上一帧真实画面或显示中性占位），不是逐帧精确；单帧拖动到未解码位置会短暂显示占位。未做解码预取/缓存多帧。
3. **真实解码失败没有重试按钮**：素材分段缺失/编解码器不可用时画占位并提示，需重新打开工程触发重试。导出可能仍正常（exporter 有分段回溯兜底），预览侧未做逐段回溯。
4. **跨轨联动移动未在 UI 修复**：见 C2，依赖 domain 原子命令，UI 只做提示。
5. **Timeline 拖拽不支持跨轨**（本来就不支持），也没有吸附到其它片段边缘的磁吸（只有 10ms 网格）。
6. **教程步骤排序的持久化缺陷在 domain**：见 C1，UI 侧无法绕过。
7. **真实解码路径未自动化验证**：`verify-ui.cjs` 只跑 mock 模式；建议补一个 native 冒烟脚本（录制→编辑器→比对预览 canvas 与导出首帧的颜色多样性/SSIM）。

---

## 四、跨范围发现（只记录，未修改）

| # | 范围 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| C1 | domain（P1） | `src/domain/commands.ts:534-540`（`SetStep` 里 `next.steps.sort(...)`） | `ReorderSteps` 设置的顺序在下一次 `SetStep`（编辑标题/截图时间）后被按 `sourceRange.start` 重新排序，教程「上移/下移」不持久 | `SetStep` 更新已有步骤时保留原数组位置，或让顺序由显式 order 字段维护；补 domain 测试 |
| C2 | domain（P1） | `src/domain/commands.ts:472-483`（`MoveClip`） | 只移动单个片段，不按 `linkGroupId` 联动（文档 §10.2 要求「删除/重排一起作用」），拖动主视频片段后摄像头/音频轨错位，导出的音画不同步 | 给 `MoveClip` 增加 linkGroup ripple 语义（一条命令原子移动同组片段）；UI 不应自行发多条命令（破坏撤销粒度） |
| C3 | domain（P1） | `project.ts:139-149` vs `Timeline.tsx` / `TutorialView.tsx` / `exporterRuntime.ts:259` | `sourceRange/imageTick` 注释写「源时间，经 TimeMap 映射到成片时间」，但渲染层与导出都把二者直接当**时间线 tick** 使用；裁剪掉片头后（clip.sourceInTicks>0）或波纹删除后，步骤/标记会与画面对位偏移。domain `deleteRange` 又用 `TimeMap.mapTimelineRange` 把步骤当源时间裁断，两套语义矛盾 | 统一语义并在 domain 文档/校验里固定：要么步骤始终存源时间、所有展示/导出经 TimeMap 映射；要么改注释并去掉 deleteRange 里的源时间映射 |
| C4 | domain（P2） | `src/domain/tutorial.ts:64-73` | `buildStepDrafts` 写死 `privacyVersion: 0`，工程隐私版本>0 时新草稿立刻「截图待更新」 | 入参增加 `privacyVersion`，或由调用方覆盖（UI 已覆盖，属兜底） |
| C5 | domain/main（P1） | `src/domain/validate.ts:209` | 生产代码无任何 `validateProject/assertProjectValid` 调用者：主进程保存、导出前都不校验，重叠片段/零长效果/超长步骤等非法工程可被保存 | 主进程 `saveProject` 前跑校验（区分 error/warning），UI 展示结构化问题；至少导出前 assert |
| C6 | ui-core（P2） | `src/renderer/components/ui.tsx:559-590`（`Slider`） | `onPointerUp`/`onKeyUp`/`onBlur` 都可能 commit；极少数时序（组件尚未重渲染时 blur 紧跟 pointerup）会重复执行同一命令 → 两条撤销记录 | commit 前比对最近一次提交值，或在 store 层按命令内容去重 |
| C7 | media（P2） | `src/media/compositor.ts:34` | `DrawOptions.devicePixelRatio` 声明了但实现未使用；`PreviewCanvas` 仍按惯例传入，容易误导 | 要么实现高 DPI 绘制，要么删掉该字段 |
| C8 | timeline/marker（P2） | `src/renderer/components/Timeline.tsx`（marker 渲染） | 标记 `mediaTick` 是录制媒体时间，直接画在时间线轴上；剪掉片头后标记与画面对位偏移（与 C3 同源） | 与 C3 一并统一语义 |

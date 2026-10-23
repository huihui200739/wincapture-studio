# 领域层审计报告（src/domain/**、tests/domain/**）

- 审计角色：domain-auditor（Team 成员）
- 审计日期：2026-10-22
- 基线（审计开始时）：`npx tsc --noEmit -p tsconfig.json` 通过；`npx vitest run` 453/453 全绿；domain 语句覆盖率 90.8%
- 本次范围（独占写入）：`src/domain/**`、`tests/domain/**`
- 范围外一律只记录不修：`src/media/**`、`src/renderer/**`、`electron/**`、`src/shared/**`
- 新增测试：46 条回归/边界用例（分布在 11 个既有测试文件，未新增依赖、未改 package/tsconfig）
- 最终结果：`npx vitest run tests/domain` → **12 文件 / 499 用例全绿**；`npx vitest run` → **28 文件 / 786 用例全绿**；`tsc --noEmit` 通过；`tsc --noEmit --noUnusedLocals` 在 domain 范围内无告警

结论速览：**确认并修复 22 项缺陷（P0 0 / P1 8 / P2 14）**。没有发现会让现有测试断言错误行为的用例；本次**未修改任何既有测试断言**，只新增测试。所有修复都遵循「命令入口拒绝非法输入 → 纯函数保持不变量 → 校验器不抛异常」的边界职责。

---

## 1. 修复清单

优先级口径：P1 = 会产生数据损坏/安全边界缺失/成片错误，且现有测试未覆盖；P2 = 边界精度、健壮性、误导性行为。

### P1

| # | 位置 | 根因 | 修复 | 验证 |
|---|------|------|------|------|
| P1-1 | `commands.ts:307`（`deleteRange` 尾部裁剪分支） | **非 ripple 删除片段头部时把存活内容提前了**：`timelineInTicks` 用 `start`（片段原起点）而不是删除区间右边界 `range.end`，等于把没删掉的内容左移填满删除区。中间挖空分支用的是 `range.end`（正确），两条分支语义不一致；非 ripple 删除本应「保留空隙、内容不动」。 | 改为 `ripple ? range.start : range.end`。ripple 时前移到删除起点，非 ripple 时停在右开边界，音画/字幕不再整体提前。 | `commands.test.ts`「回归：非 ripple 删除片段头部时保持时间线位置」：片段 `[5s,15s)` 删 `[2s,7s)`，断言剩余片段停在 7s、源入点 2s、时长 8s（旧实现停在 5s）。 |
| P1-2 | `commands.ts:452-615`、校验助手 `648-662` | **非法命令参数被静默写入工程**：`MoveClip`/`TrimClip` 的 `NaN` 经 `Math.max(0, NaN)` 变成 `NaN` 时间线位置；`DeleteRange` 负起点让 ripple 把片段移到负时间（`-2s`）；反向区间、`SetFrameRate {0,0}`、`gain: NaN`、`SetEffect/SetStep` 空区间/非有限 tick 全部被接受。这类工程一旦保存，`timelineDuration`、导出计划、缓存键全部变 NaN/Infinity，只有撤销能恢复。 | 新增 `assertFiniteTick` / `assertRange`：所有命令的时间字段必须是有限数，区间起点非负，效果/步骤区间必须 `start < end`（删除区间允许空 `start === end` 作为 no-op）；`SetFrameRate` 要求正有理数；`SetTrackAudio` 的 gain 必须有限；效果/步骤/标记对象缺失也拒绝。统一抛 `E_INVALID_COMMAND`（`detail` 指明字段），不改动任何合法输入。 | `commands.test.ts`「回归：非法命令参数必须被拒绝」3 条：断言 `E_INVALID_COMMAND` 且工程未被修改；空区间删除仍为合法 no-op；`SetFrameRate/SetTrackAudio/SetEffect/SetStep` 非法值被拒。 |
| P1-3 | `commands.ts:564-577`（`ReorderSteps`） | `orderedIds` 含重复 ID 时同一 `TutorialStep` 会被 push 多次，`project.steps` 出现重复 ID 的副本；后续 `SetStep` 只更新第一条、删除/导出步骤数量错乱，且 `validate` 之前不检查步骤 ID 重复。 | 按 `orderedIds` 顺序去重（`seen` 集合），diff.entities 也只记录去重后的 ID；未列出的步骤仍追加在后。 | `commands.test.ts`「回归：ReorderSteps 去重」：`['s2','s2','s1']` 结果必须只有 `['s2','s1']`。 |
| P1-4 | `validate.ts:251-279`、`341`、`425-465`、`579`、`683`、`743`、`792` | **校验器对损坏工程会抛 TypeError，违反「返回结构化错误列表、不短路」的契约**：`tracks: undefined` 时 `timelineDuration → findTrack → tracks.find` 直接抛；`assets: {}` 时 `for...of` 抛「not iterable」；`clips` 非数组、数组里空条目同理。导入损坏 `project.json` 时上层拿不到可展示的错误。 | 新增 `requireCollection`（assets/tracks/effects/steps/variants/markers 必须为数组，否则报 `schema-unsupported` 并按空集合继续校验）与 `pushStructure`（实体空条目、`clips` 非数组逐项报错）；`timelineDuration`/`findTrack`/`findAsset`/`findVariant` 同时做数组与有限值防御（见 P2-11）。错误码沿用既有 `schema-unsupported`，未新增 `ValidationCode`。 | `validate.test.ts`「回归：损坏的工程结构返回结构化错误而不是抛 TypeError」2 条：7 种损坏形态全部 `ok=false` 且不抛；`clips` 非数组报 `schema-unsupported`。 |
| P1-5 | `validate.ts:139-159`（`checkProjectRelativePath`） | **路径穿越校验可被 Windows 归一化绕过**（§13.1/T11 安全要求）：Windows 会忽略段尾的点/空格，`a/.. /b` 等价于 `a/../b`（`.. ` 不等于 `..` 而漏过）、`con. ` 等价 `con`；NTFS 备用数据流 `media/a.mp4:evil` 也未被拒绝。ZIP 解包/工程包导入可将素材路径指到工程外。 | 每段先删除尾随 `[. ]+` 再判定：归一化后 `..` 拒绝、归一化后为空（纯点/空格，`.` 除外）拒绝、保留名按归一化值判定；任何段含 `:` 一律拒绝（盘符已在前面拦截，其余即 ADS）。合法路径（`.hidden`、`a.b.mp4`、`./media/a.mp4`）行为不变。 | `validate.test.ts`「回归：路径校验的 Windows 归一化绕过」3 条：6 种尾随/保留名形态 + ADS 全部 `asset-path-traversal`；3 种合法路径仍通过。 |
| P1-6 | `tutorial.ts:39-68`（`usableDuration/safeDelay/stepWindow`）、`77`、`115`、`130-140` | 步骤草稿生成不夹紧时间域：标记恰在录制终点 `duration` 时得到空区间 `[duration,duration)` 且 `imageTick=duration-1` 落在区间外（不可截图、`validate` 判错）；`duration=0` 时 `imageTick = -1`；负的 `screenshotDelayTicks` 产生反向区间；越界点击（`tick<0` 或 `>=duration`）生成负起点/反向区间。 | 统一 `stepWindow`：起点夹到 `[0, duration-1]`、终点 `min(duration, max(start+1, start+delay*2))`、`imageTick` 落在 `[start,end)`；`duration <= 0` 不生成步骤；负延迟夹到 0；点击事件过滤 `[0, duration)`；合并步骤时同样夹紧并保证非空。 | `tutorial.test.ts`「回归：buildStepDrafts 的时间边界」5 条：终点标记合法、零/负时长 0 步骤、越界点击被过滤且末尾点击合法、负延迟合法、合并后仍合法。 |
| P1-7 | `scene.ts:216-224`（光标求值） | `evaluateScene` 取**第一个** cursor effect（`find`）而不看 `effect.range`：一段 `[0,5s)` 的 `burnedIn` 设置会让整段视频都不再叠加后期光标；`visible/size/clickRipple` 同理在区间外继续生效。与 `validate` 把 `effect.range` 当作用区间的语义矛盾。 | 只在 `tick ∈ [range.start, range.end)` 的 cursor effect 生效；区间外回落到默认参数（不烧录、可见性由指针决定、默认尺寸）。 | `scene.test.ts`「回归：光标效果受时间区间约束」：区间内 `burnedIn → cursor.visible=false / size=30`，区间外 `visible=true / size=26`。 |
| P1-8 | `migration.ts:107-125`（未来版本只读分支） | 未来版本读取**原样浅拷贝**直接返回（注释却声称「规整为非空结构以便界面渲染」）：缺少 `tracks/assets/settings/variants` 的未来工程会让渲染层访问数组/`.fps` 时崩溃；`schemaVersion` 语义也不保证。 | 只读分支返回 `{ ...source, ...normalizeProject(source, fromVersion) }`：已知字段全部规整为当前结构、`schemaVersion` 保持未来版本号（避免后续写入被误判可覆盖），同时保留未来版本新增的未知顶层字段（不丢数据）。 | `migration.test.ts`「回归：未来版本只读读取的结构规整」2 条：缺字段时补 4 条轨道/空集合/默认设置，版本号保持 `+1`，`futureFeature` 保留；同输入两次读取相等。 |
| P1-9 | `zoom.ts:318-353`（`evaluateZoom`） | 重叠运镜「取最强」实现错误且**依赖 effects 数组顺序**：用 `p.scale > scale`（原始目标倍数 vs 当前已缓动值）判断，强镜头仍在缓入（k≈0）时会被后出现的弱镜头覆盖；而 `SetEffect` 追加/`deleteRange` 排序都会改变数组顺序，导致「只删了一个无关效果，画面运镜却变了」，预览与导出也随数组顺序漂移。 | 逐镜头计算「当前有效倍数」`1+(target-1)*k`，取最大者；相同值按 effect.id 稳定决胜。不叠加、顺序无关、同输入同输出。 | `zoom.test.ts`「回归：evaluateZoom 取当前有效放大值最大者」2 条：强 2.4/缓入 2s + 弱 1.5/缓入 1s 在 t=0.5s 两种顺序都得 1.25 且焦点一致；同倍数不同焦点两种顺序结果相等。 |

### P2

| # | 位置 | 问题 | 修复 | 验证 |
|---|------|------|------|------|
| P2-1 | `zoom.ts:206-215`（`planAutoZoom` 合并分支） | 与前一个自动镜头过近时把 `prev.range.end` 延长了，但**没有同步 `lastEnd`**。后续镜头仍按旧结束时间判断 `minGapTicks`，会生成相互重叠的自动运镜（设计上应「太近的合并/顺延」）。 | 延长 `prev` 后同步 `lastEnd = prev.range.end`。 | `zoom.test.ts`「回归：planAutoZoom 不产生相互重叠的镜头」：10s/11s/12.7s 三次点击生成的所有镜头区间两两不重叠。 |
| P2-2 | `timeMap.ts:57-124`（`toSource`/`toTimeline`/`mapSourceRange`/`mapTimelineRange`） | 变速片段在整数 tick 上取整会**越出片段右开边界**：0.5 倍速、源时长 3tick 时 `toSource(5)` 返回 `sourceTick=3`（= `source.end`）；3 倍速时 `toTimeline` 可返回 `timeline.end`；`mapSourceRange`/`mapTimelineRange` 在源区间被变速压缩成 0 长度时输出 `{start:end}` 空区间，违反映射结果非空契约。 | `toSource` 夹到 `[source.start, source.end-1]`、`toTimeline` 夹到 `[timeline.start, timeline.end-1]`；两个 map 函数丢弃零长度映射结果。 | `timeMap.test.ts`「回归：变速映射的取整边界」3 条：越界夹紧、零长度映射为空、穷举 1tick 区间全非空。 |
| P2-3 | `timebase.ts:132`（`makeRational`） | 分子分母是小数时 **可能返回 `den = 0` 的非法有理数**：gcd 用舍入后的值、分子用原始值，`makeRational(0.5, 0.25)` → `{num:1, den:0}`，后续除零得到 Infinity/NaN（与「非法有理数抛错」的契约矛盾）。 | 先对分子分母取整，用同一组整数算 gcd 与结果；分母舍入后为 0 时抛错。 | `timebase.test.ts`「回归：makeRational 不得返回 den=0」2 条：小数分母抛错；负分母仍正确约分。 |
| P2-4 | `timebase.ts:190`（`ticksToFrameCount`） | 非法时长/帧率返回 `NaN` 总帧数：`duration=NaN` 时 `ceil(NaN)=NaN`，导出计划 JSON 序列化后变 `null`，帧循环与进度失效。 | 非有限/非正时长或非法 fps 直接返回 0。 | `timebase.test.ts`「回归：ticksToFrameCount 对非法输入返回 0」。 |
| P2-5 | `validate.ts:205-210`（`rangesOverlap`） | 空区间 `{5,5}` 与包含它的大区间被判为「重叠」（`5<10 && 0<5`），与 `rangeIntersects`/`rangeIntersection`（显式排除空区间）及文档语义不一致。 | 先 `rangeIsEmpty` 判定，空区间不与任何区间重叠。 | `validate.test.ts`「回归：rangesOverlap 空区间不与任何区间重叠」。 |
| P2-6 | `recovery.ts:109`、`253-262` | `endedDuringPause` 把「最后事件是 `segment-begin`」也算成暂停中崩溃，摘要错误提示「恢复后不补计时」；把崩溃键写成最后一个事件而不是「最后一条 pause 是否有对应 resume」。 | 新增 `crashOccurredDuringPause`：从后往前只认 `pause`/`resume`，忽略 `segment-begin`/`heartbeat` 等。 | `recovery.test.ts`「回归：endedDuringPause 只看 pause/resume」3 条：最后是 begin → false；pause 后仅 heartbeat → true；pause+resume → false。 |
| P2-7 | `recovery.ts:137-146` | 段记录清单里同一路径出现两次时**两条都进入已提交清单**（清单合并/日志重放可产生），`toMediaRefs` 会生成两份相同素材引用、重复解码。 | 按路径去重：重复记录进入 `discarded` 并注明原因。 | `recovery.test.ts`「回归：重复的段记录不会重复进入已提交清单」。 |
| P2-8 | `validate.ts:421-443`、`576`、`680`、`740`、`789` | `id-duplicate` 只覆盖素材/片段，**效果/步骤/画幅/标记/轨道 ID 重复不报错**：`SetEffect` 只更新第一条、`DeleteEffect` 删除同名全部，出现「编辑不生效/误删」而校验通过。 | 为每类实体建立 ID 集合并报 `id-duplicate`（复用既有错误码，不新增 code）。 | `validate.test.ts`「回归：重复 ID 检测覆盖效果/步骤/画幅/标记」。 |
| P2-9 | `scene.ts:153-171`、`277` | `FrameScene.padding` 返回未夹紧的 `canvas.padding`，而 `screenRect`（`box`）用的是夹紧到 `[0,0.4]` 的值：`padding=0.6` 时场景报告 0.6、实际布局按 0.4，渲染层若用 `scene.padding` 排布阴影/圆角会错位。 | `variantLayout` 返回夹紧后的 `padding`，场景统一使用。 | `scene.test.ts`「回归：scene.padding 与 screenRect 使用同一夹紧值」。 |
| P2-10 | `project.ts:274-330` | 纯函数在「结构被外部 JSON 破坏」时直接抛错：`variants=[]` 时 `activeVariant` 返回 `undefined`，`evaluateScene`/`buildExportPlan` 读 `.aspect` 崩溃；主轨片段 `rate.num=0` 时 `timelineDuration` 返回 `Infinity`，导出计划时长/帧数被污染。 | `findTrack/findAsset/findVariant` 数组防御；`activeVariant` 兜底 16:9 常量画幅；`timelineDuration` 跳过非有限/非法速率的片段并夹到 `>= 0`。 | `scene.test.ts`「回归：空画幅时预览求值不抛异常」；`exportPlan.test.ts`「回归：非法片段速率不污染导出计划」。 |
| P2-11 | `sessionClock.ts:56-66`、`128-150` 等 | QPC 入参为 `NaN/Infinity` 会污染状态：`setZero(NaN)` 永久把零点写成 NaN（之后媒体时间/时长全 NaN）；`pause(NaN)` 让 `paused` 为真但媒体时间继续前进；`mediaTickAt(NaN)` 返回 NaN。另外 `resume(t)` 在 `t < pausedAt`（QPC 回跳/日志乱序）时会静默丢弃这段暂停，媒体时间凭空前进。 | 所有 QPC 入参经 `finiteRounded` 规整：非法值视为「本次调用无效果」（setZero/pause/resume/stop 不写状态，查询返回 0/false/null）；`resume` 早于暂停时刻时返回 false 并保持暂停。 | `sessionClock.test.ts`「回归：非法 QPC 时刻与倒序恢复」6 条。 |
| P2-12 | `exportPlan.ts:139`、`256` | `frameTickAt(plan, NaN)` 返回 NaN（`Math.max(0, NaN)`）；输出时长之外的片段（如摄像头轨比主轨长）产生 `frameStart > totalFrames` 的「未来帧」区间，消费方若按帧区间解码会越界。 | 非有限帧序号返回 0；`segments` 的 `frameStart/frameEnd` 统一夹到 `[0, totalFrames]`。 | `exportPlan.test.ts`「回归：输出时长之外的片段帧区间被夹紧」「frameTickAt 对 NaN/Infinity 返回 0」。 |
| P2-13 | `migration.ts:274-278` | `updatedAt` 只判 `typeof === 'number'`，`NaN` 会被保留。 | 追加 `Number.isFinite`。 | 随 P1-8 的 migration 测试覆盖（读取结构规整路径）。 |
| P2-14 | `scene.ts:16`、`tutorial.ts:11` | 已确认的 `--noUnusedLocals` 告警：`scene.ts` 重复 import 的 `TimeMap` 类型、`tutorial.ts` 的 `TickRange`。核对无遗漏逻辑线索（`TimeMap` 实际由 `TimeMapClass` 使用；`TickRange` 在 tutorial 内确无用途），直接删除。 | 删除两个未使用导入，domain 范围 `tsc --noUnusedLocals` 零告警。 | `tsc --noEmit --noUnusedLocals` 过滤 `src/domain|tests/domain` 无输出。 |

---

## 2. 公共行为/契约变更（供集成核对）

类型层面无常变；以下**运行时行为**有变化，均属于"修正旧行为"，本报告显著标注：

1. `applyCommand` 对非法参数抛 `E_INVALID_COMMAND`（旧：静默 clamp 或写入 NaN）：
   - `SplitClip/TrimClip/MoveClip` 的时间字段必须有限；
   - `DeleteRange` 拒绝负起点与 `start > end`（`start === end` 仍合法）；
   - `SetFrameRate` 必须是正有理数（`num/den > 0` 且有限）；
   - `SetTrackAudio.gain` 必须有限；
   - `SetEffect.range`、`SetStep.sourceRange` 必须 `start < end` 且起点非负；
   - `SetMarker.mediaTick` 必须有限且非负。
   - 生产调用点（renderer 的 `InspectorPanel`/`EditorView`/`TutorialView`）均先用 `clampEffectRange`/`clampTrimSource`/时间线拖动计算夹紧时间，本次新增拒绝不会命中合法路径；若其它 agent 的界面改动传入空效果区间/NaN，会从"静默接受"变成可见错误提示。
2. `DeleteRange(ripple=false)` 删除片段头部时，剩余片段停在 `range.end`（旧：停在片段原起点，内容提前）。
3. `evaluateZoom` 重叠镜头改为「取当前有效倍数最大者、顺序无关」；`planAutoZoom` 不再产出重叠镜头（旧可能重叠）。
4. `evaluateScene` 的 cursor effect 只在自身区间内生效（旧：忽略区间，取第一个）。
5. `scene.padding` 变为夹紧值（旧：原始值）。
6. `TimeMap` 映射结果保证落在片段内部/非空（旧：可能等于右端点或零长度）。
7. `validateProject` 对损坏结构返回 `schema-unsupported` 错误而不抛异常；重复 effect/step/variant/marker/track ID 新增 `id-duplicate` error。
8. `readProject` 未来版本只读返回规整后的结构（旧：原样浅拷贝）。
9. `SessionClock` 非法 QPC 入参不再写状态/不再返回 NaN；倒序 `resume` 被忽略。
10. `makeRational` 小数输入分母舍入为 0 时抛错（旧：返回 `den=0` 的非法值）；`ticksToFrameCount` 非法输入返回 0（旧：NaN）。
11. `timelineDuration` 遇到非法速率片段时跳过（旧：可能 Infinity/NaN）；`activeVariant` 在空 variants 时返回兜底 16:9（旧：undefined）。
12. `exportPlan` 的 `segments[].frameStart/frameEnd` 夹到 `[0,totalFrames]`；`frameTickAt` 非有限帧序号返回 0。

**既有测试未修改**：本次没有发现现有断言错误（包括 `tutorial.test.ts` 里「imageTick 不超过录制时长−1」这条——它在终点标记场景下仍成立，但旧实现同时产生了空 `sourceRange`，本次新增用例补上了这个盲区）。

---

## 3. 验证方式与结果

```text
npx tsc --noEmit -p tsconfig.json                       → 通过（exit 0）
npx tsc --noEmit -p tsconfig.json --noUnusedLocals      → src/domain|tests/domain 无告警
npx vitest run tests/domain                             → 12 files / 499 tests passed
npx vitest run                                          → 28 files / 786 tests passed（并行 agent 改动期间实测）
```

新增 46 条测试的分布：commands +5、tutorial +5、zoom +3、scene +3、validate +8、migration +2、recovery +4、timebase +3、timeMap +4、sessionClock +6、exportPlan +3。全部为「在旧实现上会失败、在修复后通过」的回归用例（逐条在旧代码上跑过探针确认过失败形态；探针文件已删除，未留在仓库）。

---

## 4. 未修复风险（记录，供后续排期）

1. **`TrimClipCommand.ripple` 字段声明但未实现**：裁剪不联动关联轨、不移动后方片段。类型上暴露该字段会让调用方误以为支持 ripple 裁剪。需要产品确认裁剪语义（是否 ripple、是否随 linkGroup 同步）后再实现，避免擅自改变现有单片段裁剪行为。P2。
2. **`MoveClip` 不移动 `linkGroupId` 关联轨**：`project.ts` 注释称关联组「删除/重排一起作用」，但 `MoveClip` 只移动命中片段；拖动主轨片段后摄像头/麦克风不跟随，音画偏移。UI 目前按单片段拖拽提交命令，属于产品语义待确认项，未擅自改为整组移动。P2。
3. **`scene.CameraScene.privacy` 永远为空**：`PrivacyAnchor` 只有 `screen|window|keyframe`，没有摄像头锚点；`cameraPrivacy` 数组是死代码。摄像头遮挡能力（§11.2「屏幕遮挡不自动保护摄像头」隐含需要）当前无法表达，需要扩展 schema。P2。
4. **`FrameScene.cacheKey` 不含 pointer/cursor 状态**：`evaluateScene` 接收 `pointer` 并将其写入 `cursor`，但缓存键只有 revision/privacyVersion/tick/尺寸/画幅。若上层把该 key 用于「光标帧」缓存，同一 tick 不同指针位置会误复用。目前缓存未在 domain 内实现，风险取决于消费方。P2。
5. **`CommandHistory` 保存的是工程引用而非快照**：`execute` 的 `before` 是传入对象引用、`after` 是返回对象引用；注释称「命令执行前的工程快照」。若外部对传入/返回的 project 做原地修改，undo/redo 内容会被污染。当前所有生产调用都以不可变方式替换工程，故未改为深拷贝（避免 200× 历史条目内存翻倍）。P2。
6. **`IdempotentCommandRunner` 缓存无上限**：长会话/大量粘贴类命令会持续增长内存；且同一 `command.id` 用于不同工程时返回首次结果（已有测试固化为「幂等优先」设计），属于取舍而非缺陷。P2。
7. **`step.imageTick` 的时间域不统一**：`project.ts` 注释称 imageTick 是「成片时间点」，但 `tutorial.buildStepDrafts` 用录制媒体时间填它、`deleteRange` 按源区间裁剪它、`validate` 只和工程时长比较。1 倍速且未剪辑时两者重合，一旦有变速/波纹剪辑就会错位。统一时间域需要改动 schema 语义（新增 sourceImageTick 或强制映射），跨 renderer 使用点，未在本次范围内改。P2。
8. **`validate.ts` 未接入生产读写路径**：全仓只有测试调用 `validateProject/assertProjectValid`；`electron/projectStore` 已改用 `migration.parseProjectJson`（另一 agent 修复），但保存前没有跑校验，路径安全/重叠/重复 ID 等规则目前不会在真实保存时生效。跨范围（electron），见 §5。P2。
9. **枚举值未校验**：`track.kind`、`effect.kind`、`step.source` 出现未知值时校验器不报错，渲染层会静默忽略该实体；`ValidationCode` 未新增对应 code（保持错误码稳定）。P2。
10. **`SessionClock.stop` 不遵守 `maxPauseRanges`**：`resume` 路径有容量保护，`stop` 闭合当前暂停时直接 push，长时间运行 + 频繁暂停后暂停表可超过上限。P2。
11. **`recovery` 只估算尾部损失**：中间段缺失（`discarded` 在已提交序列中间）不会计入 `estimatedLossTicks`/`lossRange`；`rebuildPauseRanges` 也不对重复 `seq` 去重（`rebuildFromJournal` 有）。P2。
12. **`MIGRATIONS` 只有 0→1**：新增 schema 版本时必须同时补迁移器，否则打开旧工程抛 `E_PROJECT_CORRUPT`（已有明确错误，非静默）。P2。
13. **`Project.timelineDuration` 只按主视频轨计算**：主轨为空而摄像头/音频有内容时导出 0 帧（设计如此，记录以免误改）。P2。

---

## 5. 跨范围发现（只记录不修）

1. **教程截图使用 `step.imageTick` 直接当作时间线 tick**：`src/renderer/exporterRuntime.ts:323`（`const tick = Math.max(0, step.imageTick...)` 后直接 `evaluateScene(project, tick)`）以及 `TutorialView.tsx` 的截图/时间显示；而 domain 的 `buildStepDrafts` 用录制媒体时间生成 `imageTick`。剪辑（波纹/裁剪/变速）后时间线 ≠ 源时间，教程截图会取到错误画面。domain 已有 `mapStepsToTimeline`，但没有映射 `imageTick` 的函数，接线上也没用它（渲染层直接用了步骤数组）。需要 ui-editor/media 侧统一。
2. **`validate.ts` 未接入保存/打开路径**：`electron/projectStore.ts` 现在读取走 `parseProjectJson`（迁移+规整），但 `validateProject` 全仓无生产调用；路径安全、同轨重叠、重复 ID 等规则不会在真实保存时阻止坏工程落盘。建议 main-ipc 侧在 `save`/`open` 后调用 `assertProjectValid`（注意先修 P2-8 的重复 ID 规则再启用）。
3. **`recovery.ts` 整体未接线**：`rebuildFromJournal`/`rebuildPauseRanges`/`toMediaRefs` 只被 `tests/domain/recovery.test.ts` 使用；`electron/capture` 只用了 `SessionClock`，没有用恢复模块做崩溃后的段重建。强退恢复能力（§15.1）在真实主进程路径上未生效，录制的 journal 写入/扫描侧需要 capture/main 审计确认。
4. **`zoom.planAutoZoom`/`regenerateAutoZoom` 未被任何生产代码使用**：自动运镜规划器只有测试在跑；若 UI 侧另有独立自动运镜实现，存在双实现漂移风险（需 ui-editor 审计确认）。
5. **`scene.stepAt`/`tutorial.mapStepsToTimeline` 未被生产代码使用**：编辑器联动高亮/步骤映射目前由渲染层自行实现。
6. **`Timeline.tsx` 依赖「预览按 TimeMap 取先出现的片段」的行为**：本报告 P2-2 修改了 `toSource` 的取整夹紧，不影响 1 倍速；若后续支持同轨重叠片段（当前校验报错），需重新审视 `clipsAt` 与 `TimeMap` 的命中策略。

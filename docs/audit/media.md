# src/media 审计与修复报告（媒体管线）

- 审计范围（独占写入）：`src/media/**`、新建 `tests/media/**`
- 基线（Lead 实测）：typecheck 通过、453 测试全绿、domain 覆盖率 90.8%
- 本次结果：**typecheck 通过（exit 0）**、全量 **786 测试 / 28 文件全绿**（其中新增 `tests/media` 65 个测试）
- 运行时约束：只跑 `npx tsc --noEmit -p tsconfig.json` 与 `npx vitest run`，未运行 build / electron / verify:*
- 测试策略：`vitest` 为 node 环境、无 DOM。`src/media` 的浏览器 API 依赖通过「可注入替身」测试：伪造 `OffscreenCanvas`/2D 上下文（记录绘制调用）、伪造 mediabunny `Input/VideoSampleSink/AudioBufferSink`、伪造 `Output/AudioBufferSource/OfflineAudioContext`、伪造文件 IO 与校验器；未引入 jsdom 等新依赖，未改 package.json/tsconfig。

---

## 1. 已修复问题

级别定义：P0 = 数据错误/静默产出坏文件；P1 = 资源泄漏、恢复能力失效、错误路径不干净；P2 = 行为偏差/健壮性/可观测性。

| # | 级别 | 位置 | 问题（根因） | 修复 | 验证（新增测试） | 真实导出中的表现 |
|---|------|------|--------------|------|------------------|------------------|
| 1 | **P1** | `exporter.ts:769`、`:950` | `.partial` 的清理条件只看「写成功后置位」的 `partialWritten`。`io.writeFile` 写盘失败（磁盘满、IPC 中断）时文件可能已经写了一部分，但标记仍为 false → `cleanupPartial()` 直接 return，几 GB 残片永久留在输出目录。 | 写之前先置 `partialWriteAttempted = true`，清理条件改为「尝试过写 或 已写成」；成功改名（`renamed`）后不再清理。 | `exporter.test.ts`：ENOSPC 写失败 / EACCES 写失败两条用例断言 `removeFile(partial)` 被调用且残片不存在。 | 磁盘写满导出失败后，目录里留下 `影片.mp4.partial`；它继续占用磁盘，导致按提示「清理磁盘后重试」仍然空间不足；换个文件名重试时残片永久残留。 |
| 2 | **P1** | `exporter.ts:447`、`:500`、`:570` | 音频解码失败被静默吞掉：`decodeInterval` 的 `catch { return null }`、缺失 provider 的 `continue`。导出继续写静音采样，结果 `ok=true`、校验通过。 | `TimelineAudioMixer` 增加 `warnings` 与去重 `warnOnce`：音频 provider 缺失、`getAudioAt` 抛错都写入 `result.warnings`；`exportProject` 把 `warnings` 传给混音器。 | `exporter.test.ts`：解码抛错 / 素材缺失两条用例断言导出仍成功但 warnings 含明确原因。 | 用户录了 1 小时讲解，导出「成功」，成片全程无声，界面没有任何提示（只能自己听出来）。修后至少返回明确告警（界面透传问题见 §4-5）。 |
| 3 | **P1** | `exporter.ts:1031` | 失败/取消的终态进度 `framesDone` 硬编码为 0，且渲染循环里的 `framesDone` 是块内变量，catch 拿不到。 | `framesDone` 提升到 try 外；终态事件带真实已渲染帧数。 | `exporter.test.ts`：ENOSPC 失败用例断言终态 `phase=failed, framesDone=30`；取消用例断言 `0 < framesDone < 30`。 | 长视频导出在 90% 处失败，进度面板显示「已完成 0 帧」，用户误以为什么都没做；取消时同样显示 0，无法判断能否续做。 |
| 4 | **P1** | `encode.ts:267`、`:301`、`:317` | `SegmentEncoder.finalize()` 抛错（GPU 重置/编码器被杀/内存不足）时 `Output` 与硬件 `VideoEncoder`、1080p 画布都不释放；`abort()` 只 `output.cancel()`，不释放画布引用；`dispose()` 与自身注释相反，没有断开 canvas 引用、也没归还后备存储。 | `finalize()` 成功/失败都在 `finally` 里 `dispose()`（用 `finalized` 标志避免对已结束的 Output 再 cancel）；`abort() = dispose()`；`dispose()` 断开 output/source/audioContext/canvas 并把画布尺寸置零；重复 `init()` 直接报错（避免创建第二个 Output）。 | `encode.test.ts`：finalize 失败断言 cancel 1 次且全部引用断开、画布归还；成功断言不重复 cancel；abort 幂等；重复 init 报错。 | 录制中偶发一段编码失败后，后续每段都失败/变慢（硬件编码会话未归还）；40 秒以上录制内存线性上涨（与文件头注释里的历史现象同源），直到进程被 GC。 |
| 5 | **P1** | `decoder.ts:445`、`:677` | `getFrameAt` 只在 `ensureOpen` 失败时回溯；段内解码抛错（损坏段、解码器异常）会直接冒泡，整次导出失败。这与「分段自包含、任一段损坏不影响其他段」（§9.5）的设计相反，且函数注释声称会回溯。 | 每段解码包 try/catch：异常时 `markSegmentFailed()`（加入 failed 集合 + 释放该段的解码器/文件句柄）并继续回溯到更早的段；后续请求不再重试坏段。 | `decoder.test.ts`：段 b 解码抛错时返回段 a 的末帧、b 只创建一次 Input、b 的资源已释放；后续取帧不再访问 b。 | 崩溃恢复后有一段 MP4 损坏，导出直接失败并提示「导出失败，请重试」；正确行为是那 2 秒用上一帧兜底、其余正常导出。 |
| 6 | **P1** | `decoder.ts:362` | `open()` 的预热是 `await this.ensureOpen(0).catch(() => undefined)`：素材文件整体缺失/损坏被吞掉，`open()` 成功返回。之后每帧 `getFrameAt` 返回 null，导出器把它当「无源帧」画占位。 | 预热改为成功才 break、失败记录并继续探测（上限 5 段）；所有探测段都打不开时抛 `E_MEDIA_MISSING`（首段损坏但后续可开会继续）。 | `decoder.test.ts`：全部段打不开 → `E_MEDIA_MISSING`；首段打不开、第二段可开 → open 成功且能取尺寸。 | 工程素材被移动/删除后导出「成功」，成片是纯背景+暗色占位块，用户以为渲染 bug；现在会在导出前报「素材缺失」。 |
| 7 | **P1** | `decoder.ts:346` | `ensureOpen` 无并发保护：同段并发调用会各建一个 mediabunny `Input`，后写入 `entries` 的覆盖前一个，被覆盖者永远拿不到 `dispose()`（文件/解码器句柄泄漏）。 | 增加 `opening` 单飞表：同段并发打开复用同一 Promise，结束后移除。 | `decoder.test.ts`：两个并发 `getSizeAt` 同一段，`Input` 只创建 1 次。 | 并发预览/导出（或多处同时请求同一素材）时解码器与内存缓慢增长；Windows 下偶发「文件被占用」导致重命名/删除素材失败。 |
| 8 | **P2** | `decoder.ts:701` | `disposeEntry` 只把 `audioCursor` 置 null，从不 `return()` 挂起的音频异步生成器；LRU 驱逐/关闭后生成器仍持有 mediabunny 解码器引用直到 GC。 | 关闭/驱逐时调用 `iter.return()` 并吞掉异常。 | `decoder.test.ts`：关闭时归还迭代器；maxOpen=1 驱逐时也归还。 | 长时间导出（分段多、LRU 反复换段）时解码器上下文累积，内存与句柄缓慢上涨。 |
| 9 | **P2** | `decoder.ts:938` | `openFrameSources` 中途某个素材打开失败时，已打开的 `VideoFrameSource` 不关闭。 | try/catch：失败时先 `close()` 已打开的所有源再抛出。 | `decoder.test.ts`：第二个素材失败时第一个源的 Input 已 dispose。 | 批量打开素材失败后，已打开的段解码器/句柄残留，重试时资源叠加。 |
| 10 | **P2** | `encode.ts:241` | `addAudio(data, timestampUs, sampleRate)` 完全忽略时间戳（`void timestampUs`），注释假设「音频总是从段首开始」。若调用方传入 0.2s 处音频/有空洞的包，会被当作段首拼接，音画错位且没有任何报错。 | 按 `startTimestampUs` 归一化 `relStartUs`，与 `commitVideoFrame` 语义一致；与已写音频结束位置比较，空洞显式补静音 buffer；非法采样率报错；批间不倒退。 | `encode.test.ts`：连续写入不补、0.1s 空洞补 4320 采样、startTimestampUs 归一化、采样率非法校验、空批忽略。 | 目前录制路径恰好每段都从 0 开始，所以尚未暴露；一旦音频工作进程某个包丢失/延迟，就会整段声音提前并逐段累计漂移（§16.2 的 80ms 上限）。 |
| 11 | **P2** | `encode.ts:493`、`exporter.ts:1039` | `ContinuousMuxer` 无 `dispose()`，只 `finalize/cancel`；隐藏导出窗口常驻时，每次导出的硬件编码器、AAC 编码器与 1080p 画布等 GC 才归还。 | 新增 `dispose()`（未结束则 cancel、画布置零、断引用）；`exportProject` 的 `finally` 调用。 | `encode.test.ts`：finalize 后 dispose 归还画布且不重复 cancel；未 finalize 则 cancel；finalize 抛错后 dispose 仍取消。 | 同一窗口连续导出多次后，第二次起编码变慢/偶发「无法创建编码器」，内存占用阶梯上升。 |
| 12 | **P2** | `compositor.ts:65`、`:96` | 渐变端点把 CSS 方向向量写成 `(sinθ, +cosθ)`，实际 CSS 是 `(sinθ, −cosθ)`：所有角度相对背景样块**上下翻转**；渐变线长度用 `max(W,H)` 也不符合 CSS 的 `|W·sinθ| + |H·cosθ|`。 | 抽出 `cssLinearGradientGeometry()`，按 CSS 角度定义与渐变线长度计算端点；`parseBackground` 调用它。 | `compositor.test.ts`：180deg 顶→底、0deg 底→顶、90deg 左→右、150deg 指向右下且长度等于 CSS 公式；drawScene 的 `createLinearGradient` 端点/色标断言。 | 背景选「深色渐变」时，属性面板样块是左上亮、右下暗，预览/导出却是左下亮、右上暗——所见非所得（§11.5）。 |
| 13 | **P2** | `compositor.ts:258` | 摄像头画中画只认 `videoWidth`/`width` 判断源尺寸；`VideoFrame` 暴露的是 `displayWidth/displayHeight`（没有 width 属性），会被算成 0×0 而直接不画。 | 尺寸探测改为 `displayWidth ?? videoWidth ?? width`（高度同理）。 | `compositor.test.ts`：摄像头资源只给 `displayWidth/displayHeight` 时仍按 cover 绘制。 | 一旦调用方改为直接传 `VideoFrame`（WebCodecs 解码的自然产物）或验证脚本注入 VideoFrame，摄像头画中画变成纯黑圆角块，没有任何报错。 |
| 14 | **P2** | `compositor.ts:130`（原 `:88` 死代码） | `drawSourcePrivacy` 声明后从未被读取；`drawScene` 内另有一份实现了运镜映射的内联遮挡绘制。两份逻辑语义不同（死代码版忽略运镜），属于历史实现残留。 | 删除死代码，把内联逻辑抽成唯一入口 `drawScreenPrivacy()` + `mapSourceRectToScreen()`，预览/导出/教程截图仍全部经过该入口。 | `compositor.test.ts`：遮挡映射（含运镜/留边）、三种样式各自产生绘制、零尺寸跳过、未确认遮挡不绘制、drawScene 下按运镜映射到正确像素。 | 结论：**不是隐私遮罩缺失**。遮挡一直生效；风险在于两份实现漂移，未来改样式可能只改到死代码。清理后消除该风险。 |
| 15 | **P2** | `exporter.ts:805`、`:1069` | 磁盘空间预估写死 12Mbps 视频 + 192kbps 音频，不看导出 profile。 | `estimateOutputBytes(plan, { videoBitrate, audioBitrate })` 支持真实码率；`exportProject` 用 profile 的值。 | `exporter.test.ts`：4Mbps 档估算显著小于默认 12Mbps 档，但仍保留封装余量。 | 4Mbps 档导出 1 分钟实际约 30MB，预检却按约 100MB 拒绝 → 「磁盘还有 50MB 却提示空间不足」。调用方仍显式传旧估算（见 §4-4）。 |
| 16 | — | `decoder.ts` 原 `copyBufferInto` 的 `step`、`encode.ts` 的 `pendingAudio` | 未使用变量/字段，误导读者以为存在重采样步进逻辑。 | 删除。 | tsc 通过。 | 无运行时影响（清理项）。 |

---

## 2. 关键线索结论：`compositor.ts:88 drawSourcePrivacy`

- **结论：是死代码，不是缺失的遮挡渲染路径。**
- 证据：
  1. 全仓 grep 只有定义处，没有调用点；
  2. `drawScene` 在屏幕裁剪区内已有完整的 `screenPrivacy` 绘制（含取景 `viewX/viewW` 映射），预览（`PreviewCanvas`）、导出（`exporter`）、教程截图（`exporterRuntime`）全部经过 `drawScene`，因此遮挡在三种产物里都生效；
  3. 新增测试验证「未确认遮挡不绘制、已确认遮挡在运镜下映射到正确像素」，证明语义已由内联实现承载。
- 风险与处理：两份实现的 alpha/步长/映射不同（死代码版忽略运镜），保留会诱导后续只改死代码。已删除并把内联逻辑收敛为 `drawScreenPrivacy()`（唯一入口）。

---

## 3. 新增测试（tests/media，65 个）

| 文件 | 数量 | 覆盖点 |
|------|------|--------|
| `tests/media/decoder.test.ts` | 19 | SegmentSet 定位；最近前帧与缓存；跨段取帧；坏段回溯+不重试；越界保留末帧；open 全失败/首段坏；并发单飞；close/驱逐归还 Input 与音频迭代器；openFrameSources 失败清理；PCM 跨段拼接、单→双声道、下混、非 48k 重采样、无音轨返回 null |
| `tests/media/encode.test.ts` | 17 | addAudio 时间戳归一化/补静音/不倒退/非法采样率/空批；finalize 成功/失败资源释放；abort 幂等；重复 init；commitVideoFrame 负时间戳夹 0；ContinuousMuxer finalize/cancel/dispose/addSilence 顺序 |
| `tests/media/compositor.test.ts` | 17 | CSS 渐变几何四个方向 + 渐变线长度 + drawScene 端点/色标；遮挡映射（含运镜/留边）；实色/模糊/马赛克绘制差异；零尺寸跳过；未确认遮挡不绘制；光标（含运镜）与点击波纹；摄像头 cover 裁切与 VideoFrame 尺寸；标注；编辑辅助层开关；无源帧占位；frameCacheKey |
| `tests/media/exporter.test.ts` | 12 | 成功链路（写 partial→校验→改名→释放）；ENOSPC/EACCES 写失败清理残片；空间预检中止；改名失败；校验失败；取消（真实帧数/取消封装器/清理）；音频解码失败/素材缺失告警；estimateOutputBytes 码率；sha256 向量；快照深拷贝 |

命令与结果（本次审计终态）：

```
npx tsc --noEmit -p tsconfig.json   → exit 0
npx vitest run                      → 28 test files, 786 tests, all passed
```

> 说明：`vitest.config.ts` 的覆盖率统计只 include `src/domain/**` 与 `src/renderer/lib/waveform.ts`，不计 `src/media`，故本报告不给出 media 覆盖率数字（配置不在本任务写入范围，建议后续把 `src/media/**` 加入 coverage include）。

---

## 4. 跨范围发现（只记录，未修改）

| # | 级别 | 位置 | 问题 | 建议 |
|---|------|------|------|------|
| 1 | **P0** | `electron/main.ts:1728`（`IPC.fileListSegments`）与 `src/renderer/exporterRuntime.ts:162` | **导出成片没有录制的声音**：音频段是 `media/mic`、`media/system` 下的 `seg-XXXXXX.wav`（`main.ts:1037` 建资产），但 `fileListSegments` 只列 `*.mp4`，音频资产的段列表恒为空 → `providerFor` 返回 null → 混音器按静音处理。导出器又总是 `includeAudio:true` 并写满静音采样，所以音频轨存在、校验通过，**问题被完全掩盖**。编辑器预览走 `wcs-media://` 不受影响，因此现象是「预览有声音、导出没声音」。 | 段列表按资产类型/扩展名列出 `.mp4` + `.wav`（或按 `asset.kind` 决定），并对每段探测时长；补一条 e2e：真实录制 → 导出 → 解码音频峰值 > 0。 |
| 2 | **P1** | `src/domain/scene.ts:203-213`、`:248`；`src/domain/project.ts` 的 `PrivacyAnchor` | 摄像头遮挡永远为空：`cameraPrivacy` 声明后从未 push，且 `PrivacyAnchor` 只有 screen/window/keyframe，没有 camera 锚点。`compositor.drawCamera` 里的摄像头遮挡循环因此不可达。§11.2 明确要求「摄像头必须有独立遮挡集合」。 | 增加 camera 锚点与独立集合的求值；或明确产品砍掉该能力并移除 compositor 死循环与类型字段。 |
| 3 | **P1** | `src/renderer/exporterRuntime.ts:356` | 教程截图 `resources.camera` 恒为 null：视频有摄像头画中画，教程截图没有。§12/§11.5 要求教程截图与视频同一条合成管线且遮挡一致（遮挡已一致，但摄像头不是）。 | 教程侧复用导出器的 camera 解析（`timeMap.toSource('camera', tick)` + 持有画布），并纳入截图对比测试。 |
| 4 | **P2** | `src/renderer/exporterRuntime.ts:444` | 仍调 `estimateOutputBytes(plan)`（不传 profile），磁盘预检继续按 12Mbps 估算；本任务已给该函数加上可选码率参数。 | 改为 `estimateOutputBytes(plan, { videoBitrate: request.profile.videoBitrate, audioBitrate: request.profile.audioBitrate })`。 |
| 5 | **P2** | `src/shared/ipc.ts` 的 `ExportResult`、`exporterRuntime.ts:461-471` | `ExportProjectResult.warnings`（素材缺失/音频降级/读回失败等）没有进入 `ExportResult`，被运行时丢弃；用户永远看不到「这段导出有降级」。跨范围修好 P0 后，也仍会缺少可观测性。 | `ExportResult` 增加 `warnings: string[]` 并在 UI 展示（至少失败详情/诊断面板）。 |
| 6 | **P2** | `src/renderer/components/PreviewCanvas.tsx:112` 与 `compositor.ts` 的 `DrawOptions.devicePixelRatio` | 预览把 `devicePixelRatio` 传给 `drawScene` 但合成器从未读取；预览画布宽高也按逻辑像素设置，HiDPI 下预览偏软。 | 二选一：预览画布按 DPR 放大并在 drawScene 前 `ctx.scale(dpr,dpr)`（同时让 drawScene 尊重已有变换），或移除死参数。需渲染层与媒体层共同验收。 |
| 7 | **P2** | `src/media/compositor.ts:418 frameCacheKey` | 已导出但全仓无调用；§10.4 要求的缓存键（素材哈希、解码版本、采样规则、遮挡版本）实际也没进入 `FrameScene.cacheKey`（只有 revision/privacyVersion/tick/尺寸/variant）。 | 明确缩略图/帧缓存是否还需要该 API；需要则补齐键字段并接入，不需要则删除。 |
| 8 | **P2** | `electron/capture/captureEngine.ts` journal 与 `main.ts:1038 listMediaSegments` | 段 `startTick` 由「探测到的各段实际时长累加」得到，而工程片段时长来自录制计划值；两者若因编码器丢帧/时基量化不一致，长录制会出现累计映射偏移（音画、取帧都会偏）。本次未实测到偏差量级，属待验证风险。 | 增加「计划时长 vs 探测时长」一致性检查，超过阈值时告警并记录日志。 |

---

## 5. 未修复风险（本范围内，已评估但本次不做）

1. **模糊/马赛克不是真正的模糊/像素化**（`compositor.ts:130`）：实色遮挡是不透明黑，可靠；`blur` 是「88% 不透明黑 + 边缘模糊」，`mosaic` 是「94% 不透明黑 + 网格线」，都**没有对底图内容做模糊或像素化**。隐私目标（遮挡）达成，但样式语义与用户预期不符（用户选「模糊」得到的是深色块）。按 §12.2「模糊与马赛克只作为视觉样式、不作为不可恢复保证」，这属于产品/视觉决策；实现真正的 blur/pixelate 需要重绘源区域并做离屏降采样，必须用真实 Electron 画面做视觉验收，本次不擅自改视觉。
2. **播放速率 ≠ 1 时音频映射错误**（`exporter.ts:538-573`）：`decodeInterval` 按 rate 放大源区间取 PCM，但写回输出时按 1:1 采样写入，没有做时间伸缩/重采样 → 变速片段音频变慢并被截断。`project.ts` 注明 MVP 固定 1/1，当前 UI 不可达，故未修；未来开变速必须先修这里（视频侧是一帧一帧取的，不会错）。
3. **`muxer.finalize()` 不可取消**：取消信号只能在 finalize 返回后的检查点生效，长封装期间用户点取消要等封装结束。可在 finalize 期间用进度心跳提示「正在完成封装，暂不可取消」，或换可分片封装。
4. **崩溃残留的 `.partial`**：本次修复覆盖「本次导出失败」的清理；进程崩溃/断电留下的 `.partial` 不会在下次启动时清理（会覆盖同路径，但改输出名时永久残留）。建议主进程启动时清理输出目录中超过 N 小时的 `*.partial` 并在结果中提示。
5. **清理失败信息丢失**：`cleanupPartial` 在 `removeFile` 缺失/失败时写入 `warnings`，但随后抛出错误，调用方拿不到 `warnings`（只拿到错误 message）。建议把残留路径拼进 `AppError.detail`（主进程日志/诊断面板可读）。
6. **校验不检查音频内容**（`exporter.ts:607 verifyMp4`）：只检查音频轨存在、声道数、采样率；空/静音音轨也能通过。这也是跨范围 P0（无声音导出）长期未被发现的原因之一。建议增加「音频采样数 ≈ 时长×采样率 ±1 帧」与「非静音峰值/能量」检查。
7. **`open()` 只探测前 5 段**：若前 5 段全损坏、第 6 段起可用，会误报素材不可用。当前录制提交前的段校验使该场景概率很低；如需支持，可改为「探测到第一个可打开段即停，最多 5 次失败」。
8. **整片内存驻留**：`BufferTarget` 全内存 MP4 + IPC 一次性传 `Uint8Array` + 校验再读回整文件，峰值内存约 3× 成片体积（§16.2 1.2GB 上限在长视频/高码率下有风险）。需要流式写入（`StreamTarget`/分块 IPC）。
9. **`parseBackground` 只支持 `linear-gradient(<数字角度>, 色标…)`**：无角度写法、`to right` 等关键字、带位置的色标（如 `#fff 0%`）会被误解析（首个色标当角度、非法颜色传给 `addColorStop` 可能抛 `SyntaxError`，让导出失败）。当前 UI 只产生数字角度+纯色标，风险低；若工程可被导入/手改，建议补解析与容错。
10. **`probeEncodeCapabilities` 的 `hardwareVideo` 只是「prefer-hardware 探测成功」**：canEncodeVideo 成功不代表实际 configure 成功（尺寸/驱动差异），界面显示的档位可能与最终实际编码器不同；需要时以 `ContinuousMuxer.init` 返回的真实 label 为准（导出结果已返回 `encoder`）。
11. **`SegmentEncoder` 的音频与视频时长不强制对齐**：`finalize` 返回的 `durationUs` 取视频时间戳，音频长度由调用方保证；若某段音频样本数与视频帧数不匹配，MP4 音轨/视频轨时长会不同（容器时长取较长者），跨段累计可能偏。录制端已按「计划时长」补齐 WAV，暂未发现实际问题。

---

## 6. 结论

- 本轮在 `src/media` 内修复 **15 项**缺陷（P0=0，P1=7，P2=8）+ **1 项死代码清理**，每项都有对应新增测试；统一了遮挡绘制入口。
- 媒体管线最危险的三个真实问题：① 写盘失败后 `.partial` 残留（P1）；② 损坏段/缺失素材导致导出失败或黑屏成片（P1）；③ 编码器失败路径资源不释放（P1）。
- 媒体层之外存在一个**会直接导致「导出无声」的 P0**（`fileListSegments` 只列 mp4），已写入跨范围清单，建议优先交由主进程范围修复；它同时解释了「为什么导出校验一直通过」。

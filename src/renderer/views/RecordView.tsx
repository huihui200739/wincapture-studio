/**
 * 录制设置页（§6.1 / §6.2 步骤 1）
 *
 * 要点：
 * - 来源选择带缩略图与真实分辨率；不可用来源明确标出原因。
 * - 麦克风与系统声音各自一条电平表（0 电平时显示「无信号」，不只靠颜色）。
 * - 质量档位同时显示「设置值」与「实际能力」，来源/编码器不支持时给出降级说明。
 * - 显示可用磁盘与预计可录时长；磁盘不足时阻止开始并给可执行提示。
 * - 开始前 3 秒倒计时，倒计时可取消。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AudioDeviceInfo,
  CaptureSourceInfo,
  DisplayInfo,
  QualityProfile,
  SystemInfo,
  VideoDeviceInfo,
} from '@shared/ipc';
import { useApp } from '../lib/store';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Icon,
  InlineNote,
  LevelMeter,
  Panel,
  Segmented,
  Select,
  Spinner,
  TextInput,
  Toggle,
} from '../components/ui';
import {
  bytesPerSecond,
  cn,
  formatBitrate,
  formatBytes,
  formatDurationLong,
  recordableSeconds,
  unwrap,
} from '../lib/format';
import { wcs } from '../lib/wcs';
import { syntheticCamera, syntheticScreen } from '../lib/syntheticMedia';
import { isSourceInKind, pickSourceForKind } from '../uiSync';

const MIN_FREE_BYTES = 512 * 1024 * 1024;

/**
 * 枚举摄像头设备。
 *
 * 主进程的 capture:list-devices 只返回音频设备，video 固定为空数组
 * （注释写着「视频设备由渲染进程通过 navigator.mediaDevices 枚举后回传」），
 * 但旧版 RecordView 没有实现这段枚举，导致：
 *  - 摄像头设备下拉框永远只有「系统默认摄像头」；
 *  - 面板永远显示「没有检测到摄像头」，即使机器上有摄像头。
 * 这里补上真实枚举；未授权时 label 为空串，给可读兜底名。
 */
async function enumerateVideoDevices(): Promise<VideoDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === 'videoinput')
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `摄像头 ${index + 1}`,
    }));
}

/**
 * 数值输入框（本地草稿 + 合法时即时提交）。
 *
 * 直接受控绑定数字值时：清空会被 Number('') === 0 当成 0 立刻提交（宽/高瞬间变 0），
 * 输入 '-' 得到 NaN 被静默丢弃，用户既打不出负号也看不到解释。
 * 这里保留字符串草稿，只有解析成功且非空才提交，失焦时再夹紧并回填。
 */
function NumberDraftInput({
  label,
  value,
  min,
  max,
  step,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (next: number) => void;
}) {
  const [draft, setDraft] = useState(() => String(value));
  // 外部值变化（切换来源、区域被夹紧）时同步草稿，但不打断正在输入的内容
  useEffect(() => {
    setDraft((prev) => (Number(prev) === value && prev.trim() !== '' ? prev : String(value)));
  }, [value]);

  const normalize = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed === '-' || trimmed === '+') return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return null;
    return Math.round(parsed);
  };

  return (
    <TextInput
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      onChange={(event) => {
        const raw = event.target.value;
        setDraft(raw);
        const parsed = normalize(raw);
        if (parsed === null) return;
        if (parsed < min || parsed > max) return;
        onCommit(parsed);
      }}
      onBlur={() => {
        const parsed = normalize(draft);
        if (parsed === null) {
          setDraft(String(value));
          return;
        }
        const clamped = Math.max(min, Math.min(max, parsed));
        onCommit(clamped);
        setDraft(String(clamped));
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
      }}
      aria-label={label}
    />
  );
}

export function RecordView() {
  const {
    config,
    updateConfig,
    startRecording,
    capture,
    stopRecording,
    pushToast,
    pushError,
    busy,
    setView,
    apiMode,
    quality,
  } = useApp();

  const [sources, setSources] = useState<CaptureSourceInfo[]>([]);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [audioDevices, setAudioDevices] = useState<AudioDeviceInfo[]>([]);
  const [videoDevices, setVideoDevices] = useState<VideoDeviceInfo[]>([]);
  const [profiles, setProfiles] = useState<QualityProfile[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sourceKind, setSourceKind] = useState<'screen' | 'window'>(config.sourceKind ?? 'screen');
  const [regionEnabled, setRegionEnabled] = useState(false);
  const [freeBytes, setFreeBytes] = useState<number | null>(null);
  const [pathCheck, setPathCheck] = useState<{ ok: boolean; writable: boolean; reason?: string } | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [levels, setLevels] = useState({ mic: 0, system: 0 });
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  /** 待启动时记录「界面倒计时用掉的秒数」，启动后要恢复用户设置 */
  const [pendingStart, setPendingStart] = useState<number | null>(null);

  const cameraRef = useRef<HTMLCanvasElement | null>(null);
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const countdownTimer = useRef<number | null>(null);
  /** 倒计时是否有效（timer 回调里同步判断，避免旧定时器在多轮点击后继续推进） */
  const countdownActiveRef = useRef(false);
  /** 启动请求是否已发出（同步挡双击） */
  const startingRef = useRef(false);
  /** 设备枚举的请求代号：只接受最后一次请求的结果，避免旧结果覆盖新选择 */
  const loadGeneration = useRef(0);
  const mountedRef = useRef(true);
  /** 最新 config / startRecording：异步回调里读当前值，避免闭包拿到旧配置 */
  const configRef = useRef(config);
  configRef.current = config;
  const startRecordingRef = useRef(startRecording);
  startRecordingRef.current = startRecording;

  // ---- 卸载标记：异步回调里不再 setState ----
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** 只刷新摄像头列表（热插拔 / devicechange 用，避免整页重新枚举闪一下）。 */
  const refreshVideoDevices = useCallback(async () => {
    try {
      const list = await enumerateVideoDevices();
      if (!mountedRef.current) return;
      setVideoDevices(list);
      setDevicesError(null);
      const current = configRef.current;
      if (list.length > 0 && !list.some((device) => device.deviceId === current.cameraDeviceId)) {
        // 之前选的摄像头被拔掉了：回退到默认设备，而不是留着一个不存在的 deviceId
        updateConfig({ cameraDeviceId: list[0].deviceId });
      }
    } catch (error) {
      if (!mountedRef.current) return;
      setDevicesError(`摄像头枚举失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [updateConfig]);

  // ---- 读取设备与来源 ----
  const loadAll = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setLoadError(null);
    setDevicesError(null);
    try {
      const [src, disp, dev, prof, sys] = await Promise.all([
        wcs().listSources(),
        wcs().listDisplays(),
        wcs().listDevices(),
        wcs().qualityProfiles(),
        wcs().systemInfo(),
      ]);
      // 别让「先点刷新、再点重试」时较慢的旧请求覆盖新结果
      if (loadGeneration.current !== generation) return;
      const sourceList = unwrap(src);
      setSources(sourceList);
      setDisplays(unwrap(disp));
      const deviceBundle = unwrap(dev);
      setAudioDevices(deviceBundle.audio);
      setProfiles(unwrap(prof));
      setSystem(unwrap(sys));

      // 摄像头设备主进程不返回，改由渲染进程枚举（见 enumerateVideoDevices）
      let videoList = deviceBundle.video;
      if (videoList.length === 0) {
        try {
          videoList = await enumerateVideoDevices();
        } catch (error) {
          setDevicesError(`摄像头枚举失败：${error instanceof Error ? error.message : String(error)}`);
        }
        if (loadGeneration.current !== generation) return;
      }
      setVideoDevices(videoList);

      // 默认选中来源：优先当前选中项，其次第一个可用来源
      const current = configRef.current;
      if (!current.sourceId || !sourceList.some((item) => item.id === current.sourceId)) {
        const first =
          sourceList.find((item) => item.id === current.sourceId) ??
          sourceList.find((item) => item.kind === current.sourceKind && item.available) ??
          sourceList.find((item) => item.available);
        if (first) updateConfig({ sourceId: first.id, sourceKind: first.kind });
      }
      const micDefault =
        deviceBundle.audio.find((d) => d.kind === 'audioinput' && d.isDefault) ??
        deviceBundle.audio.find((d) => d.kind === 'audioinput');
      if (micDefault && !current.microphoneDeviceId) updateConfig({ microphoneDeviceId: micDefault.deviceId });
      const camDefault = videoList[0];
      if (camDefault && !current.cameraDeviceId) updateConfig({ cameraDeviceId: camDefault.deviceId });
    } catch (error) {
      if (loadGeneration.current !== generation) return;
      const presented = pushError(error, '读取录制设备失败');
      setLoadError(presented.message);
    } finally {
      if (loadGeneration.current === generation) setLoading(false);
    }
    // 依赖保持为空：设备枚举只应在挂载与手动「重新检测」时触发，
    // 当前选择从 configRef 读，避免每次改配置都重枚举一次设备。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 摄像头热插拔：设备变化时只刷新摄像头列表并纠正失效选择
  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;
    let timer = 0;
    const onChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refreshVideoDevices(), 300);
    };
    mediaDevices.addEventListener('devicechange', onChange);
    return () => {
      window.clearTimeout(timer);
      mediaDevices.removeEventListener('devicechange', onChange);
    };
  }, [refreshVideoDevices]);

  // ---- 磁盘检查 ----
  const videosPath = system?.videosPath ?? '';
  const checkDisk = useCallback(async () => {
    // 系统信息还没回来时不要拿空串去检查：checkPath('') 会落到进程工作目录，
    // 读出一个和真实输出目录无关的剩余空间，界面会显示错误的可录时长。
    if (!videosPath) {
      setFreeBytes(null);
      setPathCheck(null);
      return;
    }
    try {
      const result = unwrap(await wcs().checkPath(videosPath));
      if (!mountedRef.current) return;
      setFreeBytes(result.freeBytes);
      setPathCheck({ ok: result.ok, writable: result.writable, reason: result.reason });
    } catch (error) {
      if (!mountedRef.current) return;
      setPathCheck({ ok: false, writable: false, reason: describeSafe(error) });
      setFreeBytes(null);
    }
  }, [videosPath]);

  useEffect(() => {
    void checkDisk();
  }, [checkDisk]);

  /** 打开录制输出目录（产物目录由主进程固定为系统「视频」目录，界面不能改）。 */
  const openOutputDir = useCallback(async () => {
    if (!videosPath) {
      pushToast({ tone: 'warn', title: '输出目录还未就绪', message: '系统信息加载完成后再试一次。' });
      return;
    }
    try {
      unwrap(await wcs().openPath(videosPath));
    } catch (error) {
      pushError(error, '打开输出目录失败');
    }
  }, [pushError, pushToast, videosPath]);

  // ---- 电平：录制中取主进程推送，空闲时用本地动画表示「设备已就绪」 ----
  useEffect(() => {
    if (capture) {
      setLevels(capture.levels);
      return;
    }
    if (apiMode !== 'mock') {
      setLevels({ mic: 0, system: 0 });
      return;
    }
    // 旧实现的清理只 cancelAnimationFrame(raf)，但真正的循环节拍在 setTimeout 里：
    // 卸载瞬间如果正停在 timeout 窗口内，取消 rAF 是空操作，tick 会继续排下一轮，
    // 于是组件卸载后仍然每 90ms setState（长时间开着页面/反复切视图会累积计时器）。
    let cancelled = false;
    let raf = 0;
    let timeout = 0;
    const tick = () => {
      if (cancelled) return;
      const t = performance.now() / 1000;
      setLevels({
        mic: config.microphoneEnabled ? Math.max(0, 0.3 + Math.sin(t * 4.1) * 0.2 + Math.sin(t * 9.3) * 0.09) : 0,
        system: config.systemAudioEnabled ? Math.max(0, 0.16 + Math.sin(t * 2.7 + 1) * 0.13 + Math.sin(t * 7.9) * 0.05) : 0,
      });
      timeout = window.setTimeout(() => {
        if (cancelled) return;
        raf = requestAnimationFrame(tick);
      }, 90);
    };
    tick();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(timeout);
    };
  }, [capture, config.microphoneEnabled, config.systemAudioEnabled, apiMode]);

  // ---- 摄像头预览 ----
  const [cameraPreviewError, setCameraPreviewError] = useState<string | null>(null);
  useEffect(() => {
    if (!config.cameraEnabled) return;
    if (apiMode !== 'mock') {
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout>;
      let retryDelay = 250;
      setCameraPreviewError(null);
      const update = async () => {
        try {
          const result = await wcs().cameraPreview(true, config.cameraDeviceId);
          if (cancelled) return;
          if (!result.ok || !result.data?.ok || !result.data.png) { retryDelay = 3000; setCameraPreviewError(result.ok ? result.data?.error ?? '摄像头未就绪' : result.error?.message ?? '摄像头预览失败'); return; }
          retryDelay = 250;
          const image = new Image();
          image.onload = () => {
            if (cancelled) return;
            const context = cameraRef.current?.getContext('2d');
            if (context) { const fit = Math.min(480 / image.width, 360 / image.height); const w = image.width * fit, h = image.height * fit; context.fillStyle = '#101418'; context.fillRect(0, 0, 480, 360); context.drawImage(image, (480 - w) / 2, (360 - h) / 2, w, h); }
            setCameraPreviewError(null);
          };
          image.src = `data:image/png;base64,${result.data.png}`;
        } catch (error) { retryDelay = 3000; if (!cancelled) setCameraPreviewError(String(error)); }
        finally { if (!cancelled) timer = setTimeout(update, retryDelay); }
      };
      void update();
      return () => { cancelled = true; clearTimeout(timer); void wcs().cameraPreview(false).catch(() => undefined); };
    }
    let raf = 0;
    const draw = () => {
      const canvas = cameraRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const source = syntheticCamera(performance.now() / 1000);
          ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [config.cameraEnabled, config.cameraDeviceId, apiMode]);

  // ---- 来源预览 ----
  const selectedSource = useMemo(() => sources.find((s) => s.id === config.sourceId) ?? null, [sources, config.sourceId]);

  // ---- 录制区域（R01）----
  // 配置里没 region 就表示整屏；面板上的值始终有具体数字方便编辑。
  const region = useMemo(() => {
    if (config.region) return config.region;
    const w = selectedSource?.width ?? 1920;
    const h = selectedSource?.height ?? 1080;
    return { x: 0, y: 0, width: w, height: h };
  }, [config.region, selectedSource]);

  const regionValid = useMemo(() => {
    if (!selectedSource) return true;
    return (
      region.width >= 64 &&
      region.height >= 64 &&
      region.x >= 0 &&
      region.y >= 0 &&
      region.x + region.width <= selectedSource.width &&
      region.y + region.height <= selectedSource.height
    );
  }, [region, selectedSource]);

  const updateRegion = useCallback(
    (patch: Partial<{ x: number; y: number; width: number; height: number }>) => {
      updateConfig({ region: { ...region, ...patch } });
    },
    [region, updateConfig],
  );

  // 切换来源时，区域跟着新来源重置，避免把上一个屏幕的坐标带到另一个屏幕上
  useEffect(() => {
    if (!regionEnabled) return;
    if (!selectedSource) return;
    const tooBig =
      region.x + region.width > selectedSource.width || region.y + region.height > selectedSource.height;
    if (tooBig) {
      updateConfig({
        region: {
          x: 0,
          y: 0,
          width: Math.min(region.width, selectedSource.width),
          height: Math.min(region.height, selectedSource.height),
        },
      });
    }
    // 只在来源变化时纠正，不要跟着 region 每次变化重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSource?.id]);

  useEffect(() => {
    if (apiMode !== 'mock') {
      const canvas = previewRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      let cancelled = false;
      ctx.fillStyle = '#101418';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const image = new Image();
      image.onload = () => {
        if (cancelled) return;
        const crop = regionEnabled ? region : { x: 0, y: 0, width: selectedSource?.width ?? 1, height: selectedSource?.height ?? 1 };
        const sx = crop.x / (selectedSource?.width || 1) * image.width;
        const sy = crop.y / (selectedSource?.height || 1) * image.height;
        const sw = crop.width / (selectedSource?.width || 1) * image.width;
        const sh = crop.height / (selectedSource?.height || 1) * image.height;
        const scale = Math.min(canvas.width / sw, canvas.height / sh);
        ctx.fillStyle = '#101418';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, sx, sy, sw, sh, (canvas.width - sw * scale) / 2, (canvas.height - sh * scale) / 2, sw * scale, sh * scale);
      };
      if (selectedSource?.thumbnail) image.src = selectedSource.thumbnail;
      else {
        ctx.fillStyle = '#a4adba'; ctx.font = '16px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('选择来源并刷新缩略图以预览', canvas.width / 2, canvas.height / 2);
      }
      return () => { cancelled = true; image.onload = null; image.onerror = null; };
    }
    let raf = 0;
    const draw = () => {
      const canvas = previewRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const source = syntheticScreen(performance.now() / 1000 * 0.35);
          const scale = Math.max(canvas.width / source.width, canvas.height / source.height);
          const dw = source.width * scale;
          const dh = source.height * scale;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(source, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [apiMode, selectedSource, regionEnabled, region]);

  const filteredSources = useMemo(() => sources.filter((s) => s.kind === sourceKind), [sources, sourceKind]);

  // ---- 质量与预计体积 ----
  const bps = bytesPerSecond(quality.videoBitrate, quality.audioBitrate);
  const recordable = freeBytes != null ? recordableSeconds(freeBytes, bps) : 0;
  const diskInsufficient = freeBytes != null && freeBytes < MIN_FREE_BYTES;
  const diskTight = freeBytes != null && !diskInsufficient && freeBytes < 2 * 1024 ** 3;

  const sourcePixelHint = useMemo(() => {
    // 自定义区域录制时输出就是区域原生像素，不做缩放，缩放提示不适用
    if (regionEnabled) return null;
    if (!selectedSource) return null;
    if (selectedSource.width === quality.width && selectedSource.height === quality.height) return null;
    if (selectedSource.width > quality.width) {
      return `来源 ${selectedSource.width} × ${selectedSource.height} 高于所选档位，会按 ${quality.width} × ${quality.height} 缩放输出（文字可能变软）。`;
    }
    return `来源 ${selectedSource.width} × ${selectedSource.height} 低于所选档位，会放大到 ${quality.width} × ${quality.height}，清晰度受源限制。`;
  }, [regionEnabled, selectedSource, quality]);

  // 切换到「窗口 / 显示器」分栏时，选中项必须跟着收敛到该分栏，
  // 否则会拿上一个分栏的来源去开录（界面显示「窗口」，实际录的是显示器）。
  useEffect(() => {
    if (config.sourceKind === sourceKind) return;
    const selection = pickSourceForKind(sources, sourceKind, config.sourceId);
    if (sourceKind === 'window') setRegionEnabled(false);
    updateConfig({ ...selection, region: undefined });
  }, [config.sourceId, config.sourceKind, sourceKind, sources, updateConfig]);

  // ---- 倒计时 ----
  /**
   * 真正发出启动请求。
   *
   * 关键修复：界面已经在本页做过一次倒计时，采集引擎内部还会按
   * config.countdownSeconds 再倒计时一次（store.startRecording 原样传 config），
   * 实测点「开始录制」后要等约 6 秒才真正出画面，中间 3 秒没有任何提示。
   * 这里先把 config 置 0 并用「置 0 后的 render」里的 startRecording 发请求，
   * 请求发出后立刻恢复用户设置（见下方 pendingStart effect）。
   * store.startRecording 增加 countdownSeconds 覆盖参数后可以删掉这段兼容逻辑。
   */
  const finishStart = useCallback(
    (restoreCountdown: number | null) => {
      const started = startRecordingRef.current();
      void started
        .catch(() => {
          // store.startRecording 内部已经 pushError；这里只保证 finally 一定跑
        })
        .finally(() => {
          startingRef.current = false;
          if (mountedRef.current) setStarting(false);
          if (restoreCountdown !== null) updateConfig({ countdownSeconds: restoreCountdown });
        });
    },
    [updateConfig],
  );

  const startEngine = useCallback(() => {
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    const seconds = Math.max(0, Math.round(configRef.current.countdownSeconds));
    if (seconds > 0) {
      setPendingStart(seconds);
      updateConfig({ countdownSeconds: 0 });
      return;
    }
    finishStart(null);
  }, [finishStart, updateConfig]);

  useEffect(() => {
    if (pendingStart === null) return;
    if (config.countdownSeconds !== 0) {
      // 等待期间用户又改了倒计时设置：再压回 0，避免启动流程永远等不到条件
      updateConfig({ countdownSeconds: 0 });
      return;
    }
    setPendingStart(null);
    finishStart(pendingStart);
  }, [config.countdownSeconds, finishStart, pendingStart, updateConfig]);

  const beginCountdown = useCallback(() => {
    if (startingRef.current || countdownActiveRef.current || pendingStart !== null) return;
    const seconds = Math.max(0, Math.round(configRef.current.countdownSeconds));
    if (seconds === 0) {
      startEngine();
      return;
    }
    countdownActiveRef.current = true;
    setCountdown(seconds);
    const step = (remaining: number) => {
      if (!countdownActiveRef.current) return;
      if (remaining <= 0) {
        countdownActiveRef.current = false;
        countdownTimer.current = null;
        setCountdown(null);
        startEngine();
        return;
      }
      setCountdown(remaining);
      countdownTimer.current = window.setTimeout(() => step(remaining - 1), 1000);
    };
    countdownTimer.current = window.setTimeout(() => step(seconds - 1), 1000);
  }, [pendingStart, startEngine]);

  const cancelCountdown = useCallback(() => {
    countdownActiveRef.current = false;
    if (countdownTimer.current !== null) {
      window.clearTimeout(countdownTimer.current);
      countdownTimer.current = null;
    }
    setCountdown(null);
    pushToast({ tone: 'info', title: '已取消倒计时', message: '没有开始采集。' });
  }, [pushToast]);

  // Esc 取消倒计时：界面文案一直写着「取消（Esc）」，但旧实现只绑了按钮。
  useEffect(() => {
    if (countdown === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelCountdown();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancelCountdown, countdown]);

  // 卸载时清掉倒计时定时器
  useEffect(
    () => () => {
      countdownActiveRef.current = false;
      if (countdownTimer.current !== null) window.clearTimeout(countdownTimer.current);
    },
    [],
  );

  // 录制中状态：显示悬浮控制条预览与停止入口
  const recording = !!capture && ['Preparing', 'Countdown', 'Recording', 'Pausing', 'Paused', 'Resuming', 'Stopping', 'Finalizing'].includes(capture.state);

  /** 实际会输出的分辨率：录制开始后以主进程回报的 effective 为准（区域录制会小于来源）。 */
  const effectiveResolution = useMemo(() => {
    if (capture?.effective) return `${capture.effective.width} × ${capture.effective.height}`;
    if (regionEnabled && selectedSource) return `${region.width} × ${region.height}`;
    return selectedSource ? `${selectedSource.width} × ${selectedSource.height}` : '未选择来源';
  }, [capture?.effective, region.width, region.height, regionEnabled, selectedSource]);

  const cameraDegradation = useMemo(() => {
    const reason = capture?.degradation;
    return reason && /摄像头/.test(reason) ? reason : null;
  }, [capture?.degradation]);

  const blockedReason = useMemo(() => {
    if (!config.sourceId) return '请先选择一个录制来源。';
    // 选中项必须属于当前分栏，否则「开始录制」会拿一个界面上看不见的来源开录
    if (!isSourceInKind(sources, sourceKind, config.sourceId)) {
      return `当前分栏（${sourceKind === 'screen' ? '显示器' : '窗口'}）还没有选择录制对象，请先选择一个。`;
    }
    if (selectedSource && !selectedSource.available) return '该来源受系统保护或已关闭，请换一个来源。';
    if (diskInsufficient) return `磁盘可用空间不足 ${formatBytes(MIN_FREE_BYTES)}，请清理磁盘或打开输出目录清理。`;
    if (pathCheck && !pathCheck.writable) return pathCheck.reason || '输出目录不可写，请检查磁盘权限。';
    return null;
  }, [config.sourceId, diskInsufficient, pathCheck, selectedSource, sourceKind, sources]);

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1>录制设置</h1>
          <p>
            选择来源、检查设备与磁盘，确认预览后
            {config.countdownSeconds > 0 ? `开始 ${config.countdownSeconds} 秒倒计时。` : '立即开始录制。'}
          </p>
        </div>
        <div className="view-actions">
          <Button size="sm" variant="ghost" icon="refresh" onClick={() => void loadAll()} disabled={loading}>
            重新检测
          </Button>
          {recording ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setView('editor')}>
                去编辑器
              </Button>
              <Button size="sm" variant="danger" icon="stop" loading={busy.capture} onClick={() => void stopRecording()}>
                停止录制
              </Button>
            </>
          ) : (
            <Button
              size="md"
              variant="primary"
              icon="record"
              disabled={!!blockedReason || busy.capture || starting || countdown !== null}
              loading={busy.capture || starting}
              onClick={beginCountdown}
              title={blockedReason ?? (config.countdownSeconds > 0 ? `开始 ${config.countdownSeconds} 秒倒计时` : '立即开始录制')}
            >
              {starting ? '正在启动采集…' : countdown !== null ? `倒计时 ${countdown}…` : '开始录制'}
            </Button>
          )}
        </div>
      </div>

      {loadError && (
        <div style={{ marginBottom: 12 }}>
          <InlineNote tone="danger">
            <strong>设备枚举失败：</strong> {loadError}
            <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
              <Button size="sm" icon="refresh" onClick={() => void loadAll()}>
                重试
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setView('settings')}>
                查看诊断
              </Button>
            </div>
          </InlineNote>
        </div>
      )}

      {blockedReason && (
        <div style={{ marginBottom: 12 }}>
          <InlineNote tone="warn">
            <strong>暂时不能开始：</strong> {blockedReason}
            {diskInsufficient && (
              <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
                <Button size="sm" onClick={() => void checkDisk()}>重新检查磁盘</Button>
                <Button size="sm" variant="ghost" icon="folder" onClick={() => void openOutputDir()}>打开输出目录</Button>
              </div>
            )}
            {pathCheck && !pathCheck.writable && (
              <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
                <Button size="sm" onClick={() => void checkDisk()}>重新检查</Button>
                <Button size="sm" variant="ghost" icon="folder" onClick={() => void openOutputDir()}>打开输出目录</Button>
              </div>
            )}
          </InlineNote>
        </div>
      )}

      <div className="record-layout">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          {/* ---- 来源 ---- */}
          <Panel
            title="录制来源"
            icon="screen"
            subtitle={loading ? '正在枚举…' : `${filteredSources.length} 个可用对象`}
            actions={
              <Segmented
                size="sm"
                ariaLabel="来源类型"
                value={sourceKind}
                onChange={(next) => setSourceKind(next)}
                options={[
                  { value: 'screen', label: '显示器', icon: 'screen' },
                  { value: 'window', label: '窗口', icon: 'window' },
                ]}
              />
            }
          >
            {loading ? (
              <div className="wcs-empty">
                <Spinner size={18} />
                <p>正在枚举显示器与窗口…</p>
              </div>
            ) : filteredSources.length === 0 ? (
              <EmptyState
                icon="screen"
                title={sourceKind === 'screen' ? '没有检测到显示器' : '没有可录制的窗口'}
                description={
                  sourceKind === 'screen'
                    ? '请确认显示器已连接，然后点「重新检测」。'
                    : '先把要录制的窗口切到前台，再点「重新检测」。'
                }
                actions={<Button size="sm" icon="refresh" onClick={() => void loadAll()}>重新检测</Button>}
              />
            ) : (
              <div className="source-grid">
                {filteredSources.map((source) => (
                  <button
                    key={source.id}
                    type="button"
                    className={cn(
                      'source-card',
                      config.sourceId === source.id && 'is-selected',
                      !source.available && 'is-unavailable',
                    )}
                    aria-pressed={config.sourceId === source.id}
                    aria-label={`${source.name} ${source.width}×${source.height}${source.available ? '' : '（不可用）'}`}
                    disabled={!source.available}
                    onClick={() => updateConfig({ sourceId: source.id, sourceKind: source.kind })}
                    title={source.available ? source.name : `${source.name} · 受系统保护或已关闭`}
                  >
                    <span className="source-thumb">
                      {source.thumbnail ? (
                        <img src={source.thumbnail} alt="" />
                      ) : (
                        <span className="source-thumb-empty">
                          <Icon name={source.kind === 'screen' ? 'screen' : 'window'} size={22} />
                        </span>
                      )}
                      <span className="source-thumb-badge">
                        {source.kind === 'screen' ? <Badge tone="neutral">显示器</Badge> : <Badge tone="neutral">窗口</Badge>}
                        {!source.available && <Badge tone="danger">不可用</Badge>}
                      </span>
                    </span>
                    <span className="source-name">{source.name}</span>
                    <span className="source-res">
                      <Icon name="screen" size={10} />
                      {source.width} × {source.height}
                      {source.kind === 'screen' && displays.find((d) => d.id === source.displayId)?.scaleFactor !== 1 && (
                        <span style={{ color: 'var(--text-dim)' }}>
                          · {displays.find((d) => d.id === source.displayId)?.scaleFactor}× 缩放
                        </span>
                      )}
                    </span>
                    {config.sourceId === source.id && (
                      <span className="source-selected-mark" aria-hidden="true">
                        <Icon name="check" size={11} />
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
            {sourcePixelHint && (
              <div style={{ marginTop: 10 }}>
                <InlineNote tone="warn">{sourcePixelHint}</InlineNote>
              </div>
            )}
            {sourceKind === 'window' && <div style={{ marginTop: 10 }}>
              <InlineNote tone="info">窗口兼容采集支持移动和调整大小；最小化会中断采集，受保护或部分 GPU 窗口可能无法捕获。系统声音录制来自整台电脑。</InlineNote>
            </div>}
          </Panel>

          <Panel title="采集方式" icon="settings">
            <Select ariaLabel="采集方式" value={config.backend ?? 'auto'} onChange={next => updateConfig({ backend: next as 'auto' | 'wgc' | 'compatibility' })}
              options={[{ value: 'auto', label: '自动：优先现代采集，失败后兼容回退' }, { value: 'wgc', label: '现代采集 · Chromium / WGC' }, { value: 'compatibility', label: '兼容采集 · GDI / PrintWindow' }]} />
          </Panel>
          {/* ---- 录制区域（R01）：只在整屏来源上可用 ---- */}
          {selectedSource?.kind === 'screen' && (
            <Panel
              title="录制区域"
              icon="image"
              subtitle={regionEnabled ? `自定义区域 ${region.width} × ${region.height}` : '整屏录制'}
              actions={
                <Toggle
                  checked={regionEnabled}
                  onChange={(next) => {
                    setRegionEnabled(next);
                    if (next) {
                      const w = Math.max(320, Math.floor((selectedSource.width * 0.6) / 2) * 2);
                      const h = Math.max(240, Math.floor((selectedSource.height * 0.6) / 2) * 2);
                      updateConfig({
                        region: {
                          x: Math.floor((selectedSource.width - w) / 4) * 2,
                          y: Math.floor((selectedSource.height - h) / 4) * 2,
                          width: w,
                          height: h,
                        },
                      });
                    } else {
                      updateConfig({ region: undefined });
                    }
                  }}
                  label={regionEnabled ? '自定义区域' : '整屏'}
                />
              }
            >
              {regionEnabled ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
                    {(
                      [
                        { key: 'x', label: 'X 偏移', min: 0, max: Math.max(0, selectedSource.width - 64) },
                        { key: 'y', label: 'Y 偏移', min: 0, max: Math.max(0, selectedSource.height - 64) },
                        { key: 'width', label: '宽度', min: 64, max: selectedSource.width },
                        { key: 'height', label: '高度', min: 64, max: selectedSource.height },
                      ] as const
                    ).map((item) => (
                      <Field key={item.key} label={item.label}>
                        <NumberDraftInput
                          label={item.label}
                          min={item.min}
                          max={item.max}
                          step={2}
                          value={region[item.key]}
                          onCommit={(next) =>
                            updateRegion({ [item.key]: next } as Partial<typeof region>)
                          }
                        />
                      </Field>
                    ))}
                  </div>
                  <InlineNote tone={regionValid ? 'info' : 'warn'}>
                    {regionValid
                      ? `输出尺寸就是 ${region.width} × ${region.height} 物理像素，所见即所得，不做二次缩放。`
                      : '区域必须完整落在选定显示器内且不小于 64×64；超出部分会被自动裁掉。'}
                  </InlineNote>
                </div>
              ) : (
                <p style={{ color: 'var(--text-dim)', margin: 0 }}>
                  将录制整个显示器（
                  {selectedSource ? `${selectedSource.width} × ${selectedSource.height}` : '—'}）。打开「自定义区域」可只录屏幕上的一块。
                </p>
              )}
            </Panel>
          )}

          {/* ---- 预览 + 声音 ---- */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.35fr) minmax(0, 1fr)', gap: 14 }}>
            <Panel title="预览" icon="eye" subtitle={selectedSource ? selectedSource.name : '未选择来源'}>
              <div style={{ position: 'relative', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border-strong)', background: '#070a0e' }}>
                <canvas ref={previewRef} width={640} height={360} style={{ width: '100%', display: 'block' }} />
                <div style={{ position: 'absolute', left: 8, top: 8, display: 'flex', gap: 5 }}>
                  <Badge tone="accent" icon="record">
                    {apiMode === 'mock' ? '示例预览' : '来源快照 · 点击刷新更新'}
                  </Badge>
                  {selectedSource && <Badge tone="neutral">{`${selectedSource.width} × ${selectedSource.height}`}</Badge>}
                </div>
                <div style={{ position: 'absolute', right: 8, bottom: 8, display: 'flex', gap: 5 }}>
                  <Badge tone="neutral" icon="mic">{config.microphoneEnabled ? '麦克风开' : '麦克风关'}</Badge>
                  <Badge tone="neutral" icon="volume">{config.systemAudioEnabled ? '系统声音开' : '系统声音关'}</Badge>
                  <Badge tone="neutral" icon="camera">{config.cameraEnabled ? '摄像头开' : '摄像头关'}</Badge>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 9, flexWrap: 'wrap' }}>
                <Button size="sm" variant="ghost" icon="screen" onClick={() => void loadAll()}>
                  刷新缩略图
                </Button>
                <Button size="sm" variant="ghost" icon="info" onClick={() => setView('settings')}>
                  采集能力检测
                </Button>
              </div>
            </Panel>

            <Panel title="声音" icon="mic" subtitle={capture ? '实时电平' : apiMode === 'mock' ? '示例电平' : '开始录制后显示电平'}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Toggle
                  checked={config.microphoneEnabled}
                  onChange={(next) => updateConfig({ microphoneEnabled: next })}
                  label="麦克风"
                  description="录制你的讲解声音"
                />
                <LevelMeter
                  label="麦克风输入"
                  icon="mic"
                  tone="mic"
                  level={levels.mic}
                  hint={config.microphoneEnabled ? '正常说话时电平应在 -18 dB 到 -6 dB 之间。' : '麦克风已关闭，不会写入音轨。'}
                />
                <Field label="输入设备" htmlFor="mic-device">
                  <Select
                    id="mic-device"
                    ariaLabel="麦克风设备"
                    value={config.microphoneDeviceId ?? ''}
                    onChange={(next) => updateConfig({ microphoneDeviceId: next })}
                    options={[
                      { value: '', label: '系统默认输入' },
                      ...audioDevices
                        .filter((d) => d.kind === 'audioinput')
                        .map((d) => ({ value: d.deviceId, label: `${d.label}${d.isDefault ? '（默认）' : ''}` })),
                    ]}
                  />
                </Field>
                <div style={{ height: 1, background: 'var(--border)' }} />
                <Toggle
                  checked={config.systemAudioEnabled}
                  onChange={(next) => updateConfig({ systemAudioEnabled: next })}
                  label="系统声音"
                  description="录制应用播放的声音（需 Windows 回环采集）"
                />
                <LevelMeter
                  label="系统声音"
                  icon="volume"
                  tone="system"
                  level={levels.system}
                  hint={
                    system && !system.captureCapabilities.systemAudio
                      ? '当前系统不支持回环采集，导出时该音轨会为空。'
                      : '录制中会显示真实电平；此处为设备就绪指示。'
                  }
                />
              </div>
            </Panel>
          </div>

          {/* ---- 摄像头 ---- */}
          <Panel
            title="摄像头"
            icon="camera"
            subtitle={config.cameraEnabled ? apiMode === 'mock' ? '示例画面' : '实时取景' : '已关闭'}
          >
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.6fr)', gap: 14 }}>
              <div>
                <div className="camera-preview">
                  {config.cameraEnabled ? (
                    <>
                      <canvas ref={cameraRef} width={480} height={360} aria-label="摄像头实时预览" />
                      <div className="camera-preview-overlay">
                        {/* 这里是合成示意画面：真开摄像头会占用设备，录制时独立采集窗口就打不开了 */}
                        <Badge tone={cameraPreviewError ? 'warn' : 'neutral'} icon="camera">{apiMode === 'mock' ? '示例画面' : cameraPreviewError ? '摄像头不可用' : '实时取景'}</Badge>
                      </div>
                    </>
                  ) : (
                    <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: 'var(--text-dim)' }}>
                      <div style={{ textAlign: 'center' }}>
                        <Icon name="eyeOff" size={22} />
                        <div style={{ fontSize: 'var(--fs-aux)', marginTop: 6 }}>摄像头已关闭</div>
                      </div>
                    </div>
                  )}
                </div>
                <p className="wcs-field-hint" style={{ marginTop: 8 }}>
                  {apiMode === 'mock' ? '示例模式使用合成画面。' : cameraPreviewError ?? '预览与录制共用同一摄像头连接，关闭开关或离开页面后释放预览。'}
                </p>
              </div>
              <div>
                <Toggle
                  checked={config.cameraEnabled}
                  onChange={(next) => updateConfig({ cameraEnabled: next })}
                  label="录制摄像头画中画"
                  description="录制后在编辑器里可调整位置、大小与圆角"
                />
                <Field label="摄像头设备" htmlFor="cam-device" hint={videoDevices.length === 0 ? '未检测到摄像头设备' : undefined}>
                  <Select
                    id="cam-device"
                    ariaLabel="摄像头设备"
                    value={config.cameraDeviceId ?? ''}
                    onChange={(next) => updateConfig({ cameraDeviceId: next })}
                    options={[
                      { value: '', label: '系统默认摄像头' },
                      ...videoDevices.map((d) => ({ value: d.deviceId, label: d.label })),
                    ]}
                  />
                </Field>
                {devicesError && <InlineNote tone="warn">{devicesError}</InlineNote>}
                {cameraDegradation && (
                  <InlineNote tone="warn">
                    <strong>摄像头已降级，录制仍在继续：</strong> {cameraDegradation}
                  </InlineNote>
                )}
                {videoDevices.length === 0 && !devicesError && (
                  <InlineNote tone="warn">
                    没有检测到摄像头（或摄像头权限未授予）。可以继续录制屏幕与声音，之后在编辑器里关闭画中画。
                    <div style={{ marginTop: 6 }}>
                      <Button size="sm" variant="ghost" icon="refresh" onClick={() => void refreshVideoDevices()}>
                        重新检测摄像头
                      </Button>
                    </div>
                  </InlineNote>
                )}
              </div>
            </div>
          </Panel>

          {/* ---- 质量 ---- */}
          <Panel title="质量档位" icon="layers" subtitle="设置值与实际能力分开显示">
            <div className="quality-list">
              {profiles.map((profile) => {
                const selected = profile.id === config.qualityId;
                // 区域录制时输出尺寸是区域大小，不是整屏来源大小
                const actualWidth = regionEnabled && selectedSource ? region.width : selectedSource?.width;
                const downgraded = actualWidth != null ? actualWidth < profile.width : false;
                return (
                  <button
                    key={profile.id}
                    type="button"
                    className={cn('quality-card', selected && 'is-selected')}
                    aria-pressed={selected}
                    onClick={() => {
                      updateConfig({ qualityId: profile.id, fps: { num: profile.fps, den: 1 } });
                    }}
                  >
                    <span className="quality-radio" aria-hidden="true" />
                    <span>
                      <span className="quality-label">{profile.label}</span>
                      <span className="quality-detail">
                        {profile.width}×{profile.height} · {profile.fps}fps · 视频 {formatBitrate(profile.videoBitrate)} · 音频{' '}
                        {formatBitrate(profile.audioBitrate)}
                      </span>
                    </span>
                    <span className="quality-fit">
                      {profile.hardwarePreferred && system?.hardwareEncoding ? (
                        <Badge tone="ok">硬件编码</Badge>
                      ) : (
                        <Badge tone="muted">软件编码</Badge>
                      )}
                      {downgraded && <Badge tone="warn">受源限制</Badge>}
                    </span>
                  </button>
                );
              })}
            </div>

            <div style={{ marginTop: 11 }}>
              <table className="capability-table">
                <thead>
                  <tr>
                    <th>项目</th>
                    <th>设置</th>
                    <th style={{ textAlign: 'right' }}>实际能力</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>分辨率</td>
                    <td>{quality.width} × {quality.height}</td>
                    <td>{effectiveResolution}</td>
                  </tr>
                  <tr>
                    <td>帧率</td>
                    <td>{quality.fps} fps</td>
                    <td>{capture?.effective ? `${capture.effective.fps} fps` : '开始录制后确认'}</td>
                  </tr>
                  <tr>
                    <td>视频编码</td>
                    <td>{quality.hardwarePreferred ? '优先硬件' : '软件'}</td>
                    <td>{capture?.effective?.videoCodec ?? (system?.hardwareEncoding ? 'H.264 硬件可用' : 'H.264 软件')}</td>
                  </tr>
                  <tr>
                    <td>音频编码</td>
                    <td>{formatBitrate(quality.audioBitrate)}</td>
                    <td>{capture?.effective?.audioCodec ?? 'AAC 48 kHz'}</td>
                  </tr>
                </tbody>
              </table>
              {capture?.degradation && (
                <div style={{ marginTop: 9 }}>
                  <InlineNote tone="warn">
                    <strong>实际生效与设置不一致：</strong> {capture.degradation}
                  </InlineNote>
                </div>
              )}
            </div>
          </Panel>
        </div>

        {/* ---- 右栏 ---- */}
        <div className="side-stack">
          <Panel title="磁盘与时长" icon="disk">
            <div className="disk-row">
              <span>可用空间</span>
              <strong>{freeBytes == null ? '读取中…' : formatBytes(freeBytes)}</strong>
            </div>
            <div className="disk-row">
              <span>写入速率</span>
              <strong>{formatBytes(bps)}/s</strong>
            </div>
            <div className="disk-row">
              <span>预计可录</span>
              <strong style={{ color: diskInsufficient ? 'var(--danger)' : diskTight ? 'var(--warn)' : 'var(--ok)' }}>
                {freeBytes == null ? '—' : formatDurationLong(recordable)}
              </strong>
            </div>
            <div className="disk-row">
              <span>输出目录</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-aux)', color: 'var(--text-dim)', textAlign: 'right', wordBreak: 'break-all' }}>
                {system?.videosPath ?? '—'}
              </span>
            </div>
            {diskInsufficient && (
              <div style={{ marginTop: 8 }}>
                <InlineNote tone="danger">
                  可用空间不足 {formatBytes(MIN_FREE_BYTES)}。请清理磁盘或把输出目录换到空间更大的盘。
                </InlineNote>
              </div>
            )}
            {!diskInsufficient && diskTight && (
              <div style={{ marginTop: 8 }}>
                <InlineNote tone="warn">空间偏紧，长录制可能中途因磁盘写满而中断。建议先清理或换目录。</InlineNote>
              </div>
            )}
            <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
              <Button size="sm" variant="ghost" icon="refresh" onClick={() => void checkDisk()}>
                重新检查
              </Button>
              <Button size="sm" variant="ghost" icon="folder" onClick={() => void openOutputDir()}>
                打开输出目录
              </Button>
            </div>
            <p className="wcs-field-hint" style={{ marginTop: 8 }}>
              录制产物固定保存在系统「视频」目录（工程目录），导出时可以另存到别处；
              空间不足时请清理该目录或换一块盘的视频目录。
            </p>
          </Panel>

          <Panel title="录制选项" icon="settings">
            <Field label="倒计时" hint="开始后给出准备时间，可用 Esc 取消">
              <Segmented
                size="sm"
                ariaLabel="倒计时秒数"
                value={String(config.countdownSeconds)}
                onChange={(next) => updateConfig({ countdownSeconds: Number(next) })}
                options={[
                  { value: '0', label: '立即' },
                  { value: '3', label: '3 秒' },
                  { value: '5', label: '5 秒' },
                ]}
              />
            </Field>
            <InlineNote tone="info">
              设备开关只在左侧「声音」「摄像头」面板各有一处。右边不再重复，避免同一项出现两个开关。
            </InlineNote>
          </Panel>

          <Panel title="开始前检查" icon="shield" subtitle="状态一览">
            <div className="check-chips">
              <span className={cn('check-chip', selectedSource?.available ? 'is-ok' : selectedSource ? 'is-warn' : 'is-warn')}>
                <Icon name={selectedSource?.available ? 'check' : 'warning'} size={12} />
                来源 {selectedSource ? (selectedSource.available ? '可用' : '不可用') : '未选择'}
              </span>
              <span className={cn('check-chip', config.microphoneEnabled ? 'is-ok' : 'is-off')}>
                <Icon name="mic" size={12} />
                麦克风 {config.microphoneEnabled ? '开' : '关'}
              </span>
              <span className={cn('check-chip', config.systemAudioEnabled ? 'is-ok' : 'is-off')}>
                <Icon name="volume" size={12} />
                系统声音 {config.systemAudioEnabled ? '开' : '关'}
              </span>
              <span className={cn('check-chip', config.cameraEnabled ? 'is-ok' : 'is-off')}>
                <Icon name="camera" size={12} />
                摄像头 {config.cameraEnabled ? '开' : '关'}
              </span>
              <span className={cn('check-chip', diskInsufficient ? 'is-danger' : pathCheck && !pathCheck.writable ? 'is-danger' : 'is-ok')}>
                <Icon name="disk" size={12} />
                磁盘 {diskInsufficient ? '不足' : pathCheck ? (pathCheck.writable ? '可写' : '不可写') : '检查中'}
              </span>
              <span className={cn('check-chip', system?.hardwareEncoding ? 'is-ok' : 'is-off')}>
                <Icon name="layers" size={12} />
                {system?.hardwareEncoding ? '硬件编码' : '软件编码'}
              </span>
            </div>
            <div style={{ marginTop: 12 }}>
              {/* 开始/停止只保留顶部一处主操作（§P0：一次操作即看清状态，不必滚动找按钮） */}
              <div className="check-hint">
                {blockedReason ? (
                  <InlineNote tone="warn">{blockedReason}</InlineNote>
                ) : starting ? (
                  <span className="check-hint-text">
                    <Spinner size={13} /> 正在启动采集窗口，准备完成后开始写入画面与声音…
                  </span>
                ) : (
                  <span className="check-hint-text">
                    <Icon name="check" size={13} />{' '}
                    {config.countdownSeconds > 0
                      ? `全部就绪，点右上角「开始录制」即可（${config.countdownSeconds} 秒倒计时）。`
                      : '全部就绪，点右上角「开始录制」立即开始采集。'}
                  </span>
                )}
              </div>
            </div>
          </Panel>

          {apiMode === 'mock' && (
            <InlineNote tone="warn">
              <strong>示例数据模式：</strong> 设备列表与预览来自内置合成画面，不会真正采集屏幕。
            </InlineNote>
          )}
        </div>
      </div>

      {/* ---- 倒计时覆盖层 ---- */}
      {countdown !== null && (
        <div className="countdown-overlay" role="dialog" aria-modal="true" aria-label="录制倒计时">
          <div className="countdown-box">
            <div className="countdown-num" aria-live="assertive">
              {countdown}
            </div>
            <div className="countdown-hint">准备开始录制 · {selectedSource?.name ?? '未选择来源'}</div>
            <div className="countdown-sub">
              {quality.width} × {quality.height} · {quality.fps}fps · {config.countdownSeconds} 秒倒计时
            </div>
            <div style={{ marginTop: 22 }}>
              <Button size="lg" variant="secondary" icon="close" onClick={cancelCountdown}>
                取消（Esc）
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function describeSafe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

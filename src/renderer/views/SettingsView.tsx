/**
 * 设置页：设备与能力、快捷键、诊断与数据目录
 */

import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../lib/store';
import { Badge, Button, Field, InlineNote, Kbd, Panel, Select, Toggle } from '../components/ui';
import { formatBytes, formatDateTime, unwrap } from '../lib/format';
import { wcs, withTimeout, IPC_TIMEOUT } from '../lib/wcs';
import { loadSettings, saveSettings } from '../lib/settings';
import type { DiagnosticsReport } from '@shared/api';

const SHORTCUTS: { group: string; items: { keys: string[]; label: string }[] }[] = [
  {
    group: '录制',
    items: [
      { keys: ['Ctrl', 'Alt', 'R'], label: '开始 / 停止录制' },
      { keys: ['Ctrl', 'Alt', 'P'], label: '暂停 / 继续' },
      { keys: ['Ctrl', 'Alt', 'M'], label: '添加标记' },
    ],
  },
  {
    group: '编辑',
    items: [
      { keys: ['Space'], label: '播放 / 暂停' },
      { keys: ['←', '→'], label: '上一帧 / 下一帧' },
      { keys: ['Shift', '←/→'], label: '后退 / 前进 1 秒' },
      { keys: ['Ctrl', 'B'], label: '在播放头分割' },
      { keys: ['Ctrl', 'C/V'], label: '复制 / 粘贴所选效果' },
      { keys: ['Ctrl', 'Shift', 'V'], label: '只粘贴效果属性' },
      { keys: ['Delete'], label: '删除所选（时间线片段 / 效果 / 步骤）' },
      { keys: ['Ctrl', 'Z'], label: '撤销' },
      { keys: ['Ctrl', 'Y'], label: '重做' },
      { keys: ['Ctrl', 'S'], label: '保存工程' },
      { keys: ['Home', 'End'], label: '跳到开头 / 结尾' },
      { keys: ['Esc'], label: '取消选择 / 退出输入' },
    ],
  },
  {
    group: '界面',
    items: [{ keys: ['Ctrl', '1–6'], label: '切换视图（首页 / 录制 / 编辑器 / 导出 / 教程 / 设置）' }],
  },
];

export function SettingsView() {
  const {
    systemInfo,
    refreshSystemInfo,
    apiMode,
    config,
    updateConfig,
    pushToast,
    pushError,
    setView,
    refreshRecents,
    refreshRecoverables,
  } = useApp();
  const [diagnostics, setDiagnostics] = useState<DiagnosticsReport | null>(null);
  const [diagnosedAt, setDiagnosedAt] = useState<number | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  // 置顶是窗口状态，但用户期望重启后保留：本地设置在这里只用于显示，
  // 真正的「启动即恢复」由 store 的启动流程执行（不依赖用户是否打开过设置页）。
  const [alwaysOnTop, setAlwaysOnTop] = useState(() => loadSettings().alwaysOnTop);

  const changeAlwaysOnTop = useCallback(
    async (next: boolean) => {
      setAlwaysOnTop(next); // 乐观更新
      try {
        const response = await withTimeout(wcs().setAlwaysOnTop(next), 8000, '设置窗口置顶');
        if (!response.ok) throw new Error(response.error?.message ?? '主进程拒绝了置顶设置');
        saveSettings({ alwaysOnTop: next });
      } catch (error) {
        // 回滚，避免开关显示的状态与真实窗口状态不一致
        setAlwaysOnTop(!next);
        pushError(error, '置顶设置未生效');
      }
    },
    [pushError],
  );

  const openManagedPath = useCallback(
    async (path: string, title: string) => {
      try {
        unwrap(await wcs().openPath(path));
      } catch (error) {
        pushError(error, title);
      }
    },
    [pushError],
  );

  const revealManagedPath = useCallback(
    async (path: string) => {
      try {
        unwrap(await wcs().showInFolder(path));
      } catch (error) {
        pushError(error, '打开所在文件夹失败');
      }
    },
    [pushError],
  );

  const runDiagnostics = useCallback(async () => {
    setDiagnosing(true);
    try {
      const report = unwrap(await withTimeout(wcs().writeDiagnostics(), IPC_TIMEOUT.diagnostics, '导出诊断日志'));
      setDiagnostics(report);
      setDiagnosedAt(Date.now());
      pushToast({ tone: 'ok', title: '诊断日志已导出', message: `${formatBytes(report.bytes)} · ${report.entries.length} 个文件` });
    } catch (error) {
      pushError(error, '导出诊断日志失败');
    } finally {
      setDiagnosing(false);
    }
  }, [pushError, pushToast]);

  const capabilities = systemInfo?.captureCapabilities;

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1>设置</h1>
          <p>设备能力、快捷键、诊断与数据目录。修改会立即生效并保存在本机。</p>
        </div>
        <div className="view-actions">
          <Button
            size="sm"
            variant="ghost"
            icon="refresh"
            onClick={() => {
              void refreshRecents();
              void refreshRecoverables();
              void refreshSystemInfo();
            }}
          >
            刷新数据
          </Button>
        </div>
      </div>

      <div className="settings-grid">
        <Panel title="系统信息" icon="info">
          {systemInfo ? (
            <div className="kv-list">
              <div className="kv-row">
                <span className="kv-key">系统</span>
                <span className="kv-value">{systemInfo.osVersion}</span>
              </div>
              <div className="kv-row">
                <span className="kv-key">架构</span>
                <span className="kv-value">{systemInfo.platform} / {systemInfo.arch}</span>
              </div>
              <div className="kv-row">
                <span className="kv-key">Electron</span>
                <span className="kv-value">{systemInfo.electronVersion}</span>
              </div>
              <div className="kv-row">
                <span className="kv-key">Chromium</span>
                <span className="kv-value">{systemInfo.chromeVersion}</span>
              </div>
              <div className="kv-row">
                <span className="kv-key">应用版本</span>
                <span className="kv-value">{systemInfo.appVersion}</span>
              </div>
              <div className="kv-row">
                <span className="kv-key">内存</span>
                <span className="kv-value">
                  可用 {formatBytes(systemInfo.freeMemoryBytes)} / 共 {formatBytes(systemInfo.totalMemoryBytes)}
                </span>
              </div>
              <div className="kv-row">
                <span className="kv-key">数据目录</span>
                <span className="kv-value" title={systemInfo.userDataPath}>{systemInfo.userDataPath}</span>
              </div>
              <div className="kv-row">
                <span className="kv-key">输出目录</span>
                <span className="kv-value" title={systemInfo.videosPath}>{systemInfo.videosPath}</span>
              </div>
            </div>
          ) : (
            <div className="wcs-empty">
              <p>正在读取系统信息…</p>
            </div>
          )}
          <div style={{ marginTop: 10 }}>
            <Badge tone={apiMode === 'native' ? 'ok' : 'warn'}>
              {apiMode === 'native' ? '主进程已连接（真实采集可用）' : '示例数据模式（未连接主进程）'}
            </Badge>
          </div>
        </Panel>

        <Panel title="采集能力" icon="shield" subtitle="按当前系统实际探测">
          {capabilities ? (
            <div className="kv-list">
              {[
                { key: '屏幕采集', value: capabilities.screen },
                { key: '窗口采集', value: capabilities.window },
                { key: '系统声音（回环）', value: capabilities.systemAudio },
                { key: '麦克风', value: capabilities.microphone },
                { key: '摄像头', value: capabilities.camera },
                { key: '应用声音（P1）', value: capabilities.applicationAudio },
              ].map((item) => (
                <div key={item.key} className="kv-row">
                  <span className="kv-key">{item.key}</span>
                  <span className="kv-value">
                    {item.value ? <Badge tone="ok" icon="check">支持</Badge> : <Badge tone="warn" icon="warning">不可用</Badge>}
                  </span>
                </div>
              ))}
              <div className="kv-row">
                <span className="kv-key">硬件编码</span>
                <span className="kv-value">
                  {systemInfo?.hardwareEncoding ? <Badge tone="ok">可用</Badge> : <Badge tone="warn">不可用</Badge>}
                </span>
              </div>
            </div>
          ) : (
            <div className="wcs-empty">
              <p>暂无能力信息。</p>
            </div>
          )}
          <div style={{ marginTop: 10 }}>
            <InlineNote tone="info">
              应用自己的控制窗口可申请排除采集；检查失败时会显示明确状态，不会默认为已排除。
            </InlineNote>
          </div>
        </Panel>

        <Panel title="录制默认值" icon="record">
          <Field label="默认质量档位" htmlFor="default-quality">
            <Select
              id="default-quality"
              ariaLabel="默认质量档位"
              value={config.qualityId}
              onChange={(next) => updateConfig({ qualityId: next })}
              options={[
                { value: '1080p60', label: '1080p · 60 帧' },
                { value: '1080p30', label: '1080p · 30 帧' },
                { value: '720p30', label: '720p · 30 帧' },
              ]}
            />
          </Field>
          <Field label="默认倒计时" htmlFor="default-countdown">
            <Select
              id="default-countdown"
              ariaLabel="默认倒计时"
              value={String(config.countdownSeconds)}
              onChange={(next) => updateConfig({ countdownSeconds: Number(next) })}
              options={[
                { value: '0', label: '立即开始' },
                { value: '3', label: '3 秒' },
                { value: '5', label: '5 秒' },
              ]}
            />
          </Field>
          <Toggle
            checked={config.systemAudioEnabled}
            onChange={(next) => updateConfig({ systemAudioEnabled: next })}
            label="默认录制系统声音"
          />
          <Toggle
            checked={config.microphoneEnabled}
            onChange={(next) => updateConfig({ microphoneEnabled: next })}
            label="默认录制麦克风"
          />
          <Toggle checked={config.cameraEnabled} onChange={(next) => updateConfig({ cameraEnabled: next })} label="默认录制摄像头" />
        </Panel>

        <Panel title="窗口" icon="window">
          <Toggle
            checked={alwaysOnTop}
            onChange={(next) => void changeAlwaysOnTop(next)}
            label="主窗口置顶"
            description="录制讲解时便于随时暂停或标记；重启应用后保留"
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            <Button size="sm" icon="minimize" onClick={() => void wcs().minimize()}>
              最小化
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon="folder"
              disabled={!systemInfo?.videosPath}
              onClick={() => {
                if (systemInfo?.videosPath) void openManagedPath(systemInfo.videosPath, '打开输出目录失败');
              }}
            >
              打开输出目录
            </Button>
          </div>
          <p className="wcs-field-hint" style={{ marginTop: 8 }}>
            导出默认保存到 <code>{systemInfo?.videosPath ?? '（读取中…）'}</code>；悬浮控制条会在录制开始时出现。
          </p>
        </Panel>

        <Panel title="诊断与数据" icon="disk">
          <div className="kv-list">
            <div className="kv-row">
              <span className="kv-key">最近诊断</span>
              <span className="kv-value">{diagnostics && diagnosedAt ? formatDateTime(diagnosedAt) : '尚未导出'}</span>
            </div>
            {diagnostics && (
              <>
                <div className="kv-row">
                  <span className="kv-key">文件</span>
                  <span className="kv-value" title={diagnostics.path}>{diagnostics.path}</span>
                </div>
                <div className="kv-row">
                  <span className="kv-key">大小</span>
                  <span className="kv-value">{formatBytes(diagnostics.bytes)}</span>
                </div>
                <div className="kv-row">
                  <span className="kv-key">内容</span>
                  <span className="kv-value">{diagnostics.entries.join(' · ')}</span>
                </div>
              </>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            <Button size="sm" icon="save" loading={diagnosing} onClick={() => void runDiagnostics()}>
              导出诊断日志
            </Button>
            {diagnostics && (
              <>
                <Button size="sm" variant="ghost" icon="folder" onClick={() => void revealManagedPath(diagnostics.path)}>
                  打开所在文件夹
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="external"
                  onClick={() => void openManagedPath(diagnostics.path, '打开诊断文件失败')}
                >
                  打开文件
                </Button>
              </>
            )}
          </div>
          <p className="wcs-field-hint" style={{ marginTop: 8 }}>
            诊断日志包含系统信息、采集日志与工程摘要，不包含录制的画面内容。排查问题时附上即可。
          </p>
        </Panel>

        <Panel title="快捷键" icon="settings" subtitle="输入框获得焦点时，剪辑快捷键不会抢走文字输入">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {SHORTCUTS.map((group) => (
              <div key={group.group}>
                <div className="inspector-section-head" style={{ marginBottom: 4 }}>
                  <h3>{group.group}</h3>
                </div>
                <table className="shortcut-table">
                  <tbody>
                    {group.items.map((item) => (
                      <tr key={item.label}>
                        <td>{item.label}</td>
                        <td>
                          <span className="shortcut-keys">
                            {item.keys.map((key, index) => (
                              <Kbd key={`${item.label}-${key}-${index}`}>{key}</Kbd>
                            ))}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 10 }}>
            <InlineNote tone="info">
              全局录制快捷键由系统注册，若与其它软件冲突会提示；编辑快捷键仅在应用内生效。
            </InlineNote>
          </div>
        </Panel>

        <Panel title="隐私与数据" icon="shield">
          <div className="kv-list">
            <div className="kv-row">
              <span className="kv-key">录制数据</span>
              <span className="kv-value">仅保存在本机工程目录</span>
            </div>
            <div className="kv-row">
              <span className="kv-key">标记备注</span>
              <span className="kv-value">仅本机显示，不随视频导出</span>
            </div>
            <div className="kv-row">
              <span className="kv-key">网络</span>
              <span className="kv-value">不联网，不上传任何内容</span>
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <InlineNote tone="info">
              遮挡区域按「源坐标」记录，换画幅后仍跟随内容位置。未确认的遮挡不会被当作已遮挡。
            </InlineNote>
          </div>
          <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Button size="sm" variant="ghost" icon="shield" onClick={() => setView('editor')}>
              去检查遮挡
            </Button>
            <Button size="sm" variant="ghost" icon="book" onClick={() => setView('tutorial')}>
              去编辑教程
            </Button>
          </div>
        </Panel>
      </div>
    </div>
  );
}

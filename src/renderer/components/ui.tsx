/**
 * 界面基础组件（手写样式，不依赖 UI 框架）
 *
 * 约定：
 * - 所有交互元素都有可读名称（aria-label / 文本）与可见焦点样式。
 * - 状态一律「文字 + 图标 + 形状」共同表达，不只依赖颜色（§6.4）。
 */

import {
  Component,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ErrorInfo,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { clamp, cn } from '../lib/format';

// ---------------------------------------------------------------------------
// 图标
// ---------------------------------------------------------------------------

const ICON_PATHS: Record<string, ReactNode> = {
  home: (
    <>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
      <path d="M9.5 21v-7h5v7" />
    </>
  ),
  record: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3.6" fill="currentColor" stroke="none" />
    </>
  ),
  editor: (
    <>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2.2" />
      <circle cx="10" cy="17" r="2.2" />
    </>
  ),
  export: (
    <>
      <path d="M12 3v11" />
      <path d="M7.5 10 12 14.5 16.5 10" />
      <path d="M4 20h16" />
    </>
  ),
  book: (
    <>
      <path d="M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2z" />
      <path d="M8 3v18" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M18.8 5.2l-2.1 2.1M7.3 16.7l-2.1 2.1" />
    </>
  ),
  play: <path d="M8 5.2 19 12 8 18.8z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect x="7" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none" />
      <rect x="13.4" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />,
  flag: (
    <>
      <path d="M5.5 21V3.5" />
      <path d="M5.5 4h11.2l-1.9 3.9 1.9 3.9H5.5" />
    </>
  ),
  undo: (
    <>
      <path d="M9.5 14.5 4 9l5.5-5.5" />
      <path d="M4 9h9.5a6 6 0 0 1 0 12H7" />
    </>
  ),
  redo: (
    <>
      <path d="M14.5 14.5 20 9l-5.5-5.5" />
      <path d="M20 9h-9.5a6 6 0 0 0 0 12H17" />
    </>
  ),
  save: (
    <>
      <path d="M5 3.5h11L19.5 7v13.5H5z" />
      <path d="M8.5 3.5v6h7v-6" />
      <path d="M8 14h8v6.5H8z" />
    </>
  ),
  split: (
    <>
      <path d="M6 3.5v17M18 3.5v17" />
      <path d="M12 3.5v4M12 16.5v4" />
    </>
  ),
  copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V3H3v13h5" /></>,
  paste: <><path d="M8 5H5v16h14V5h-3" /><rect x="8" y="3" width="8" height="4" rx="1" /><path d="M8 12h8M8 16h6" /></>,
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9.5 7V4h5v3" />
      <path d="M6.5 7 7.6 20.5h8.8L17.5 7" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  check: <path d="M4.5 12.5 9.5 17.5 20 6.5" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  warning: (
    <>
      <path d="M12 3.5 2.5 20.5h19z" />
      <path d="M12 9.5v5M12 18h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v6M12 7.6h.01" />
    </>
  ),
  folder: (
    <>
      <path d="M3.5 7.5h6l2 2h9v10h-17z" />
      <path d="M3.5 7.5V5h5l2 2" />
    </>
  ),
  crop: <><path d="M6 2v16h16M2 6h16v16" /><path d="M10 6h8v8" /></>,
  chevronDown: <path d="M6 9.5l6 6 6-6" />,
  chevronRight: <path d="M9.5 6l6 6-6 6" />,
  chevronLeft: <path d="M14.5 6l-6 6 6 6" />,
  minimize: <path d="M5 18h14" />,
  camera: (
    <>
      <rect x="3" y="6" width="13" height="12" rx="2.5" />
      <path d="M16 10.5 21 8v8l-5-2.5z" />
    </>
  ),
  mic: (
    <>
      <path d="M12 3.2a2.9 2.9 0 0 1 2.9 2.9v6a2.9 2.9 0 0 1-5.8 0v-6A2.9 2.9 0 0 1 12 3.2z" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
      <path d="M12 18v3.2" />
    </>
  ),
  volume: (
    <>
      <path d="M4 10v4h3l4 3.5v-11L7 10z" />
      <path d="M15 9.2a4 4 0 0 1 0 5.6M17.8 6.6a7.5 7.5 0 0 1 0 10.8" />
    </>
  ),
  screen: (
    <>
      <rect x="3" y="4" width="18" height="12.5" rx="2" />
      <path d="M8.5 20h7M12 16.5V20" />
    </>
  ),
  window: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 9.5h18" />
      <path d="M6.2 7.2h.01M8.6 7.2h.01" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5" />
    </>
  ),
  unlock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.2-1.6" />
    </>
  ),
  zoomIn: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M15.8 15.8 21 21M11 8.5v5M8.5 11h5" />
    </>
  ),
  zoomOut: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M15.8 15.8 21 21M8.5 11h5" />
    </>
  ),
  skipBack: (
    <>
      <path d="M18.5 19 9 12l9.5-7z" fill="currentColor" stroke="none" />
      <path d="M5 5v14" />
    </>
  ),
  skipForward: (
    <>
      <path d="M5.5 19 15 12 5.5 5z" fill="currentColor" stroke="none" />
      <path d="M19 5v14" />
    </>
  ),
  stepBack: (
    <>
      <path d="M13 18.5 6 12l7-6.5z" fill="currentColor" stroke="none" />
      <path d="M18 6v12" />
    </>
  ),
  stepForward: (
    <>
      <path d="M11 18.5 18 12l-7-6.5z" fill="currentColor" stroke="none" />
      <path d="M6 6v12" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11.5A8 8 0 1 0 17.8 17" />
      <path d="M20 5v6h-6" />
    </>
  ),
  disk: (
    <>
      <rect x="3.5" y="6" width="17" height="12" rx="2.5" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M6.5 18v2M17.5 18v2" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4l-8.5 8.5" />
      <path d="M18.5 14v6H4V5.5h6" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 20 6v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6z" />
      <path d="M8.8 12.2 11 14.4l4.2-4.4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3.2 2" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M4.5 17.5 10 12l3.2 3.2 2.6-2.4 4 4" />
    </>
  ),
  cursor: <path d="M6 3.5 19 12l-5.6 1.3L11 19z" />,
  layers: (
    <>
      <path d="M12 3.5 21 8l-9 4.5L3 8z" />
      <path d="M3 12.5 12 17l9-4.5" />
      <path d="M3 17 12 21.5 21 17" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
  merge: (
    <>
      <path d="M7 4v5a5 5 0 0 0 5 5h5" />
      <path d="M17 4v5a5 5 0 0 1-5 5H7" />
      <path d="M14.5 11.5 17.5 14 14.5 16.5" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M4 4l16 16" />
      <path d="M9.8 5.4A9.9 9.9 0 0 1 12 5.2c6 0 9.5 6.8 9.5 6.8a17 17 0 0 1-2.6 3.4" />
      <path d="M6.4 7.6A16.6 16.6 0 0 0 2.5 12S6 18.8 12 18.8c1.3 0 2.4-.3 3.4-.7" />
    </>
  ),
};

export type IconName = keyof typeof ICON_PATHS;

export function Icon({ name, size = 16, className }: { name: IconName | string; size?: number; className?: string }) {
  const content = ICON_PATHS[name] ?? ICON_PATHS.info;
  return (
    <svg
      className={cn('wcs-icon', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {content}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// 按钮
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName | string;
  trailingIcon?: IconName | string;
  block?: boolean;
  loading?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  trailingIcon,
  block,
  loading,
  children,
  className,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cn('wcs-btn', `is-${variant}`, `is-${size}`, block && 'is-block', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={size === 'lg' ? 16 : 13} /> : icon ? <Icon name={icon} size={size === 'lg' ? 17 : 14} /> : null}
      {children != null && <span className="wcs-btn-label">{children}</span>}
      {trailingIcon && <Icon name={trailingIcon} size={13} className="wcs-btn-trailing" />}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName | string;
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  active?: boolean;
}

export function IconButton({ icon, label, variant = 'ghost', size = 'md', active, className, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      className={cn('wcs-iconbtn', `is-${variant}`, `is-${size}`, active && 'is-active', className)}
      aria-label={label}
      title={label}
      aria-pressed={active === undefined ? undefined : active}
      {...rest}
    >
      <Icon name={icon} size={size === 'sm' ? 14 : size === 'lg' ? 20 : 16} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// 徽标 / 面板 / 字段
// ---------------------------------------------------------------------------

export function Badge({
  children,
  tone = 'neutral',
  icon,
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'muted';
  icon?: IconName | string;
  title?: string;
}) {
  return (
    <span className={cn('wcs-badge', `is-${tone}`)} title={title}>
      {icon && <Icon name={icon} size={11} />}
      {children}
    </span>
  );
}

export function Panel({
  title,
  subtitle,
  icon,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: IconName | string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn('wcs-panel', className)}>
      {(title || actions) && (
        <header className="wcs-panel-head">
          <div className="wcs-panel-title">
            {icon && <Icon name={icon} size={14} />}
            <h2>{title}</h2>
            {subtitle && <span className="wcs-panel-sub">{subtitle}</span>}
          </div>
          {actions && <div className="wcs-panel-actions">{actions}</div>}
        </header>
      )}
      <div className={cn('wcs-panel-body', bodyClassName)}>{children}</div>
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
  htmlFor,
  inline,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
  inline?: boolean;
}) {
  return (
    <div className={cn('wcs-field', inline && 'is-inline')}>
      <label className="wcs-field-label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="wcs-field-control">{children}</div>
      {hint && <p className="wcs-field-hint">{hint}</p>}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  const descId = `${id}-desc`;
  return (
    <div className={cn('wcs-toggle-row', disabled && 'is-disabled')}>
      <div className="wcs-toggle-text">
        <label htmlFor={id} className="wcs-toggle-label">
          {label}
        </label>
        {description && (
          <p className="wcs-toggle-desc" id={descId}>
            {description}
          </p>
        )}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={typeof label === 'string' ? label : undefined}
        aria-describedby={description ? descId : undefined}
        className={cn('wcs-switch', checked && 'is-on')}
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
      >
        <span className="wcs-switch-knob" />
      </button>
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = 'md',
}: {
  options: { value: T; label: ReactNode; icon?: IconName | string; title?: string }[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div className={cn('wcs-segmented', `is-${size}`)} role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={cn('wcs-segmented-item', value === option.value && 'is-active')}
          aria-pressed={value === option.value}
          title={option.title}
          onClick={() => onChange(option.value)}
        >
          {option.icon && <Icon name={option.icon} size={13} />}
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 滑杆：拖动时只更新本地显示，松手（pointerup / keyup / blur）才提交，
 * 避免一次拖动产生几十条撤销记录。
 */
export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onCommit,
  format,
  disabled,
  hint,
}: {
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (next: number) => void;
  format?: (value: number) => string;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  const [local, setLocal] = useState(value);
  const [dragging, setDragging] = useState(false);
  const id = useId();
  useEffect(() => {
    if (!dragging) setLocal(value);
  }, [value, dragging]);

  const commit = useCallback(
    (next: number) => {
      setDragging(false);
      setLocal(next);
      if (next !== value) onCommit(next);
    },
    [onCommit, value],
  );

  return (
    <div className={cn('wcs-slider', disabled && 'is-disabled')}>
      <div className="wcs-slider-head">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id}>{format ? format(local) : String(local)}</output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={local}
        disabled={disabled}
        aria-valuetext={format ? format(local) : String(local)}
        onChange={(event) => {
          setDragging(true);
          setLocal(Number(event.target.value));
        }}
        onPointerUp={(event) => commit(Number((event.target as HTMLInputElement).value))}
        onKeyUp={(event) => commit(Number((event.target as HTMLInputElement).value))}
        onBlur={(event) => commit(Number((event.target as HTMLInputElement).value))}
      />
      {hint && <p className="wcs-field-hint">{hint}</p>}
    </div>
  );
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn('wcs-input', className)} {...rest} />;
}

export function Select({
  value,
  onChange,
  options,
  ariaLabel,
  id,
}: {
  value: string;
  onChange: (next: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
  ariaLabel: string;
  id?: string;
}) {
  return (
    <select id={id} className="wcs-select" value={value} aria-label={ariaLabel} onChange={(e) => onChange(e.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// 电平表 / 进度 / 加载
// ---------------------------------------------------------------------------

const METER_SEGMENTS = 24;

/** 电平表：分段 + 峰值 + 数值，0 电平时明确显示「无信号」。 */
export function LevelMeter({
  label,
  level,
  icon,
  tone = 'mic',
  hint,
}: {
  label: string;
  level: number;
  icon?: IconName | string;
  tone?: 'mic' | 'system';
  hint?: string;
}) {
  const clamped = clamp(level, 0, 1);
  const db = clamped > 0 ? 20 * Math.log10(clamped) : -60;
  const active = Math.round(clamped * METER_SEGMENTS);
  const peak = useRef(0);
  const [peakHold, setPeakHold] = useState(0);
  useEffect(() => {
    if (clamped >= peak.current) {
      peak.current = clamped;
      setPeakHold(clamped);
    } else {
      peak.current = Math.max(clamped, peak.current - 0.02);
      setPeakHold(peak.current);
    }
  }, [clamped]);

  return (
    <div className={cn('wcs-meter', `is-${tone}`)}>
      <div className="wcs-meter-head">
        {icon && <Icon name={icon} size={13} />}
        <span className="wcs-meter-label">{label}</span>
        <span className="wcs-meter-value" aria-live="off">
          {clamped <= 0.001 ? '无信号' : `${db.toFixed(1)} dB`}
        </span>
      </div>
      <div
        className="wcs-meter-track"
        role="meter"
        aria-label={`${label} 电平`}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={Number(clamped.toFixed(2))}
        aria-valuetext={clamped <= 0.001 ? '无信号' : `${Math.round(clamped * 100)}%`}
      >
        {Array.from({ length: METER_SEGMENTS }, (_, index) => (
          <span
            key={index}
            className={cn('wcs-meter-seg', index < active && 'is-on', index >= METER_SEGMENTS - 3 && 'is-hot')}
          />
        ))}
        <span className="wcs-meter-peak" style={{ left: `${clamp(peakHold, 0, 1) * 100}%` }} />
      </div>
      {hint && <p className="wcs-field-hint">{hint}</p>}
    </div>
  );
}

export function ProgressBar({
  value,
  label,
  tone = 'accent',
  indeterminate,
}: {
  value: number;
  label: string;
  tone?: 'accent' | 'ok' | 'warn';
  indeterminate?: boolean;
}) {
  const pct = clamp(value, 0, 1) * 100;
  return (
    <div className={cn('wcs-progress', `is-${tone}`, indeterminate && 'is-indeterminate')}>
      <div
        className="wcs-progress-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : Math.round(pct)}
        aria-valuetext={indeterminate ? '处理中' : `${Math.round(pct)}%`}
      >
        <div className="wcs-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="wcs-progress-value">{indeterminate ? '处理中' : `${Math.round(pct)}%`}</span>
    </div>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="wcs-spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}

export function EmptyState({
  icon = 'info',
  title,
  description,
  actions,
}: {
  icon?: IconName | string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="wcs-empty">
      <span className="wcs-empty-icon">
        <Icon name={icon} size={22} />
      </span>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {actions && <div className="wcs-empty-actions">{actions}</div>}
    </div>
  );
}

export function InlineNote({ tone = 'info', children, icon }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; children: ReactNode; icon?: IconName | string }) {
  const fallback = tone === 'warn' || tone === 'danger' ? 'warning' : tone === 'ok' ? 'check' : 'info';
  return (
    <div className={cn('wcs-note', `is-${tone}`)} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon name={icon ?? fallback} size={14} />
      <div className="wcs-note-body">{children}</div>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="wcs-kbd">{children}</kbd>;
}

// ---------------------------------------------------------------------------
// 模态框
// ---------------------------------------------------------------------------

/**
 * 打开中的模态框栈：Esc 只关闭最上层，Tab 焦点陷阱只作用于最上层。
 * （用模块级数组而不是 DOM 查询，嵌套确认框也能正确处理。）
 */
const modalStack: symbol[] = [];

function focusableWithin(root: HTMLElement): HTMLElement[] {
  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  );
  return nodes.filter((node) => node.getClientRects().length > 0);
}

export function Modal({
  title,
  children,
  footer,
  onClose,
  width = 520,
  tone = 'default',
}: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  width?: number;
  tone?: 'default' | 'danger';
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  // 用 ref 保存最新 onClose：父组件通常传内联箭头函数，若放进 deps，
  // 每次父组件重渲染都会重建监听器并重新聚焦首元素，输入框会频繁失焦。
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const token = Symbol('wcs-modal');
    modalStack.push(token);
    const isTopmost = () => modalStack[modalStack.length - 1] === token;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const onKey = (event: KeyboardEvent) => {
      if (!isTopmost()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const root = ref.current;
      if (!root) return;
      const items = focusableWithin(root);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !root.contains(active)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);

    const root = ref.current;
    if (root) {
      // 初始焦点优先落在可输入的正文控件；否则落在页脚第一个按钮（通常是「取消」），
      // 避免危险确认框默认聚焦「删除」。
      const preferred =
        root.querySelector<HTMLElement>(
          '[autofocus], input:not([disabled]), textarea:not([disabled]), select:not([disabled])',
        ) ??
        root.querySelector<HTMLElement>('.wcs-modal-foot button:not([disabled])') ??
        focusableWithin(root)[0] ??
        root;
      preferred.focus();
    }

    // 背景滚动锁定：模态框打开期间页面不应跟着滚动
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey, true);
      const index = modalStack.indexOf(token);
      if (index >= 0) modalStack.splice(index, 1);
      document.body.style.overflow = previousOverflow;
      // 关闭后焦点回到触发元素，键盘用户可以继续原位置操作
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus();
    };
  }, []);

  return (
    <div
      className="wcs-modal-backdrop"
      onPointerDown={(event) => event.target === event.currentTarget && onCloseRef.current()}
    >
      <div
        ref={ref}
        className={cn('wcs-modal', tone === 'danger' && 'is-danger')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ width }}
      >
        <header className="wcs-modal-head">
          <h2 id={titleId}>{title}</h2>
          <IconButton icon="close" label="关闭对话框" size="sm" onClick={() => onCloseRef.current()} />
        </header>
        <div className="wcs-modal-body">{children}</div>
        {footer && <footer className="wcs-modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 错误边界
// ---------------------------------------------------------------------------

interface ErrorBoundaryProps {
  children: ReactNode;
  /** 出错区域名，用于展示与日志定位 */
  scope?: string;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * 渲染错误兜底：单个视图崩溃不应该让整个窗口白屏（Electron 下白屏等于应用假死）。
 * 这里保留导航/状态栏，只把出错区域替换成可重试界面。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 控制台错误会进入 verify-ui / 诊断日志；不把堆栈直接展示给用户
    console.error(`[renderer] ${this.props.scope ?? '界面'}渲染失败`, error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="view" role="alert">
        <EmptyState
          icon="warning"
          title={`${this.props.scope ?? '这部分界面'}加载失败`}
          description="渲染时发生错误。可以重试；如果反复失败，请在设置页导出诊断日志。"
          actions={
            <Button variant="primary" size="sm" icon="refresh" onClick={this.reset}>
              重试
            </Button>
          }
        />
      </div>
    );
  }
}

/** 带固定宽高比的画布容器，内部按输出尺寸绘制并等比缩放。 */
export function CanvasFrame({
  children,
  aspect,
  style,
  className,
}: {
  children: ReactNode;
  aspect: number;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <div className={cn('wcs-canvas-frame', className)} style={{ aspectRatio: String(aspect), ...style }}>
      {children}
    </div>
  );
}

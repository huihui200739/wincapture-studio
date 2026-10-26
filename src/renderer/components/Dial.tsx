import { useEffect, useId, useRef, useState } from 'react';
import { normalizeParameterValue, parseParameterDraft } from '../lib/parameterValue';

const valueText = (value: number) => String(Number(value.toFixed(3)));
const RANGE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

/** A pointer gesture commits one command; arrow keys and numeric entry also work. */
export function Dial({ label, value, min, max, step = 1, unit, format, onCommit }: {
  label: string; value: number; min: number; max: number; step?: number;
  unit?: string;
  format?: (value: number) => string; onCommit: (value: number) => void;
}) {
  const id = useId();
  const [local, setLocal] = useState(value);
  const [draft, setDraft] = useState(() => valueText(value));
  const current = useRef(value);
  const committed = useRef(value);
  const editing = useRef(false);
  const gesture = useRef<{ pointerId: number; x: number; y: number; value: number } | null>(null);
  const bounds = { min, max, step };
  useEffect(() => {
    committed.current = value;
    if (!gesture.current && !editing.current) {
      current.current = value;
      setLocal(value);
      setDraft(valueText(value));
    }
  }, [value]);
  const showValue = (next: number) => {
    current.current = next;
    setLocal(next);
    setDraft(valueText(next));
  };
  const update = (next: number) => {
    const rounded = normalizeParameterValue(next, bounds);
    if (rounded !== null) showValue(rounded);
  };
  const cancel = () => {
    gesture.current = null;
    editing.current = false;
    showValue(committed.current);
  };
  const commit = (next = current.current) => {
    gesture.current = null;
    showValue(next);
    if (current.current !== committed.current) {
      committed.current = current.current;
      onCommit(current.current);
    }
  };
  const fraction = (local - min) / (max - min);
  return <div className="parameter-dial">
    <div className="dial-face">
      <svg viewBox="0 0 64 64" aria-hidden="true"><circle className="dial-track" cx="32" cy="32" r="25" strokeDasharray="117.81 157.08" transform="rotate(135 32 32)" />
        <circle className="dial-fill" cx="32" cy="32" r="25" strokeDasharray={`${fraction * 117.81} 157.08`} transform="rotate(135 32 32)" />
        <circle className="dial-disc" cx="32" cy="32" r="20" /><path className="dial-needle" d="M32 17v6" transform={`rotate(${-135 + fraction * 270} 32 32)`} /></svg>
      <input id={id} type="range" min={min} max={max} step={step} value={local} aria-label={label} aria-valuetext={format?.(local)}
        data-keys="arrowleft arrowright arrowup arrowdown home end escape" title="拖动调节，方向键微调，Esc 取消"
        onPointerDown={event => {
          if (event.button !== 0 || gesture.current) return;
          event.preventDefault();
          event.currentTarget.focus();
          gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, value: current.current };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          const start = gesture.current;
          if (start?.pointerId === event.pointerId) update(start.value + (event.clientX - start.x - event.clientY + start.y) / 180 * (max - min));
        }}
        onPointerUp={event => {
          if (gesture.current?.pointerId !== event.pointerId) return;
          commit();
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={cancel} onLostPointerCapture={() => { if (gesture.current) cancel(); }}
        onChange={event => update(Number(event.target.value))}
        onKeyDown={event => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          const pointerId = gesture.current?.pointerId;
          cancel();
          if (pointerId !== undefined && event.currentTarget.hasPointerCapture(pointerId)) event.currentTarget.releasePointerCapture(pointerId);
        }}
        onKeyUp={event => { if (RANGE_KEYS.has(event.key)) commit(); }}
        onBlur={() => { if (gesture.current) cancel(); else commit(); }} />
    </div>
    <div className="dial-value-field">
      <input className="dial-value" type="number" aria-label={`${label}数值${unit ? `（${unit}）` : ''}`} min={min} max={max} step={step} value={draft}
        data-keys="escape" title="输入数值，Enter 确认，Esc 取消"
        onFocus={event => { editing.current = true; event.currentTarget.select(); }}
        onChange={event => setDraft(event.target.value)}
        onBlur={() => {
          if (!editing.current) return;
          editing.current = false;
          if (draft === valueText(committed.current)) { cancel(); return; }
          const next = parseParameterDraft(draft, bounds);
          if (next === null) cancel();
          else commit(next);
        }}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
            event.currentTarget.blur();
          } else if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }} />
      {unit && <span className="dial-unit" aria-hidden="true">{unit}</span>}
    </div>
    <label htmlFor={id}>{label}</label>
  </div>;
}

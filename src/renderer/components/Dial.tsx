import { useEffect, useId, useRef, useState } from 'react';

/** A pointer gesture commits one command; arrow keys and numeric entry also work. */
export function Dial({ label, value, min, max, step = 1, format, onCommit }: {
  label: string; value: number; min: number; max: number; step?: number;
  format?: (value: number) => string; onCommit: (value: number) => void;
}) {
  const id = useId();
  const [local, setLocal] = useState(value);
  const current = useRef(value);
  const committed = useRef(value);
  const gesture = useRef<{ x: number; y: number; value: number } | null>(null);
  const normalize = (next: number) => Math.min(max, Math.max(min, Math.round(next / step) * step));
  useEffect(() => { if (!gesture.current) { current.current = value; committed.current = value; setLocal(value); } }, [value]);
  const update = (next: number) => { const rounded = normalize(next); current.current = rounded; setLocal(rounded); };
  const commit = () => { gesture.current = null; if (current.current !== committed.current) { committed.current = current.current; onCommit(current.current); } };
  const fraction = (local - min) / (max - min);
  return <div className="parameter-dial">
    <div className="dial-face">
      <svg viewBox="0 0 64 64" aria-hidden="true"><circle className="dial-track" cx="32" cy="32" r="25" strokeDasharray="117.81 157.08" transform="rotate(135 32 32)" />
        <circle className="dial-fill" cx="32" cy="32" r="25" strokeDasharray={`${fraction * 117.81} 157.08`} transform="rotate(135 32 32)" />
        <circle className="dial-disc" cx="32" cy="32" r="20" /><path className="dial-needle" d="M32 17v6" transform={`rotate(${-135 + fraction * 270} 32 32)`} /></svg>
      <input id={id} type="range" min={min} max={max} step={step} value={local} aria-label={label} aria-valuetext={format?.(local)}
        onPointerDown={event => { event.preventDefault(); gesture.current = { x: event.clientX, y: event.clientY, value: local }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { const start = gesture.current; if (start) update(start.value + (event.clientX - start.x - event.clientY + start.y) / 180 * (max - min)); }}
        onPointerUp={commit} onPointerCancel={() => { gesture.current = null; update(value); }} onLostPointerCapture={() => { if (gesture.current) commit(); }}
        onChange={event => update(Number(event.target.value))} onKeyUp={commit} onBlur={commit} />
    </div>
    <input className="dial-value" type="number" aria-label={`${label}数值`} min={min} max={max} step={step} value={Number(local.toFixed(3))}
      onChange={event => { if (event.target.value !== '') update(Number(event.target.value)); }} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
    <label htmlFor={id}>{label}{format && <span className="dial-unit">{format(local)}</span>}</label>
  </div>;
}

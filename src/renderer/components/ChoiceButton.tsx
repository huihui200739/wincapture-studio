import { forwardRef, useEffect, useRef, useState, type ButtonHTMLAttributes } from 'react';

/** AppChoiceFeedback: keep hit geometry fixed; only the foreground reacts. */
export const ChoiceButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { selected: boolean }>(
  function ChoiceButton({ selected, children, onClick, onPointerDown, onPointerUp, onPointerCancel, onPointerLeave, onBlur, onKeyDown, onKeyUp, ...rest }, ref) {
    const [role, setRole] = useState<'selected' | 'other' | null>(null);
    const active = useRef(false);
    const startedAt = useRef(0);
    const releasedAt = useRef(-Infinity);
    const timer = useRef<number | null>(null);
    const clearTimer = () => { if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; } };
    const begin = () => {
      clearTimer();
      active.current = true;
      startedAt.current = performance.now();
      setRole(selected ? 'selected' : 'other');
    };
    const release = () => {
      releasedAt.current = performance.now();
      clearTimer();
      const remaining = Math.max(0, 100 - (releasedAt.current - startedAt.current));
      const finish = () => { active.current = false; setRole(null); timer.current = null; };
      if (remaining > 0) timer.current = window.setTimeout(finish, remaining);
      else finish();
    };
    useEffect(() => {
      const reset = () => {
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = null;
        active.current = false;
        setRole(null);
      };
      window.addEventListener('blur', reset);
      return () => { window.removeEventListener('blur', reset); if (timer.current !== null) window.clearTimeout(timer.current); };
    }, []);
    return <button {...rest} ref={ref} data-choice-button="" data-choice-press={role ?? undefined}
      onPointerDown={event => {
        onPointerDown?.(event);
        if (event.button === 0 && !event.defaultPrevented) begin();
      }}
      onPointerUp={event => { onPointerUp?.(event); if (event.button === 0 && active.current) release(); }}
      onPointerLeave={event => { onPointerLeave?.(event); if (active.current) release(); }}
      onPointerCancel={event => { onPointerCancel?.(event); clearTimer(); active.current = false; setRole(null); }}
      onBlur={event => { onBlur?.(event); if (active.current) release(); }}
      onKeyDown={event => {
        onKeyDown?.(event);
        if (event.defaultPrevented || !['Enter', ' '].includes(event.key)) return;
        if (event.repeat) { event.preventDefault(); return; }
        begin();
      }}
      onKeyUp={event => { onKeyUp?.(event); if (['Enter', ' '].includes(event.key) && active.current) release(); }}
      onClick={event => {
        if (!active.current && performance.now() - releasedAt.current >= 50) { begin(); release(); }
        onClick?.(event);
      }}>
      <span className="choice-content">{children}</span>
    </button>;
  },
);

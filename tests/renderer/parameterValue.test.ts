import { describe, expect, it } from 'vitest';
import { normalizeParameterValue, parseParameterDraft } from '../../src/renderer/lib/parameterValue';

const padding = { min: 0, max: 30, step: 0.5 };

describe('parameter values', () => {
  it.each(['', ' ', '-', '.', '1e', 'NaN', 'Infinity', '-Infinity'])('未完成或无效输入 %j 不会写进工程', draft => {
    expect(parseParameterDraft(draft, padding)).toBeNull();
  });

  it('零值可以提交，不能当成空输入', () => {
    expect(parseParameterDraft('0', padding)).toBe(0);
  });

  it('完成输入后才按步长取整，并限制到参数范围', () => {
    expect(parseParameterDraft('12.4', padding)).toBe(12.5);
    expect(parseParameterDraft('29.9', padding)).toBe(30);
    expect(parseParameterDraft('100', padding)).toBe(30);
    expect(parseParameterDraft('-10', padding)).toBe(0);
  });

  it('以最小值作为步长起点，并清除浮点噪声', () => {
    expect(normalizeParameterValue(0.27, { min: 0.05, max: 1, step: 0.1 })).toBe(0.25);
    expect(normalizeParameterValue(0.3, { min: 0, max: 1, step: 0.1 })).toBe(0.3);
  });

  it('拖动计算得到的非有限数值也不提交', () => {
    expect(normalizeParameterValue(Number.NaN, padding)).toBeNull();
    expect(normalizeParameterValue(Infinity, padding)).toBeNull();
  });
});

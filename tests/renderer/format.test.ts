/**
 * 渲染层格式化 / IPC 结果解包测试
 *
 * 重点覆盖「用户取消对话框」这类合法空结果：主进程返回 ok(null)，
 * 旧的 unwrap 会返回 null 并在调用方解引用时报 TypeError（打开工程取消后误报错）。
 */

import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/shared/errors';
import { describeError, formatBytes, isCancelledError, unwrap, unwrapOptional } from '../../src/renderer/lib/format';

describe('unwrapOptional', () => {
  it('ok:true 且 data 为对象时返回数据', () => {
    expect(unwrapOptional({ ok: true, data: { path: 'x' } })).toEqual({ path: 'x' });
  });

  it('ok:true 且 data 为 null（用户取消）时返回 null，不抛异常', () => {
    expect(unwrapOptional({ ok: true, data: null })).toBeNull();
  });

  it('ok:true 但 data 缺省时返回 null', () => {
    expect(unwrapOptional({ ok: true })).toBeNull();
  });

  it('ok:false 时抛出带中文信息的错误', () => {
    expect(() =>
      unwrapOptional({
        ok: false,
        error: { code: 'E_PROJECT_NOT_FOUND', message: '找不到工程目录', retryable: false, preservedData: false },
      }),
    ).toThrowError('找不到工程目录');
  });

  it('响应为 undefined（主进程没有返回）时抛错', () => {
    expect(() => unwrapOptional(undefined)).toThrowError(/没有返回结果/);
  });
});

describe('unwrap', () => {
  it('ok:true 数据为 null 时仍返回 null（保持原有宽容行为）', () => {
    expect(unwrap({ ok: true, data: null })).toBeNull();
  });

  it('ok:true 但数据缺省时抛错，避免把 undefined 传进界面', () => {
    expect(() => unwrap({ ok: true })).toThrowError(/空结果/);
  });
});

describe('describeError', () => {
  it('稳定错误码映射成中文标题，并保留技术细节', () => {
    const presented = describeError({
      code: 'E_DISK_FULL',
      message: '磁盘写满了',
      retryable: true,
      preservedData: true,
      detail: 'ENOSPC',
    });
    expect(presented.title).toBe('磁盘空间不足');
    expect(presented.message).toBe('磁盘写满了');
    expect(presented.detail).toBe('ENOSPC');
  });

  it('未知形态退回通用文案，不把堆栈直接展示给用户', () => {
    const presented = describeError(new Error('boom'));
    expect(presented.code).toBe('E_UNKNOWN');
    expect(presented.message).toContain('操作没有完成');
    expect(presented.detail).toBe('boom');
  });
});

describe('isCancelledError', () => {
  it('E_EXPORT_CANCELLED 视为用户取消（错误对象 / 普通形状都识别）', () => {
    expect(
      isCancelledError({
        code: 'E_EXPORT_CANCELLED',
        message: '已取消',
        retryable: true,
        preservedData: true,
      }),
    ).toBe(true);
  });

  it('其它错误码与普通异常不算取消', () => {
    expect(
      isCancelledError({ code: 'E_DISK_FULL', message: '磁盘满', retryable: true, preservedData: true }),
    ).toBe(false);
    expect(isCancelledError(new Error('boom'))).toBe(false);
    expect(isCancelledError(undefined)).toBe(false);
  });

  it('AppError 实例形式的取消也能识别', () => {
    expect(
      isCancelledError(
        new AppError({ code: 'E_EXPORT_CANCELLED', message: '已取消', retryable: true, preservedData: true }),
      ),
    ).toBe(true);
  });
});

describe('formatBytes', () => {
  it('非法/非正数显示 0 B', () => {
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(0)).toBe('0 B');
  });

  it('按 1024 进制换算', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024 * 3)).toBe('3.0 MB');
  });
});

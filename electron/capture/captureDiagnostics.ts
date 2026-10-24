/** User-facing failure context while preserving the original error for diagnostics. */
export function captureFailureMessage(backend: 'modern' | 'compatibility', error: unknown): string {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const name = backend === 'modern' ? '现代屏幕采集' : '兼容屏幕采集';
  if (/E_ACCESSDENIED|0x80070005|-2147024891|NotAllowedError|permission|denied|拒绝/i.test(detail)) {
    return `${name}被系统或隐私权限拒绝。请检查 Windows 的屏幕捕获权限${backend === 'modern' ? '，或选择兼容采集' : ''}。`;
  }
  if (/source.closed|来源.*关闭|窗口.*关闭|NotFoundError/i.test(detail)) return `${name}的来源已关闭或不可用，请刷新来源后重试。`;
  return `${name}启动失败${backend === 'modern' ? '，可选择兼容采集后重试' : '，请检查来源是否可见或被独占'}。`;
}

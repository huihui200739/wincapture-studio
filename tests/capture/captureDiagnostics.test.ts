import { expect, it } from 'vitest';
import { captureFailureMessage } from '../../electron/capture/captureDiagnostics';
it('explains modern permission rejection and offers the compatible route', () => {
  expect(captureFailureMessage('modern', new Error('CreateForMonitor E_ACCESSDENIED'))).toMatch(/权限拒绝.*兼容采集/);
  expect(captureFailureMessage('modern', 'NotAllowedError')).toContain('Windows');
});
it('distinguishes a closed source from an unreadable source', () => {
  expect(captureFailureMessage('modern', 'SOURCE_CLOSED')).toContain('刷新来源');
  expect(captureFailureMessage('compatibility', new Error('GDI init failed'))).toContain('独占');
});

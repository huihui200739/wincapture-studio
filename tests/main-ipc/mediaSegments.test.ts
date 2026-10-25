import { expect, it } from 'vitest';
import { recordedSegmentNames } from '../../electron/mediaSegments';

it('WAV 音轨返回真实有序分段，不再被 MP4 过滤器误判缺失', () => {
  const files = ['seg-000002.wav', 'seg-000001.mp4', 'seg-000001.wav', 'notes.wav', 'seg-000003.wav.partial'];
  expect(recordedSegmentNames('media/mic/seg-000001.wav', files)).toEqual(['seg-000001.wav', 'seg-000002.wav']);
  expect(recordedSegmentNames('media/screen/seg-000001.mp4', files)).toEqual(['seg-000001.mp4']);
  expect(recordedSegmentNames('media/system/notes.wav', files)).toEqual(['notes.wav']);
});

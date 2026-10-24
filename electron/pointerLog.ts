import fs from 'node:fs/promises';
import path from 'node:path';
import type { PointerEventLike, PointerLog } from '../src/domain/types';

export async function readPointerLog(root: string): Promise<PointerLog | null> {
  let text: string;
  try { text = await fs.readFile(path.join(root, 'events', 'pointer.jsonl'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const events: PointerEventLike[] = [];
  let meta: PointerLog | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value?.__kind === 'meta') meta = value.__meta;
      else if (value && ['move', 'down', 'up', 'shape'].includes(value.kind)) events.push(value);
    } catch { /* 已完成的事件不受单行损坏影响。 */ }
  }
  return meta ? { ...meta, events, clicks: Array.isArray(meta.clicks) ? meta.clicks : [] } : null;
}

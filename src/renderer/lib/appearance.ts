import { loadSettings } from './settings';

export function applyAppearance(): void {
  const settings = loadSettings();
  const dark = settings.appearance === 'dark' || (settings.appearance === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.motion = settings.motion ?? 'system';
}

export async function playExportSound(): Promise<void> {
  if (loadSettings().exportSound === false) return;
  try {
    const context = new AudioContext();
    await context.resume();
    const gain = context.createGain();
    gain.connect(context.destination);
    gain.gain.setValueAtTime(0.07, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.5);
    for (const [delay, frequency] of [[0, 660], [0.13, 880]]) {
      const tone = context.createOscillator();
      tone.frequency.value = frequency; tone.connect(gain);
      tone.start(context.currentTime + delay); tone.stop(context.currentTime + delay + 0.24);
    }
    window.setTimeout(() => void context.close(), 650);
  } catch { /* Muted or unavailable audio must never fail an export. */ }
}

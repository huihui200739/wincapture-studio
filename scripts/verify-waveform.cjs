// Render the production Timeline with segmented WAV files, optionally from a real read-only project.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { build } = require('esbuild');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist/verify/waveform');
app.setPath('userData', path.join(ROOT, '.tmp/waveform-check'));
app.commandLine.appendSwitch('disable-gpu-sandbox');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { checks: [], screenshots: [] };
const check = (ok, label) => { report.checks.push({ ok: !!ok, label }); if (!ok) throw new Error(label); console.log('[waveform] PASS ' + label); };
const S = 10_000_000;

function wav(amplitude) {
  const frames = 48000, b = Buffer.alloc(44 + frames * 4);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(48000, 24); b.writeUInt32LE(192000, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(32, 34);
  b.write('data', 36); b.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) b.writeFloatLE(Math.sin(i * 0.13) * amplitude * (0.2 + 0.8 * Math.sin(i / 2300) ** 2), 44 + i * 4);
  return b;
}

app.whenReady().then(async () => {
  let win;
  const watchdog = setTimeout(() => app.exit(1), 60000);
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const inputProject = process.argv.find(value => value.endsWith('.wcaproj'));
    const projectRoot = inputProject ? path.resolve(inputProject) : path.join(ROOT, '.tmp/waveform-fixture.wcaproj');
    let project;
    if (inputProject) project = JSON.parse(fs.readFileSync(path.join(projectRoot, 'project.json'), 'utf8'));
    else {
      const { outputFiles } = await build({ stdin: { contents: `export {createEmptyProject} from './src/domain/project';`, resolveDir: ROOT }, bundle: true, platform: 'node', format: 'cjs', write: false });
      const fixtureModule = { exports: {} }; new Function('module', 'exports', outputFiles[0].text)(fixtureModule, fixtureModule.exports);
      project = fixtureModule.exports.createEmptyProject('waveform-check', 'Waveform check');
      for (const kind of ['mic', 'system']) {
        const dir = path.join(projectRoot, 'media', kind); fs.mkdirSync(dir, { recursive: true });
        for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(dir, `seg-00000${i + 1}.wav`), wav(kind === 'system' ? 0 : [0.01, 0.6, 0][i]));
        project.assets.push({ id: kind, kind, path: `media/${kind}/seg-000001.wav`, hash: kind, durationTicks: 3 * S, width: 0, height: 0, sampleRate: 48000, channels: 1, createdAt: 0 });
        project.tracks.find(t => t.kind === kind).clips.push({ id: kind, assetId: kind, sourceInTicks: 0, sourceDurationTicks: 3 * S, timelineInTicks: 0, rate: {num:1,den:1}, linkGroupId: '' });
      }
    }
    const inside = target => {
      const absolute = path.resolve(target);
      const relative = path.relative(projectRoot, absolute);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('outside test project');
      return absolute;
    };
    const readCalls = [];
    ipcMain.handle('waveform:read', (_event, target) => { const absolute = inside(target); readCalls.push(absolute); return { ok: true, data: new Uint8Array(fs.readFileSync(absolute)) }; });
    ipcMain.handle('waveform:segments', (_event, _root, relative) => {
      const absolute = inside(path.join(projectRoot, relative));
      const dir = path.dirname(absolute), ext = path.extname(absolute);
      let cursor = 0;
      const data = fs.readdirSync(dir).filter(n => /^seg-\d+\./.test(n) && path.extname(n) === ext).sort().map(name => {
        const file = path.join(dir, name), bytes = fs.readFileSync(file);
        let durationTicks;
        if (ext === '.wav') durationTicks = Math.round(bytes.readUInt32LE(40) / bytes.readUInt32LE(28) * S);
        else durationTicks = Math.round(project.assets.find(a => a.path === relative).durationTicks / fs.readdirSync(dir).filter(n => path.extname(n) === ext).length);
        const segment = { path: path.relative(projectRoot, file).replaceAll('\\', '/'), startTick: cursor, durationTicks, bytes: bytes.length };
        cursor += durationTicks; return segment;
      });
      return { ok: true, data };
    });
    const preload = path.join(OUT, 'preload.cjs');
    fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('wcs',{readExportFile:p=>ipcRenderer.invoke('waveform:read',p),listMediaSegments:(r,p)=>ipcRenderer.invoke('waveform:segments',r,p),readPointerLog:async()=>({ok:true,data:null})});`);
    const bundle = await build({ stdin: { contents: `
      import {createElement,useState} from 'react'; import {createRoot} from 'react-dom/client';
      import {Timeline} from './src/renderer/components/Timeline';
      export function mount(project, projectPath) {
        function Probe() { const [zoom,setZoom]=useState(1); const [p,setP]=useState(project);
          const noop=()=>{};
          return createElement(Timeline,{project:p,projectPath,tick:0,onSeek:noop,selectedClipId:null,onSelectClip:noop,
            selectedEffectId:null,onSelectEffect:noop,selectedStepId:null,onSelectStep:noop,onSplitAtPlayhead:noop,
            onDeleteSelected:noop,effectClipboardKind:null,onCopyEffect:noop,onPasteEffect:noop,
            onToggleTrackMute:kind=>setP({...p,tracks:p.tracks.map(t=>t.kind===kind?{...t,muted:!t.muted}:t)}),
            onMoveClip:noop,zoom,onZoomChange:setZoom,collapsed:false,onToggleCollapsed:noop});
        }
        createRoot(document.getElementById('probe')).render(createElement(Probe));
      }`, resolveDir: ROOT }, bundle: true, format: 'iife', globalName: 'WaveformProbe', platform: 'browser', write: false, logLevel: 'silent' });
    const css = fs.readdirSync(path.join(ROOT, 'dist/renderer/assets')).find(name => /^index-.*\.css$/.test(name));
    const entry = path.join(OUT, 'probe.html');
    fs.writeFileSync(entry, `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(ROOT, 'dist/renderer/assets', css)).href}"><style>body{margin:0;overflow:hidden}.studio-shell{display:block!important;min-height:0!important;height:100vh}.studio-shell .editor-timeline{height:100vh!important}</style><div class="studio-shell" id="probe"></div>`);
    win = new BrowserWindow({ width: 1440, height: 420, show: false, webPreferences: { preload, sandbox: false, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.on('console-message', event => { if (event.level === 'error' || event.level === 3) console.error('[waveform renderer] ' + event.message); });
    await win.loadFile(entry);
    const js = code => win.webContents.executeJavaScript(code, true);
    await js(bundle.outputFiles[0].text + `;WaveformProbe.mount(${JSON.stringify(project)},${JSON.stringify(projectRoot)})`);
    const expectedCanvases = project.tracks.filter(t => t.kind === 'mic' || t.kind === 'system').reduce((n, t) => n + t.clips.length, 0);
    const until = async code => { const deadline = Date.now() + 20000; while (Date.now() < deadline) { if (await js(code)) return; await wait(100); } throw new Error('Timeout: ' + code); };
    await until(`!!document.querySelector('.timeline-display-toggle button:nth-child(2)')`);
    await js(`document.querySelector('.timeline-display-toggle button:nth-child(2)').click()`);
    await until(`document.querySelector('.editor-timeline.is-waveform-mode') && document.querySelectorAll('[data-waveform-state]').length===${expectedCanvases} && [...document.querySelectorAll('[data-waveform-state]')].every(c=>['ready','silent'].includes(c.dataset.waveformState))`);
    const metrics = () => js(`(()=>[...document.querySelectorAll('.tl-waveform')].map(c=>{const ctx=c.getContext('2d'),p=ctx.getImageData(0,0,c.width,c.height).data;let tall=0;for(let x=0;x<c.width;x++){let count=0;for(let y=0;y<c.height;y++)if(p[(y*c.width+x)*4+3]>120)count++;if(count>4)tall++;}return {label:c.closest('.tl-clip').getAttribute('aria-label'),state:c.dataset.waveformState,tall,color:getComputedStyle(c).color,blend:getComputedStyle(c).mixBlendMode,opacity:getComputedStyle(c).opacity,height:c.getBoundingClientRect().height};}))()`);
    report.light = await metrics();
    check(report.light.some(c => c.label.startsWith('麦克风') && c.state === 'ready' && c.tall > 10), 'quiet microphone has a visible varying envelope');
    check(report.light.filter(c => c.label.startsWith('系统声音')).every(c => c.state === 'silent' && c.tall === 0), 'silent system track stays flat and is labelled');
    check(report.light.every(c => c.blend === 'normal' && c.opacity === '1' && c.height === 40), 'waveforms use full contrast and taller waveform view');
    if (project.assets.some(a => a.kind === 'screen')) {
      const videoClips = project.tracks.filter(t => t.kind === 'primaryVideo' || t.kind === 'camera').reduce((n, t) => n + t.clips.length, 0);
      check(await js(`document.querySelectorAll('.tl-video-thumbnails').length===${videoClips}`), 'video and camera thumbnails remain in waveform mode');
    }
    const capture = async name => { await wait(500); const file = path.join(OUT, name + '.png'); fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); report.screenshots.push(file); };
    await wait(1500); await capture('light');
    await js(`document.documentElement.dataset.theme='dark'`); await wait(150);
    report.dark = await metrics();
    check(report.dark[0].color !== report.light[0].color && report.dark.some(c => c.tall > 10), 'dark theme repaints visible waveform');
    await capture('dark');
    await js(`document.querySelector('.timeline-row-label.is-audio').click()`); await wait(100);
    check(await js(`!!document.querySelector('.tl-clip.is-muted')&&getComputedStyle(document.querySelector('.tl-clip.is-muted .tl-waveform')).opacity==='0.4'`), 'mute dims the envelope without losing it');
    await js(`document.querySelector('.timeline-display-toggle button:first-child').click()`);
    await until(`[...document.querySelectorAll('[data-waveform-state]')].every(c=>['ready','silent'].includes(c.dataset.waveformState))`);
    check(await js(`document.querySelector('.tl-waveform').getBoundingClientRect().height===26`), 'picture mode restores compact audio envelope');
    const audioReads = readCalls.filter(p => p.endsWith('.wav'));
    report.audioReads = audioReads.length;
    check(audioReads.some(p => /seg-00000[3-8]\.wav$/.test(p)), 'loads later recording segments');
    check(new Set(audioReads).size === audioReads.length, 'theme and view changes reuse cached audio data');
    report.ok = true;
  } catch (error) { report.ok = false; report.error = String(error.stack || error); console.error(report.error); }
  finally { clearTimeout(watchdog); win?.destroy(); fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(report, null, 2)); app.exit(report.ok ? 0 : 1); }
});

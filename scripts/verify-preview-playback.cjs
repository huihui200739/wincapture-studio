const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const { build } = require('esbuild');
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(ROOT, 'dist/verify');
app.setPath('userData', path.join(ROOT, '.tmp/preview-playback'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function probe() {
  const { mb, createEmptyProject, PreviewMediaCache, mount } = Probe;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const source = new OffscreenCanvas(320, 180), context = source.getContext('2d');
  const output = new mb.Output({format:new mb.Mp4OutputFormat({fastStart:'in-memory'}),target:new mb.BufferTarget()});
  const video = new mb.CanvasSource(source, {codec:'avc',bitrate:700000});
  output.addVideoTrack(video,{frameRate:30}); await output.start();
  for(let i=0;i<90;i++){context.fillStyle=`hsl(${i*4},80%,50%)`;context.fillRect(0,0,320,180);context.fillStyle='white';context.fillRect(i*3,40,30,70);await video.add(i/30,1/30);}
  await output.finalize();video.close();
  const bytes = new Uint8Array(output.target.buffer), S=10000000;
  window.wcs={listMediaSegments:async(_root,p)=>({ok:true,data:[{path:p,startTick:0,durationTicks:3*S}]}),readExportFile:async()=>({ok:true,data:bytes}),readPointerLog:async()=>({ok:true,data:null})};
  const project=createEmptyProject('playback','Playback test');
  for(const [kind,trackKind] of [['screen','primaryVideo'],['camera','camera']]){
    project.assets.push({id:kind,kind,path:`media/${kind}/seg.mp4`,hash:kind,durationTicks:3*S,width:320,height:180,sampleRate:0,channels:0,createdAt:0});
    project.tracks.find(t=>t.kind===trackKind).clips.push({id:kind,assetId:kind,sourceInTicks:0,sourceDurationTicks:3*S,timelineInTicks:0,rate:{num:1,den:1},linkGroupId:''});
  }
  project.settings.canvas.camera.visible=true;
  const original=PreviewMediaCache.prototype.resolve;
  // Ensure every decode takes longer than one UI tick: previously every finished image was discarded.
  PreviewMediaCache.prototype.resolve=async function(...args){await sleep(120);return original.apply(this,args);};
  const root=mount(project);await sleep(300);
  const canvas=document.querySelector('.stage-canvas'),drawn=[];
  const observer=new MutationObserver(()=>drawn.push(Number(canvas.dataset.previewTick)));
  observer.observe(canvas,{attributes:true,attributeFilter:['data-preview-tick']});
  window.setProbePlayback(true);
  for(let i=1;i<=45;i++){window.setProbeTick(Math.round(i*S/30));await sleep(33);}
  const during=drawn.length;
  if(during<8)throw new Error('Slow decode starved playback: '+JSON.stringify(drawn));
  window.setProbePlayback(false);window.setProbeTick(2*S);await sleep(250);
  if(Number(canvas.dataset.previewTick)!==2*S)throw new Error('Pause/seek painted an old frame');
  await sleep(150);
  if(Number(canvas.dataset.previewTick)!==2*S)throw new Error('Old playback completed after seek');
  observer.disconnect();root.unmount();
  return {ok:true,forcedDecodeDelayMs:120,uiTickMs:33,presentedDuringPlayback:during,pauseAndSeekStable:true};
}

app.whenReady().then(async()=>{
  let win,report;const watchdog=setTimeout(()=>app.exit(1),30000);
  try{
    fs.mkdirSync(OUT,{recursive:true});
    const baseline=process.argv.includes('--baseline');
    const bundle=await build({stdin:{contents:`
      import * as mb from 'mediabunny'; import {configureMediabunny} from './src/media/decoder';configureMediabunny(mb);export {mb};
      export {createEmptyProject} from './src/domain/project';export {PreviewMediaCache} from './src/renderer/lib/previewSource';
      import {createRoot} from 'react-dom/client';import {createElement,useState} from 'react';import {PreviewCanvas} from './src/renderer/components/PreviewCanvas';
      export function mount(project){function Test(){const[tick,setTick]=useState(0),[playing,setPlaying]=useState(false);window.setProbeTick=setTick;window.setProbePlayback=setPlaying;return createElement(PreviewCanvas,{project,projectPath:'C:/preview-test.wcaproj',tick,playing,maxWidth:640});}const root=createRoot(document.getElementById('root'));root.render(createElement(Test));return root;}
    `,resolveDir:ROOT},bundle:true,write:false,format:'iife',globalName:'Probe',platform:'browser',logLevel:'silent',
      plugins:baseline?[{name:'old-preview-cancellation',setup(b){b.onLoad({filter:/PreviewCanvas\.tsx$/},args=>({contents:fs.readFileSync(args.path,'utf8').replace('if (playing) playbackQueue.submit(renderDecoded);','if (false) playbackQueue.submit(renderDecoded);'),loader:'tsx'}));}}]:[]});
    const entry=path.join(OUT,'preview-playback.html');fs.writeFileSync(entry,'<!doctype html><div id="root"></div>');
    win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});await win.loadFile(entry);
    report=await win.webContents.executeJavaScript(bundle.outputFiles[0].text+';('+probe.toString()+')()');
  }catch(error){report={ok:false,error:String(error.stack||error)};}
  finally{clearTimeout(watchdog);win?.destroy();fs.writeFileSync(path.join(OUT,'preview-playback.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.exit(report.ok?0:1);}
});

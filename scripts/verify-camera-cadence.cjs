const {app,BrowserWindow,session}=require('electron');const fs=require('node:fs'),path=require('node:path');const{build}=require('esbuild');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'dist/verify');
app.setPath('userData',path.join(ROOT,'.tmp/camera-cadence'));app.commandLine.appendSwitch('disable-gpu-sandbox');
async function probe(){
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));const ticks=[],callbacks=[];let settings;
 const OriginalFrame=window.VideoFrame;window.VideoFrame=new Proxy(OriginalFrame,{construct(target,args){if(args[0] instanceof HTMLVideoElement||args[0] instanceof OffscreenCanvas&&args[1]?.timestamp>2000000)ticks.push(args[1]?.timestamp/1000);return Reflect.construct(target,args);}});
 const originalCallback=HTMLVideoElement.prototype.requestVideoFrameCallback;
 HTMLVideoElement.prototype.requestVideoFrameCallback=function(cb){return originalCallback.call(this,(now,meta)=>{callbacks.push({wall:performance.now(),media:meta.mediaTime,presented:meta.presentedFrames});cb(now,meta);});};
 const originalMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
 navigator.mediaDevices.getUserMedia=async constraints=>{const s=await originalMedia(constraints);settings=s.getVideoTracks()[0].getSettings();return s;};
 const camera=window.__wcsCamera,devices=await camera.listDevices();const device=devices.find(d=>/integrated|integrate|内置|usb.*camera/i.test(d.label))??devices[0];
 const opened=await camera.open(device?.deviceId);if(!opened.ok)throw new Error(opened.error);
 const start=performance.timeOrigin+performance.now();camera.setClock({state:'recording',mediaTick:0,wallTimeMs:start});
 const segments=[],segmentCount=window.cadenceSegments||4;
 try{for(let i=0;i<segmentCount;i++){
   const deadline=start+(i+1)*1600;await sleep(Math.max(0,deadline-performance.timeOrigin-performance.now()));
   if(i===segmentCount-1)camera.setClock({state:'stopped',mediaTick:segmentCount*16000000,wallTimeMs:performance.timeOrigin+performance.now()});
   const began=performance.now(),before=camera.diagnostics().retained;
   const result=await camera.encodeSegment({index:i+1,startTick:i*16000000,durationTicks:16000000,fps:30,width:1280,height:720});
   segments.push({ok:result.ok,error:result.error,encodeMs:Math.round(performance.now()-began),samplesDuringEncoding:camera.diagnostics().retained-before,mp4:result.mp4,diagnostics:result.diagnostics});
 }
 return{opened,settings,ticks,callbacks,segments,sampling:camera.diagnostics(),processorAvailable:typeof MediaStreamTrackProcessor!=='undefined'};
 }finally{await camera.close();window.VideoFrame=OriginalFrame;HTMLVideoElement.prototype.requestVideoFrameCallback=originalCallback;}
}
app.whenReady().then(async()=>{let win;const timer=setTimeout(()=>app.exit(1),40000);try{
 fs.mkdirSync(OUT,{recursive:true});const entry=path.join(OUT,'camera-cadence.html');fs.writeFileSync(entry,'<!doctype html><title>Camera cadence test</title>');
 session.defaultSession.setPermissionRequestHandler((contents,p,cb)=>cb(p==='media'&&contents.getURL().startsWith('file:')));session.defaultSession.setPermissionCheckHandler((contents,p)=>p==='media'&&contents?.getURL().startsWith('file:'));
 const bundle=await build({stdin:{contents:"import './src/renderer/cameraRuntime';",resolveDir:ROOT},bundle:true,write:false,platform:'browser',format:'iife',logLevel:'silent'});
 const built=true; // Verify the packaged worker URL and production runtime together.
 win=new BrowserWindow({show:process.argv.includes('--visible'),width:640,height:480,webPreferences:{offscreen:!process.argv.includes('--onscreen'),backgroundThrottling:false}});await win.loadFile(built?path.join(ROOT,'dist/renderer/index.html'):entry,{hash:'camera'});
 const result=await win.webContents.executeJavaScript((built?'':bundle.outputFiles[0].text)+`;window.cadenceSegments=${process.argv.includes('--long')?10:4};(`+probe.toString()+')()');
 const target=path.join(OUT,'camera-cadence.wcaproj/media/camera');fs.mkdirSync(target,{recursive:true});result.segments.forEach((s,i)=>{if(s.mp4)fs.writeFileSync(path.join(target,`seg-${String(i+1).padStart(6,'0')}.mp4`),Buffer.from(s.mp4,'base64'));delete s.mp4;});
 fs.writeFileSync(path.join(OUT,'camera-cadence.json'),JSON.stringify(result,null,2));
 const summary={settings:result.settings,segments:result.segments,sampling:result.sampling,processorAvailable:result.processorAvailable};
 summary.ok=result.segments.every(s=>s.ok&&s.diagnostics?.uniqueFrames>=32&&s.diagnostics?.longestHoldMs<=150)&&result.sampling.maxArrivalGapMs<150;
 console.log(JSON.stringify(summary));if(!summary.ok)console.error('Camera cadence failed: too few independent frames or capture stalls');app.exit(summary.ok?0:1);
 }catch(e){console.error(e);app.exit(1);}finally{clearTimeout(timer);win?.destroy();}});

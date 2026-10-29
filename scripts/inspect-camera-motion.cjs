const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'dist/verify');
app.setPath('userData',path.join(ROOT,'.tmp/camera-motion'));
async function inspect(files){
  const results=[];
  for(const file of files){
    const bytes=Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0));
    const input=new MB.Input({formats:MB.ALL_FORMATS,source:new MB.BufferSource(bytes)});
    try{
      const track=await input.getPrimaryVideoTrack(),sink=new MB.VideoSampleSink(track);
      const canvas=new OffscreenCanvas(96,54),ctx=canvas.getContext('2d',{willReadFrequently:true});
      let previous=null,count=0,changed=0,run=0,longest=0;const changes=[],diffs=[];
      for await(const frame of sink.samples()){
        frame.draw(ctx,0,0,96,54);const pixels=ctx.getImageData(0,0,96,54).data;
        let diff=0;if(previous){for(let i=0;i<pixels.length;i+=4)diff+=Math.abs(pixels[i]-previous[i])+Math.abs(pixels[i+1]-previous[i+1])+Math.abs(pixels[i+2]-previous[i+2]);diff/=96*54*3;}
        if(!previous||diff>0.25){changed++;changes.push(Number(frame.timestamp.toFixed(3)));run=0;}else{run++;longest=Math.max(longest,run);}
        diffs.push(Number(diff.toFixed(3)));previous=pixels;count++;frame.close();
      }
      results.push({file:file.name,duration:await input.computeDuration(),frames:count,changed,longestRepeatedRun:longest,changes,diffs});
    }finally{input.dispose();}
  }
  return results;
}
app.whenReady().then(async()=>{let win;try{
  const dir=process.argv.find(p=>p.endsWith('.wcaproj'));if(!dir)throw new Error('project path required');
  const camera=path.join(dir,'media/camera');
  const files=fs.readdirSync(camera).filter(n=>n.endsWith('.mp4')).map(name=>({name,base64:fs.readFileSync(path.join(camera,name)).toString('base64')}));
  const {build}=require('esbuild');const bundle=await build({stdin:{contents:"export * from 'mediabunny'",resolveDir:ROOT},bundle:true,write:false,format:'iife',globalName:'MB',platform:'browser'});
  fs.mkdirSync(OUT,{recursive:true});const entry=path.join(OUT,'camera-motion.html');fs.writeFileSync(entry,'<!doctype html><title>Camera file inspection</title>');
  win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});await win.loadFile(entry);
  const results=await win.webContents.executeJavaScript(bundle.outputFiles[0].text+';('+inspect.toString()+')('+JSON.stringify(files)+')');
  fs.writeFileSync(path.join(OUT,'camera-motion.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results.map(({diffs,...r})=>r)));app.exit(0);
}catch(e){console.error(e);app.exit(1);}finally{win?.destroy();}});

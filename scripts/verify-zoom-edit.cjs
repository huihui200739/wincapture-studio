const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(__dirname,'..'),out=path.join(root,'dist','verify','zoom-edit');
app.setPath('userData',path.join(root,'.tmp','zoom-edit-check'));
app.commandLine.appendSwitch('disable-gpu-sandbox');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const result={checks:[]};
const check=(ok,label)=>{result.checks.push({ok:!!ok,label});console.log('[zoom-edit] '+(ok?'PASS ':'FAIL ')+label);if(!ok)throw new Error(label);};
app.whenReady().then(async()=>{
 try{
  fs.mkdirSync(out,{recursive:true});
  const win=new BrowserWindow({width:1400,height:900,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:false}});
  const js=code=>win.webContents.executeJavaScript(code,true);
  const until=async code=>{const start=Date.now();while(Date.now()-start<15000){if(await js(code))return;await wait(100);}throw new Error('Timeout '+code);};
  const shot=async name=>{win.focus();win.webContents.invalidate();await wait(100);const [width,height]=win.getContentSize();fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage({x:0,y:0,width,height})).toPNG());};
  await win.loadFile(path.join(root,'dist','renderer','index.html'),{hash:'/editor'});
  await until(`!!document.querySelector('.tl-clip')&&!!document.querySelector('.tl-effect.is-zoom')`);
  await js(`(() => {for(const [label,value] of [['时间线缩放',0.5],['播放进度',40000000]]){const el=document.querySelector('input[aria-label="'+label+'"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,String(value));el.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
  await wait(250);
  await js(`document.querySelector('[aria-label^="在播放头分割"]').click()`);await wait(250);
  check(await js(`document.querySelector('.timeline-row').querySelectorAll('.tl-clip').length===3`),'真实时间线在 4 秒处分割出后半段');
  const effectsBefore=await js(`[...document.querySelectorAll('.tl-effect.is-zoom')].map(e=>e.getAttribute('aria-label'))`);
  check(effectsBefore.length===3,'跨分割点运镜自动分成两段');
  await shot('01-split');
  const grip=await js(`(() => {const clips=document.querySelector('.timeline-row').querySelectorAll('.tl-clip'),r=clips[1].getBoundingClientRect(),first=clips[0].getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),delta:Math.round(first.width/4*28)};})()`);
  win.webContents.sendInputEvent({type:'mouseDown',x:grip.x,y:grip.y,button:'left',clickCount:1});
  for(let i=1;i<=20;i++){win.webContents.sendInputEvent({type:'mouseMove',x:grip.x+Math.round(grip.delta*i/20),y:grip.y,movementX:Math.round(grip.delta/20),modifiers:['alt']});await wait(15);}
  await wait(150);
  const during=await js(`({clip:document.querySelector('.tl-clip.is-dragging')?.getAttribute('aria-label'),effects:[...document.querySelectorAll('.tl-effect.is-zoom')].map(e=>e.getAttribute('aria-label'))})`);
  result.during=during;
  check(during.clip?.includes('正在拖动')&&during.effects.join('|')!==effectsBefore.join('|'),'松手之前，运镜条就随视频拖动预览');
  await shot('02-drag-preview');
  win.webContents.sendInputEvent({type:'mouseUp',x:grip.x+grip.delta,y:grip.y,button:'left',clickCount:1});await wait(300);
  const effectsAfter=await js(`[...document.querySelectorAll('.tl-effect.is-zoom')].map(e=>e.getAttribute('aria-label'))`);
  check(effectsAfter.join('|')===during.effects.join('|'),'松手后的视频与运镜位置保持同步');
  await shot('03-moved');
  await js(`document.querySelector('.studio-history button[aria-label="撤销（Ctrl+Z）"]').click()`);await wait(250);
  check(await js(`JSON.stringify([...document.querySelectorAll('.tl-effect.is-zoom')].map(e=>e.getAttribute('aria-label')))===${JSON.stringify(JSON.stringify(effectsBefore))}`),'一次撤销恢复视频与全部运镜位置');
  await js(`document.querySelector('.studio-history button[aria-label="重做（Ctrl+Y）"]').click()`);await wait(250);
  check(await js(`JSON.stringify([...document.querySelectorAll('.tl-effect.is-zoom')].map(e=>e.getAttribute('aria-label')))===${JSON.stringify(JSON.stringify(effectsAfter))}`),'重做再次同步视频与运镜');
  result.ok=true;
 }catch(error){result.ok=false;result.error=String(error.stack||error);console.error(result.error);}
 finally{fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));app.exit(result.ok?0:1);}
});

// Interactive desktop check: click the dedicated target with real mouse input.
// Unlike verify:input-camera, this deliberately does not inject input itself.
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path');
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(ROOT, 'dist', 'verify');
app.setPath('userData', path.join(ROOT, '.tmp', 'pointer-desktop-data'));
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, {recursive:true});
  const win = new BrowserWindow({width:640,height:400,show:false,webPreferences:{nodeIntegration:true,contextIsolation:false}});
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>WCS native click check</title><style>body{margin:0;background:#16202e;color:white;font:20px sans-serif;text-align:center}h1{font-size:24px;margin:42px 0}button{background:#3e82f5;color:white;border:0;border-radius:12px;font-size:24px;padding:24px 55px}p{font-size:16px}</style><h1>Windows 原生点击采集验证</h1><button id="target">点击验证区域</button><p id="status">等待原生钩子就绪</p><script>document.querySelector('button').onclick=()=>{document.querySelector('#status').textContent='窗口已收到点击';require('electron').ipcRenderer.send('test-click')}</script>`));
  const handle = win.getNativeWindowHandle(), hwnd = (handle.length>=8?handle.readBigUInt64LE():BigInt(handle.readUInt32LE())).toString();
  const worker = spawn(path.join(ROOT,'dist','native','pointer.exe'),[],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let pending='', events=[], dom=false, ready=false, finished=false;
  worker.stdin.on('error',()=>{});
  const finish = async (ok, reason) => {
    if(finished)return;finished=true;clearTimeout(timeout);
    worker.stdin.write('q\n');
    await new Promise(resolve=>{const timer=setTimeout(()=>{worker.kill();resolve()},1500);worker.once('exit',()=>{clearTimeout(timer);resolve()})});
    const report={ok,reason,ready,domClick:dom,events};fs.writeFileSync(path.join(OUT,'pointer-desktop.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.exit(ok?0:1);
  };
  const maybeFinish = ()=>{if(dom && events.some(e=>e.kind==='down') && events.some(e=>e.kind==='up'))void finish(true,'Real desktop click reached the native hook and controlled target window')};
  ipcMain.on('test-click',event=>{if(event.sender.id===win.webContents.id){dom=true;maybeFinish()}});
  worker.stdout.on('data',chunk=>{
    pending+=chunk;let newline;
    while((newline=pending.indexOf('\n'))>=0){const value=JSON.parse(pending.slice(0,newline));pending=pending.slice(newline+1);
      if(value.ready){ready=true;win.webContents.executeJavaScript(`document.querySelector('#status').textContent='钩子已就绪，请点击蓝色区域'`);win.show();}
      else if(value.hwnd===hwnd){events.push(value);maybeFinish()}
    }
  });
  worker.once('error',error=>void finish(false,String(error)));
  win.once('closed',()=>void finish(false,'Controlled test window closed'));
  const timeout=setTimeout(()=>void finish(false,'No complete target click before the 90 second deadline'),90000);
});

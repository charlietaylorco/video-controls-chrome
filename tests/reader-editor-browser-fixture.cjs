/* Offline editor-only fixture. Does not load an extension or contact Reader. */
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),destination=path.join(root,'output/editor-browser');fs.mkdirSync(destination,{recursive:true});
fs.copyFileSync(path.join(root,'reader-editor.js'),path.join(destination,'reader-editor.js'));
fs.writeFileSync(path.join(destination,'index.html'),`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'none'"><title>Sandboxed Note editor · offline diagnostic</title><style>body{max-width:760px;margin:36px auto;padding:0 20px;font:14px/1.6 system-ui;background:#f7f7f4;color:#222}button{font:inherit;padding:8px;margin:4px}#editor{height:180px;border:1px solid #999}iframe{display:block;width:100%;height:100%;border:0}pre{white-space:pre-wrap;background:#eee;padding:16px}label{display:block;margin:12px 0}</style></head><body><h1>Sandboxed Document Note</h1><p>Offline synthetic data. Parent-realm DOM callbacks; no extension injection, Reader access, script inside the frame or real YouTube page. Inspect native console messages separately.</p><button id="note">Open Note</button><button id="summary">Show Summary</button><button id="mount">Same-document mount</button><button id="remount">Detach/remount</button><button id="theme">Toggle theme</button><button id="outside">Outside focus</button><button id="reset">Reset host key count</button><p id="status" role="status"></p><div id="summary-view">Synthetic summary. The Note frame is not attached before first activation.</div><div id="editor" hidden></div><pre id="log" aria-live="polite"></pre><script src="reader-editor.js"></script><script src="fixture.js"></script></body></html>`);
fs.writeFileSync(path.join(destination,'fixture.js'),`
const container=document.querySelector('#editor'),summary=document.querySelector('#summary-view'),status=document.querySelector('#status'),log=document.querySelector('#log');
let inputs=0,escapes=0,loads=0,keys=0,dark=false;
const report=()=>{status.textContent='Attached frames: '+container.querySelectorAll('iframe').length+' · Loads: '+loads+' · Host key events: '+keys;log.textContent='Input callbacks: '+inputs+' · Escape callbacks: '+escapes+'\\nSynthetic draft: '+editor.value;};
const editor=MVSReaderEditor.create({onInput(){inputs++;report();},onEscape(){escapes++;container.hidden=true;summary.hidden=false;report();}});editor.value='Synthetic draft — try typing, selecting and using Escape.';
editor.frame.addEventListener('load',()=>{loads++;report();});
window.addEventListener('keydown',()=>{keys++;report();},true);
document.querySelector('#note').onclick=()=>{container.hidden=false;summary.hidden=true;if(editor.frame.parentElement!==container)container.append(editor.frame);editor.mount();report();};
document.querySelector('#summary').onclick=()=>{container.hidden=true;summary.hidden=false;report();};
document.querySelector('#mount').onclick=()=>{editor.mount();report();};
document.querySelector('#remount').onclick=()=>{if(editor.frame.parentElement===container){editor.frame.remove();container.append(editor.frame);editor.mount();}report();};
document.querySelector('#theme').onclick=()=>{dark=!dark;editor.setTheme(dark?'dark':'light');report();};document.querySelector('#reset').onclick=()=>{keys=0;report();};report();
`);
console.log(destination);

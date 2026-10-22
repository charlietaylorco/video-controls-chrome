/* Actual timer UI, reminder, options and worker routes. Synthetic Chrome storage,
 * disposable browser contexts, intercepted files; no live YouTube/Reader access. */
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),out=path.join(root,'output/playwright/viewing-timer');
let browser;
before(async()=>{fs.mkdirSync(out,{recursive:true});browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});});
after(async()=>{await browser?.close();});
async function fixture({width=1100,theme='light'}={}){
  const context=await browser.newContext({viewport:{width,height:900},colorScheme:theme});
  const data={readerPanelTheme:theme},errors=[],messages=[],writes=[];let clock=Date.now(),listener,worker;
  const broadcast=patch=>{
    const changes=Object.fromEntries(Object.entries(patch).map(([key,value])=>[key,{oldValue:structuredClone(data[key]),newValue:structuredClone(value)}]));
    Object.assign(data,structuredClone(patch));writes.push(structuredClone(patch));
    for(const page of context.pages())void page.evaluate(changes=>window.fixtureChange?.(changes),changes).catch(()=>{});
  };
  const get=keys=>Array.isArray(keys)?Object.fromEntries(keys.filter(key=>key in data).map(key=>[key,data[key]])):{...keys,...Object.fromEntries(Object.keys(keys).filter(key=>key in data).map(key=>[key,data[key]]))};
  const restart=()=>{
    class Clock extends Date{static now(){return clock;}}
    worker=vm.createContext({URL,AbortSignal,Date:Clock,crypto:{randomUUID:()=>`session-${writes.length+1}`},chrome:{runtime:{id:'fixture',lastError:null,getURL:file=>`chrome-extension://fixture/${file}`,onMessage:{addListener(fn){listener=fn;}}},storage:{local:{get(keys,cb){cb(get(keys));},set(patch,cb){broadcast(patch);cb?.();}},onChanged:{addListener(){}}},action:{onClicked:{addListener(){}}}},fetch(){throw Error('No remote requests allowed');}});
    worker.importScripts=(...files)=>files.filter(file=>['reader-core.js','watch-timer-core.js','watch-timer-service.js'].includes(file)).forEach(file=>vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),worker));
    vm.runInContext(fs.readFileSync(path.join(root,'background.js'),'utf8'),worker);
  };restart();
  await context.exposeBinding('fixtureBridge',async({page},command)=>{
    if(command.kind==='get')return get(command.keys);if(command.kind==='set'){broadcast(command.patch);return{};}
    const message=command.message;messages.push(message);
    if(message.type==='watch-list-page')return{ok:true,items:[],hasNext:false,nextCursor:null};
    const url=page.url().includes('youtube.html')?'https://www.youtube.com/watch?v=synthetic':`chrome-extension://fixture/${path.basename(new URL(page.url()).pathname)}`;
    return new Promise(resolve=>listener(message,{id:'fixture',frameId:0,url,tab:{id:1},documentLifecycle:'active'},resolve));
  });
  await context.addInitScript(()=>{
    const listeners=new Set(),storage={get(keys,cb){fixtureBridge({kind:'get',keys}).then(cb);},set(patch,cb){fixtureBridge({kind:'set',patch}).then(()=>cb?.());}};
    window.fixtureChange=changes=>{for(const fn of listeners)fn(changes,'local');};
    window.chrome={runtime:{lastError:null,getURL:file=>`chrome-extension://fixture/${file}`,sendMessage(message,cb){fixtureBridge({kind:'message',message}).then(cb);}},storage:{local:storage,sync:{get(keys,cb){cb({});},set(patch,cb){cb?.();}},onChanged:{addListener(fn){listeners.add(fn);},removeListener(fn){listeners.delete(fn);}}}};
    const attach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(init){const result=attach.call(this,init);if(this.id==='mvs-viewing-timer-reminder')window.fixtureReminderRoot=result;return result;};
    window.fixturePlaybackActions=0;HTMLMediaElement.prototype.pause=function(){window.fixturePlaybackActions++;};HTMLMediaElement.prototype.play=function(){window.fixturePlaybackActions++;return Promise.resolve();};
    window.Audio=function(){throw Error('Timer must not attempt autoplay');};
  });
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());if(url.hostname!=='timer.fixture.test')return route.abort();
    if(url.pathname==='/youtube.html')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Synthetic YouTube</title><style>body{font:16px system-ui;margin:28px}#player{height:400px;background:#333}video{width:100%;height:100%}</style><button id="watching">Watching YouTube</button><div id="player"><video></video></div><script src="watch-timer-core.js"></script><script src="watch-timer-client.js"></script><script src="watch-timer-reminder.js"></script>'});
    const file=path.join(root,path.basename(url.pathname));if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
    return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(file)});
  });
  const page=async(name='watch.html')=>{
    const page=await context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));
    await page.clock.install({time:new Date(clock)});await page.goto(`https://timer.fixture.test/${name}`);
    if(name==='watch.html'){await page.locator('#viewing-timer').waitFor();await page.waitForFunction(()=>document.querySelector('#timer-primary').disabled===false);}
    return page;
  };
  return{data,writes,messages,errors,page,context,restart,advance(ms){clock+=ms;},get clock(){return clock;},close:()=>context.close()};
}
const open=async page=>{await page.locator('#viewing-timer').click();await page.locator('#timer-popover').waitFor();};
const phase=async(page,value)=>page.waitForFunction(value=>document.querySelector('#viewing-timer').dataset.phase===value,value);
const reminder=async page=>{await page.waitForFunction(()=>document.querySelector('#mvs-viewing-timer-reminder')&&!document.querySelector('#mvs-viewing-timer-reminder').hidden);return page.evaluateHandle(()=>window.fixtureReminderRoot.querySelector('section'));};
test('title timer/picker match typography, wheel/direct/keyboard input work, Start is explicit and controls do not shift layout',async()=>{
  for(const [width,theme]of[[1100,'light'],[320,'dark']]){
    const f=await fixture({width,theme}),page=await f.page();const before=await page.locator('#videos').boundingBox();
    const type=await page.evaluate(()=>{const a=getComputedStyle(document.querySelector('h1')),b=getComputedStyle(document.querySelector('#viewing-timer'));return{a:a.fontSize,b:b.fontSize,aw:a.fontWeight,bw:b.fontWeight,ac:a.color,bc:b.color,overflow:document.documentElement.scrollWidth>innerWidth};});
    assert.equal(type.a,type.b);assert.ok(Number(type.bw)<Number(type.aw));assert.notEqual(type.ac,type.bc);assert.equal(type.overflow,false);
    await open(page);await page.screenshot({path:path.join(out,`timer-picker-${width}-${theme}.png`),fullPage:true});const box=await page.locator('#timer-popover').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width);
    await page.locator('#timer-picker').dispatchEvent('wheel',{deltaY:80,deltaMode:0});assert.equal(await page.locator('#timer-minutes').inputValue(),'17');
    await page.locator('#timer-minutes').fill('0');assert.equal(await page.locator('#timer-primary').isDisabled(),true);
    await page.locator('#timer-minutes').fill('21');await page.locator('#timer-minutes').press('ArrowUp');assert.equal(await page.locator('#timer-minutes').inputValue(),'22');
    assert.equal(f.data.watchViewingTimer,undefined);assert.equal(f.data.watchTimerDefaultMinutes,undefined);
    await page.locator('#timer-primary').click();await phase(page,'running');assert.equal(f.data.watchViewingTimer.durationMinutes,22);
    assert.deepEqual(await page.locator('#videos').boundingBox(),before);assert.deepEqual(await page.locator('#timer-popover').boundingBox(),box);
    await page.screenshot({path:path.join(out,`timer-running-${width}-${theme}.png`),fullPage:true});
    f.advance(30000);await page.clock.fastForward(30000);await page.locator('#timer-primary').click();await phase(page,'paused');const paused=await page.locator('#viewing-timer').textContent();
    f.advance(120000);await page.clock.fastForward(120000);assert.equal(await page.locator('#viewing-timer').textContent(),paused);
    await page.locator('#timer-primary').click();await phase(page,'running');await page.locator('#timer-reset').click();await phase(page,'idle');assert.equal(await page.locator('#viewing-timer').textContent(),'15:00');
    await page.keyboard.press('Escape');assert.equal(await page.locator('#timer-popover').isVisible(),false);assert.equal(await page.locator('#viewing-timer').evaluate(node=>node===document.activeElement),true);
    assert.deepEqual(f.errors,[]);await f.close();
  }
});
test('Options persist the default separately; one-off timers/reopen never overwrite it or change a running deadline',async()=>{
  const f=await fixture(),page=await f.page(),options=await f.page('options.html');
  const input=options.locator('#watch-timer-default-minutes');await input.fill('25');await input.press('Tab');
  await page.waitForFunction(()=>document.querySelector('#viewing-timer').textContent==='25:00');await open(page);assert.equal(await page.locator('#timer-minutes').inputValue(),'25');
  await page.locator('#timer-minutes').fill('17');await page.locator('#timer-primary').click();await phase(page,'running');const deadline=f.data.watchViewingTimer.deadline;
  await input.fill('35');await input.press('Tab');assert.equal(f.data.watchViewingTimer.deadline,deadline);assert.equal(f.data.watchViewingTimer.durationMinutes,17);
  await page.close();const reopened=await f.page();await phase(reopened,'running');await open(reopened);await reopened.locator('#timer-reset').click();await phase(reopened,'idle');
  assert.equal(await reopened.locator('#timer-minutes').inputValue(),'35');assert.equal(f.data.watchTimerDefaultMinutes,35);
  await input.scrollIntoViewIfNeeded();await options.screenshot({path:path.join(out,'timer-default-setting.png'),fullPage:true});
  await options.close();const again=await f.page('options.html');await again.waitForFunction(()=>document.querySelector('#watch-timer-default-minutes').value==='35');assert.deepEqual(f.errors,[]);await f.close();
});
test('expiry is visible while watching YouTube with Recent saves closed; dismiss synchronizes without playback/focus changes',async()=>{
  const f=await fixture(),page=await f.page();await open(page);await page.locator('#timer-minutes').fill('1');await page.locator('#timer-primary').click();await phase(page,'running');
  const youtube=await f.page('youtube.html');await youtube.locator('#watching').focus();await page.close();f.advance(60000);await youtube.clock.fastForward(60000);await reminder(youtube);
  assert.equal(await youtube.evaluate(()=>document.activeElement.id),'watching');assert.equal(await youtube.evaluate(()=>window.fixturePlaybackActions),0);
  assert.match(await youtube.evaluate(()=>window.fixtureReminderRoot.textContent),/1 minute has passed/);
  await youtube.evaluate(()=>{Object.defineProperty(document,'fullscreenElement',{configurable:true,get:()=>document.querySelector('#player')});document.dispatchEvent(new Event('fullscreenchange'));});
  assert.equal(await youtube.locator('#mvs-viewing-timer-reminder').evaluate(host=>host.parentElement.id),'player');
  await youtube.screenshot({path:path.join(out,'youtube-time-up.png'),fullPage:true});
  const other=await f.page('youtube.html');await reminder(other);assert.equal(await other.locator('#mvs-viewing-timer-reminder').count(),1);
  const button=await youtube.evaluateHandle(()=>window.fixtureReminderRoot.querySelector('button'));await button.asElement().click();
  await other.waitForFunction(()=>document.querySelector('#mvs-viewing-timer-reminder').hidden);assert.equal(f.data.watchViewingTimer.dismissed,true);assert.deepEqual(f.errors,[]);await f.close();
});
test('sleep/worker restart/reopen recover expiry, and simultaneous tabs never create two timers',async()=>{
  const f=await fixture(),one=await f.page(),two=await f.page();await open(one);await open(two);
  await Promise.all([one.evaluate(()=>document.querySelector('#timer-primary').click()),two.evaluate(()=>document.querySelector('#timer-primary').click())]);await phase(one,'running');await phase(two,'running');
  assert.equal(f.writes.filter(patch=>patch.watchViewingTimer?.phase==='running').length,1);
  const id=f.data.watchViewingTimer.id;await one.close();await two.close();f.advance(7200000);f.restart();
  const youtube=await f.page('youtube.html');await reminder(youtube);assert.equal(f.data.watchViewingTimer.id,id);assert.equal(f.data.watchViewingTimer.phase,'expired');
  assert.deepEqual(f.errors,[]);await f.close();
});

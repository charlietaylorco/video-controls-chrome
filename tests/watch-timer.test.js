const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const C = require('../watch-timer-core.js');
const root = path.resolve(__dirname, '..'), tick = () => new Promise(setImmediate);
function fixture({ stored = {}, alarms } = {}) {
  let clock = 100000, sequence = 0;
  const data = structuredClone(stored), writes = [], changes = new Set(), scheduled = new Map();
  const storage = { get(defaults, cb) { cb(structuredClone({...defaults,...data})); }, set(patch, cb) {
    const delta = Object.fromEntries(Object.entries(patch).map(([key,value])=>[key,{oldValue:data[key],newValue:value}]));
    Object.assign(data,structuredClone(patch)); writes.push(structuredClone(patch)); for(const fn of changes) fn(delta,'local'); cb?.();
  } };
  const context = vm.createContext({ MVSWatchTimerCore:C });
  vm.runInContext(fs.readFileSync(path.join(root,'watch-timer-service.js'),'utf8'),context);
  const create = () => context.MVSWatchTimerService.create({storage,now:()=>clock,uuid:()=>`fixture-${++sequence}`,alarms});
  let service = create();
  return {data,writes,changes,storage,scheduled, get service(){return service;}, get clock(){return clock;}, advance(ms){clock+=ms;},restart(){service=create();},
    async call(action, extra={}) {const state=C.normalize(data[C.KEY]);return service.handle({action,id:state.id,revision:state.revision,...extra});} };
}
test('configured default starts at 15; one-off session lengths never overwrite it',async()=>{
  const f=fixture();assert.equal((await f.call('get')).defaultMinutes,15);
  await f.call('start',{minutes:23});assert.equal(f.data[C.KEY].durationMinutes,23);assert.equal(f.data[C.DEFAULT_KEY],undefined);
  f.storage.set({[C.DEFAULT_KEY]:30});assert.equal((await f.call('get')).defaultMinutes,30);assert.equal(f.data[C.KEY].durationMinutes,23);
  await f.call('reset');assert.equal((await f.call('get')).defaultMinutes,30);f.restart();assert.equal((await f.call('get')).defaultMinutes,30);
});
test('start/pause/resume/reset use absolute deadlines and retain exact paused remaining time',async()=>{
  const f=fixture();await f.call('start',{minutes:15});assert.equal(f.data[C.KEY].deadline,100000+900000);
  f.advance(12345);await f.call('pause');assert.equal(f.data[C.KEY].remainingMs,887655);assert.equal(f.data[C.KEY].deadline,null);
  f.advance(3600000);f.restart();await f.call('resume');assert.equal(f.data[C.KEY].deadline,f.clock+887655);
  await f.call('reset');assert.equal(f.data[C.KEY].phase,'idle');assert.equal(f.data[C.KEY].deadline,null);
});
test('background/reopen/sleep expire once at deadline, acknowledgements persist and canceled timers never expire',async()=>{
  const f=fixture();await f.call('start',{minutes:1});f.advance(60000);f.restart();
  assert.equal((await f.call('get')).state.phase,'expired');const writes=f.writes.length;
  await Promise.all([f.call('expire'),f.call('expire'),f.call('get')]);assert.equal(f.writes.length,writes);
  await f.call('dismiss');f.restart();assert.equal((await f.call('get')).state.dismissed,true);
  await f.call('reset');await f.call('start',{minutes:1});await f.call('reset');f.advance(900000);assert.equal((await f.call('get')).state.phase,'idle');
});
test('simultaneous starts cannot create duplicate timers or extend a running deadline; stale IDs cannot control new sessions',async()=>{
  const f=fixture();const start={action:'start',minutes:15,revision:0,id:null};
  const [one,two]=await Promise.all([f.service.handle(start),f.service.handle({...start,minutes:60})]);
  assert.equal(one.state.id,two.state.id);assert.equal(two.state.durationMinutes,15);assert.equal(f.writes.length,1);
  const old=one.state.id;await f.call('reset');await f.call('start',{minutes:2});const current=f.data[C.KEY];
  for(const action of ['pause','resume','reset','dismiss'])await f.service.handle({action,id:old});
  assert.deepEqual(f.data[C.KEY],current);
});
test('invalid durations/state do not start timers, stale revisions cannot replace one, optional alarm failures are harmless',async()=>{
  for(const minutes of [0,181,NaN,Infinity,'15',1.5]){const f=fixture();assert.equal((await f.call('start',{minutes})).code,'invalid_duration');assert.equal(f.writes.length,0);}
  const f=fixture({alarms:{create(){throw Error('unavailable');},clear(){throw Error('unavailable');}}});
  assert.equal((await f.call('start',{minutes:1})).ok,true);await f.call('reset');
  assert.equal((await f.service.handle({action:'start',minutes:15,revision:0})).code,'timer_changed');
  for(const invalid of [{phase:'running',id:'x',revision:1,deadline:NaN},{phase:'paused',id:'x',revision:1,remainingMs:0},{}])assert.equal(C.normalize(invalid).phase,'idle');
});
test('pause on the expiry boundary yields expiry and never an invalid zero-duration paused timer',async()=>{
  const f=fixture();await f.call('start',{minutes:1});f.advance(60000);await f.call('pause');assert.equal(f.data[C.KEY].phase,'expired');
  assert.equal(C.format(899001),'15:00');assert.equal(C.format(59999),'1:00');assert.equal(C.format(0),'0:00');
});
function clientFixture(f, sendOverride) {
  const events=new Map(), timers=new Map(), messages=[], renders=[];let sequence=0;
  const eventTarget={addEventListener(type,fn){events.set(type,fn);},removeEventListener(type){events.delete(type);}};
  const context=vm.createContext({MVSWatchTimerCore:C,document:{...eventTarget,hidden:false},window:eventTarget,
    chrome:{runtime:{lastError:null,sendMessage(message,cb){messages.push(message);if(sendOverride)sendOverride(message,cb);else f.service.handle(message).then(cb);}},storage:{onChanged:{addListener(fn){f.changes.add(fn);},removeListener(fn){f.changes.delete(fn);}}}},
    setTimeout(fn,ms){const id=++sequence;timers.set(id,{fn,at:f.clock+ms});return id;},clearTimeout(id){timers.delete(id);}});
  vm.runInContext(fs.readFileSync(path.join(root,'watch-timer-client.js'),'utf8'),context);
  const client=context.MVSWatchTimerClient.create({now:()=>f.clock,onChange:(state,defaults,remaining)=>renders.push({state,defaults,remaining})});
  return {client,messages,renders,timers,events,context,async pump(ms){f.advance(ms);for(const [id,timer]of[...timers])if(timer.at<=f.clock){timers.delete(id);timer.fn();}await tick();}};
}
test('client ticks render locally, recover after background/sleep, and multiple clients only commit expiry once',async()=>{
  const f=fixture(),one=clientFixture(f),two=clientFixture(f);await Promise.all([one.client.ready,two.client.ready]);
  await one.client.action('start',{minutes:1});const count=one.messages.length+two.messages.length;
  await one.pump(1000);assert.equal(one.messages.length+two.messages.length,count);
  await one.pump(60000);await two.pump(0);assert.equal(f.data[C.KEY].phase,'expired');assert.equal(f.writes.length,2);
  assert.equal(two.renders.at(-1).state.phase,'expired');one.client.dispose();two.client.dispose();assert.equal(one.timers.size,0);
});
test('late initial client responses cannot overwrite newer timer state or configured defaults',async()=>{
  const f=fixture();let release;const client=clientFixture(f,(message,cb)=>{release=()=>cb({ok:true,state:C.idle(),defaultMinutes:15});});
  await f.call('start',{minutes:10});f.storage.set({[C.DEFAULT_KEY]:25});release();await client.client.ready;
  assert.equal(client.renders.at(-1).state.phase,'running');assert.equal(client.renders.at(-1).defaults,25);client.client.dispose();
});
test('worker restricts controls to Recent saves and reminder actions to top-level active YouTube contexts',async()=>{
  const f=fixture();let listener;const context=vm.createContext({URL,AbortSignal,crypto:{randomUUID:()=> 'guard-fixture'},
    chrome:{runtime:{id:'fixture',lastError:null,getURL:file=>`chrome-extension://fixture/${file}`,onMessage:{addListener(fn){listener=fn;}}},storage:{local:f.storage,onChanged:{addListener(){}}},action:{onClicked:{addListener(){}}}},fetch(){throw Error('No remote requests allowed');}});
  context.importScripts=(...files)=>files.filter(file=>['reader-core.js','watch-timer-core.js','watch-timer-service.js'].includes(file)).forEach(file=>vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context));
  vm.runInContext(fs.readFileSync(path.join(root,'background.js'),'utf8'),context);
  const send=(action,sender,extra={})=>new Promise(resolve=>listener({type:'viewing-timer',action,...extra},sender,resolve));
  const page={id:'fixture',frameId:0,url:'chrome-extension://fixture/watch.html'};
  assert.equal((await send('start',page,{minutes:15,revision:0})).ok,true);
  for(const sender of [{...page,id:'foreign'},{...page,frameId:1},{...page,url:'https://evil.example/'},{...page,documentLifecycle:'prerender'}])assert.equal((await send('reset',sender)).code,'invalid_sender');
  const youtube={...page,url:'https://www.youtube.com/watch?v=fixture'};
  assert.equal((await send('get',youtube)).ok,true);assert.equal((await send('reset',youtube)).code,'invalid_sender');
  assert.equal((await send('dismiss',youtube)).ok,true);
});

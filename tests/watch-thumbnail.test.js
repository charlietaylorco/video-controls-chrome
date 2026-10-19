const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const video = 'https://www.youtube.com/watch?v=fixture_video';
function fixture(url = video) {
  const requests = [], handlers = new Map(); let src = '', unavailable = 0;
  const image = { hidden:false, currentSrc:'', naturalWidth:0, naturalHeight:0,
    get src(){return src;}, set src(value){src=value;requests.push(value);},
    addEventListener(type,fn){handlers.set(type,fn);}, removeEventListener(type,fn){if(handlers.get(type)===fn)handlers.delete(type);},
  };
  const context = vm.createContext({ URL });
  for(const file of ['reader-core.js','watch-thumbnail.js']) vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),context);
  const controller = context.MVSWatchThumbnail.attach(image,url,{onUnavailable(){unavailable++;}});
  const event = (type,width=0,height=0,currentSrc=src) => {image.currentSrc=currentSrc;image.naturalWidth=width;image.naturalHeight=height;handlers.get(type)?.();};
  return {image,requests,handlers,controller,event,get unavailable(){return unavailable;},sizes:()=>requests.map(value=>value.split('/').at(-1))};
}

test('first assignment requests only maxres on the existing lazy image with fixed 16:9 hints and no referrer',()=>{
  const f=fixture();assert.deepEqual(f.sizes(),['maxresdefault.jpg']);
  assert.equal(f.image.loading,'lazy');assert.equal(f.image.decoding,'async');assert.equal(f.image.referrerPolicy,'no-referrer');assert.equal(f.image.alt,'');
  assert.equal(f.image.width,1280);assert.equal(f.image.height,720);
  f.event('load',1280,720);assert.deepEqual(f.sizes(),['maxresdefault.jpg']);assert.equal(f.handlers.size,0);assert.equal(f.unavailable,0);
});

test('a failed maxres tries standard once and stops after a valid standard image',()=>{
  const f=fixture();f.event('error');assert.deepEqual(f.sizes(),['maxresdefault.jpg','sddefault.jpg']);
  f.event('load',640,480);assert.equal(f.requests.length,2);assert.equal(f.image.hidden,false);assert.equal(f.unavailable,0);
  assert.equal(f.image.width,1280);assert.equal(f.image.height,720);f.event('error');assert.equal(f.requests.length,2);
});

test('successful tiny placeholders fall through every candidate until a usable medium image, without loops',()=>{
  const f=fixture();for(let i=0;i<3;i++)f.event('load',120,90);
  assert.deepEqual(f.sizes(),['maxresdefault.jpg','sddefault.jpg','hqdefault.jpg','mqdefault.jpg']);
  f.event('load',320,180);assert.equal(f.requests.length,4);assert.equal(f.image.hidden,false);assert.equal(f.unavailable,0);
});

test('undersized HTTP-success maxres also falls back; a nonstandard but sufficiently detailed image is accepted',()=>{
  const f=fixture();f.event('load',320,180);assert.deepEqual(f.sizes(),['maxresdefault.jpg','sddefault.jpg']);
  f.event('load',640,480);assert.equal(f.requests.length,2);
  const alternate=fixture();alternate.event('load',960,540);assert.equal(alternate.requests.length,1);assert.equal(alternate.handlers.size,0);
});

test('terminal errors or placeholders report unavailability once, hide the broken image and never change reserved dimensions',()=>{
  for(const type of ['error','load']) {
    const f=fixture();const late=f.handlers.get(type);
    for(let i=0;i<4;i++)f.event(type,120,90);
    assert.equal(f.unavailable,1);assert.equal(f.image.hidden,true);assert.equal(f.requests.length,4);assert.equal(f.handlers.size,0);
    late();f.event(type,120,90);assert.equal(f.unavailable,1);assert.equal(f.requests.length,4);assert.equal(f.image.width,1280);assert.equal(f.image.height,720);
  }
});

test('stale candidate events and callbacks after row cleanup cannot start another request',()=>{
  const f=fixture(), old=f.image.src;f.event('error');const expected=f.image.src;
  f.event('load',120,90,old);f.event('error',0,0,old);assert.equal(f.image.src,expected);assert.equal(f.requests.length,2);
  const late=f.handlers.get('error');f.controller.destroy();late();assert.equal(f.requests.length,2);assert.equal(f.handlers.size,0);assert.equal(f.unavailable,0);
});

test('canonical video IDs stay on the fixed YouTube image origin and invalid URLs never request an image',()=>{
  const valid=fixture('https://youtu.be/fixture_video?t=30');assert.equal(valid.image.src,'https://i.ytimg.com/vi/fixture_video/maxresdefault.jpg');
  for(const url of ['https://evil.example/watch?v=fixture_video','javascript:alert(1)','https://youtube.com/watch?v=bad/path']) {
    const f=fixture(url);assert.equal(f.requests.length,0);assert.equal(f.unavailable,1);assert.equal(f.image.hidden,true);
  }
});

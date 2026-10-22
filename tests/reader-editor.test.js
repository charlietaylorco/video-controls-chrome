// Real script-free editor against controlled frame documents. Browser sandbox and
// native event propagation are deliberately not simulated by this DOM fixture.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function fixture(){
 const input=[],escapes=[],documents=[];let frame,reads=0;
 const makeDocument=()=>{
  const created=[],events=new Map();
  const node=tag=>{
   const item={tag,children:[],attributes:{},events:new Map(),style:{setProperty(key,value){this[key]=value;}},
    append(...children){this.children.push(...children);},replaceChildren(...children){this.children=[...children];},
    setAttribute(key,value){this.attributes[key]=value;},addEventListener(type,fn){this.events.set(type,fn);},
    fire(type,extra={}){const event={key:'',isComposing:false,prevented:false,preventDefault(){this.prevented=true;},...extra};this.events.get(type)?.(event);return event;}
   };
   if(tag==='textarea'){
    let value='';item.assignments=0;item.selectionStart=item.selectionEnd=0;
    Object.defineProperty(item,'value',{get:()=>value,set(next){value=next;item.assignments++;item.selectionStart=item.selectionEnd=next.length;}});
   }
   created.push(item);return item;
  };
  const doc={created,events,createElement:node,documentElement:node('html'),head:node('head'),body:node('body'),addEventListener(type,fn){events.set(type,fn);},
   fire(type,extra={}){const event={key:'',isComposing:false,prevented:false,preventDefault(){this.prevented=true;},...extra};events.get(type)?.(event);return event;}};
  documents.push(doc);return doc;
 };
 const parentEvents=new Map(),blur=new Map();let current=null;
 const document={addEventListener(type,fn){parentEvents.set(type,fn);},createElement(tag){assert.equal(tag,'iframe');frame={attributes:{},events:new Map(),setAttribute(key,value){this.attributes[key]=value;},addEventListener(type,fn){this.events.set(type,fn);},get contentDocument(){reads++;return current;},contentWindow:{addEventListener(type,fn){blur.set(type,fn);}}};return frame;}};
 const context=vm.createContext({document});vm.runInContext(fs.readFileSync(path.join(__dirname,'..','reader-editor.js'),'utf8'),context);
 const editor=context.MVSReaderEditor.create({onInput:value=>input.push(value),onEscape:()=>escapes.push(true)});
 return{editor,input,escapes,frame,documents,parentEvents,blur,makeDocument,get reads(){return reads;},
  mount(doc=makeDocument()){current=doc;frame.events.get('load')();return doc;},
  field:()=>current?.body?.children[0]};
}

test('creating a detached editor reads no frame document and retains the exact script-blocking sandbox',()=>{
 const f=fixture();assert.equal(f.reads,0);assert.equal(f.frame.title,'Document Note');assert.equal(f.frame.attributes.sandbox,'allow-same-origin');
 assert.equal(f.frame.attributes.src,undefined);assert.equal(f.frame.attributes.srcdoc,undefined);assert.equal(f.documents.length,0);
 f.editor.value='Draft before mounting';f.editor.setTheme('dark');f.editor.mount();assert.equal(f.editor.value,'Draft before mounting');
 const doc=f.mount();assert.equal(f.field().value,'Draft before mounting');assert.equal(doc.body.style.background,'#1b1c20');
 assert.deepEqual(doc.created.map(n=>n.tag),['html','head','body','style','textarea']);assert.equal(f.parentEvents.size,0);
});

test('mounted edits remain literal text; equal-value updates, repeated mounts and themes preserve native selection nodes',()=>{
 const f=fixture();const doc=f.mount(),field=f.field(),hostile='<script>bad()</script><img onerror=bad()>\n日本語';
 field.value=hostile;field.fire('input');assert.equal(f.editor.value,hostile);assert.deepEqual(f.input,[hostile]);
 field.selectionStart=2;field.selectionEnd=7;const assignments=field.assignments;
 f.editor.value=hostile;f.editor.mount();f.editor.mount();f.editor.setTheme('dark');f.editor.setTheme('light');
 assert.equal(f.field(),field);assert.equal(field.assignments,assignments);assert.equal(field.selectionStart,2);assert.equal(field.selectionEnd,7);
 assert.equal(doc.created.filter(n=>n.tag==='textarea').length,1);assert.equal(doc.body.children.length,1);
 assert.equal(doc.created.some(n=>n.tag==='script'||n.tag==='img'),false);
});

test('a replaced frame document restores cached draft/theme and attaches one new native textarea',()=>{
 const f=fixture();f.mount();f.field().value='Draft across remount';f.field().fire('input');f.editor.setTheme('dark');
 const replacement=f.mount();assert.equal(f.field().value,'Draft across remount');assert.equal(replacement.body.style.background,'#1b1c20');
 f.editor.mount();assert.equal(replacement.created.filter(n=>n.tag==='textarea').length,1);f.field().value+=' + next';f.field().fire('input');
 assert.equal(f.editor.value,'Draft across remount + next');assert.deepEqual(f.input,['Draft across remount','Draft across remount + next']);
});

test('native editing keys retain defaults, composition Escape stays local and completed Escape/blur use the existing callback path',()=>{
 const f=fixture(),doc=f.mount(),field=f.field();
 for(const key of [' ','j','k','ArrowLeft','ArrowRight','c'])assert.equal(doc.fire('keydown',{key,ctrlKey:key==='c'}).prevented,false);
 field.fire('compositionstart');assert.equal(doc.fire('keydown',{key:'Escape'}).prevented,false);doc.fire('keyup',{key:'Escape'});assert.equal(f.escapes.length,0);
 field.fire('compositionend');assert.equal(doc.fire('keydown',{key:'Escape',isComposing:true}).prevented,false);
 assert.equal(doc.fire('keydown',{key:'Escape'}).prevented,true);assert.equal(doc.fire('keyup',{key:'Escape'}).prevented,true);assert.equal(f.escapes.length,1);
 doc.fire('keydown',{key:'Escape'});f.blur.get('blur')();doc.fire('keyup',{key:'Escape'});assert.equal(f.escapes.length,1);assert.equal(f.parentEvents.size,0);
});

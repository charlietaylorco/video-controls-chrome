import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, [path.join(root,'web/scripts/build.mjs')], {cwd:root,stdio:'inherit'});
const source=path.join(root,'web/dist'),site=path.join(root,'watchlater');
await mkdir(path.join(site,'app/generated'),{recursive:true});
await mkdir(path.join(site,'public'),{recursive:true});
for(const name of await readdir(source)){
 let data=await readFile(path.join(source,name),'utf8');
 // Hosted HTML must select the matching assets after a new deployment, even
 // when the browser has cached a previous player's script.
 if(name.endsWith('.html')){
  for(const match of [...data.matchAll(/(?:src|href)="(\/?[\w.-]+\.(?:js|css))"/g)]){
   const asset=await readFile(path.join(source,path.basename(match[1])));
   const version=createHash('sha256').update(asset).digest('hex').slice(0,12);
   data=data.replace(match[0],match[0].slice(0,-1)+`?v=${version}"`);
  }
 }
 if(name==='index.html') await writeFile(path.join(site,'app/generated/library.html'),data);
 else if(name==='settings.html') await writeFile(path.join(site,'app/generated/settings.html'),data);
 else await copyFile(path.join(source,name),path.join(site,'public',name));
}
console.log('Prepared standalone Watchlater UI assets.');

import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, [path.join(root,'web/scripts/build.mjs')], {cwd:root,stdio:'inherit'});
const source=path.join(root,'web/dist'),site=path.join(root,'watchlater');
await mkdir(path.join(site,'app/generated'),{recursive:true});
await mkdir(path.join(site,'public'),{recursive:true});
for(const name of await readdir(source)){
 const data=await readFile(path.join(source,name),'utf8');
 if(name==='index.html') await writeFile(path.join(site,'app/generated/library.html'),data.replace('<title>Recent saves</title>','<title>Watchlater</title>').replace('<h1>Recent saves</h1>','<h1>Watchlater</h1>'));
 else if(name==='settings.html') await writeFile(path.join(site,'app/generated/settings.html'),data);
 else await copyFile(path.join(source,name),path.join(site,'public',name));
}
console.log('Prepared standalone Watchlater UI assets.');

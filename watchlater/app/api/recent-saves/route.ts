import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../chatgpt-auth';
import { createApi } from '../../../lib/api.mjs';
import { createDatabase } from '../../../lib/database.mjs';
export const dynamic = 'force-dynamic';
const json = (data: unknown, status=200) => Response.json(data, {status, headers:{'Cache-Control':'no-store, private','Referrer-Policy':'strict-origin-when-cross-origin'}});
const makeApi = (origin: string) => createApi({ db:createDatabase(env.DB), env: { ...env, APP_ORIGIN:origin } });
export async function GET(request: Request) {
 if (new URL(request.url).searchParams.get('type') !== 'cloud-status') return json({ok:false,code:'method_not_allowed'},405);
 const user=await getChatGPTUser();
 if (!user) return json({ok:true,configured:Boolean(env.DB),authenticated:false,authProvider:'chatgpt'});
 if (!env.DB) return json({ok:false,code:'not_configured'},503);
 try { return json(await makeApi(new URL(request.url).origin).status({ownerId:'owner',device:false})); }
 catch { return json({ok:false,code:'storage_error'},503); }
}
export async function POST(request: Request) {
 const user=await getChatGPTUser();
 if (!user) return json({ok:false,code:'auth_required'},401);
 const origin = new URL(request.url).origin;
 if(request.headers.get('Origin') !== origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') return json({ok:false,code:'invalid_origin'},403);
 if(!env.DB) return json({ok:false,code:'not_configured'},503);
 if(!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return json({ok:false,code:'invalid_request'},400);
 const maximum=4*1024*1024;
 if(Number(request.headers.get('Content-Length'))>maximum) return json({ok:false,code:'invalid_request'},413);
 let message;
 try {
  const reader=request.body?.getReader(); if(!reader) throw Error();
  const parts:Uint8Array[]=[]; let length=0;
  while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>maximum){await reader.cancel();throw Error();}parts.push(value);}
  const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  message=JSON.parse(new TextDecoder().decode(bytes));
  if(!message || typeof message !== 'object' || Array.isArray(message)) throw Error();
 } catch {return json({ok:false,code:'invalid_request'},400);}
 const authorization=request.headers.get('Authorization');
 const deviceToken=authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
 if(authorization && !deviceToken) return json({ok:false,code:'unauthorized'},401);
 try {
  const result=await makeApi(origin).handle(message,{ownerId:'owner',device:Boolean(deviceToken),deviceToken});
  const code=result.code;
  return json(result, result.ok ? 200 : code==='unauthorized' ? 401 : code==='forbidden' ? 403 : 200);
 } catch {return json({ok:false,code:'storage_error'},503);}
}

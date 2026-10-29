import { getChatGPTUser, chatGPTSignInPath } from '../chatgpt-auth';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
 const user = await getChatGPTUser();
 if (!user) return Response.redirect(new URL(chatGPTSignInPath('/extension-sync'),request.url),302);
 return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Watchlater sync</title><body><h1>Watchlater</h1><p>This tab securely syncs your extension saves using your signed-in Sites session. It will close when the transfer finishes.</p><p><a href="/">Open your library</a></p></body></html>', { headers: { 'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store, private' } });
}

import { getChatGPTUser, chatGPTSignInPath } from '../chatgpt-auth';
import html from '../generated/settings.html?raw';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
 const user = await getChatGPTUser();
 if (!user) return Response.redirect(new URL(chatGPTSignInPath('/settings.html'), request.url),302);
 return new Response(html, { headers: { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store, private' } });
}

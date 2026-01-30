import { JWTPayload } from './types';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export const jsonResponse = (data: any, status = 200) => 
  new Response(JSON.stringify(data), { 
    status, 
    headers: { 'Content-Type': 'application/json', ...corsHeaders } 
  });

export const errorResponse = (msg: string, status = 500) => 
  jsonResponse({ success: false, error: msg }, status);

export async function generateJWT(payload: JWTPayload, secret: string): Promise<string> {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify(payload));
  const unsigned = `${header}.${body}`;
  
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(unsigned));
  const sigBase64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  
  return `${unsigned}.${sigBase64}`;
}

export async function verifyJWT(token: string, secret: string): Promise<JWTPayload | null> {
  try {
    const [h, b, s] = token.split('.');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sig = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(`${h}.${b}`));
    if (!valid) return null;
    return JSON.parse(atob(b));
  } catch { return null; }
}

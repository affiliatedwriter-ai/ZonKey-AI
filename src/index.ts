import { Router } from 'itty-router';
import { corsHeaders, jsonResponse, errorResponse, generateJWT, verifyJWT } from './utils';
import { handleDodoWebhook } from './webhook';
import { handleScoreProducts } from './score-products';

interface Env {
  DB: D1Database;
  JWT_SECRET: string;
  DODO_API_KEY: string;
  AI_API_KEY: string;
  RESEND_API_KEY: string;
  DODO_WEBHOOK_SECRET: string;
}

const router = Router();

const MAX_DEVICES_PER_LICENSE = 2;

// ================= HASH =================

async function sha256(str: string) {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ================= DEVICE SESSION =================

async function getOrCreateDeviceSession(
  userId: string,
  licenseKey: string,
  clientFingerprint: string,
  agent: string,
  env: Env
) {
  const deviceHash = await sha256(clientFingerprint + agent + userId + env.JWT_SECRET);

  const now = Math.floor(Date.now() / 1000);
  const today = Math.floor(new Date().setHours(0,0,0,0)/1000);

  // ✅ FIX 1: Check existing device FIRST before checking device count
  const existing = await env.DB.prepare(
    `SELECT * FROM device_sessions WHERE user_id=? AND device_hash=?`
  ).bind(userId, deviceHash).first() as any;

  if (existing) {
    // Same device logging in - just update and return
    if ((existing.daily_reset_at || 0) < today) {
      await env.DB.prepare(
        `UPDATE device_sessions SET daily_requests=0,daily_reset_at=?,last_used=? WHERE id=?`
      ).bind(today, now, existing.id).run();
      existing.daily_requests = 0;
    } else {
      await env.DB.prepare(
        `UPDATE device_sessions SET last_used=? WHERE id=?`
      ).bind(now, existing.id).run();
    }
    return existing;
  }

  // New device - check if we can add more devices
  const activeCount = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM device_sessions WHERE user_id=? AND is_active=1`
  ).bind(userId).first() as { c:number };

  if ((activeCount?.c || 0) >= MAX_DEVICES_PER_LICENSE) {
    throw new Error('DEVICE_LIMIT_REACHED');
  }

  const id = crypto.randomUUID();

  await env.DB.prepare(`
    INSERT INTO device_sessions(
      id,user_id,license_key,
      device_fingerprint,device_hash,
      browser_agent,created_at,last_used,
      daily_requests,daily_reset_at,is_active
    ) VALUES(?,?,?,?,?,?,?,?,?,?,1)
  `).bind(
    id,userId,licenseKey,
    clientFingerprint,deviceHash,
    agent,now,now,0,today
  ).run();

  return { id, daily_requests:0 };
}

async function incrementDeviceUsage(id:string, env:Env) {
  await env.DB.prepare(
    `UPDATE device_sessions SET daily_requests=daily_requests+1 WHERE id=?`
  ).bind(id).run();
}

// ================= ROUTES =================

router.options('*', () => new Response(null,{headers:corsHeaders}));

router.get('/health',()=>jsonResponse({ok:true}));

// ================= USER STATS =================

router.get('/api/user/stats', async (req:Request, env:Env) => {
  try {

    const token = req.headers.get('Authorization')?.replace('Bearer ','') || '';
    const deviceId = req.headers.get('X-Device-ID') || '';
    const agent = req.headers.get('X-Device-Agent') || '';

    const payload:any = await verifyJWT(token, env.JWT_SECRET);
    if (!payload) return errorResponse('Unauthorized',401);

    const user = await env.DB.prepare(
      `SELECT id,license_key FROM users WHERE license_key=?`
    ).bind(payload.sub).first() as any;

    if (!user) return errorResponse('User not found',404);

    let session;
    try {
      session = await getOrCreateDeviceSession(user.id,user.license_key,deviceId,agent,env);
    } catch (e: any) {
      if (e.message === 'DEVICE_LIMIT_REACHED') {
        return errorResponse('Device limit reached - Max 2 devices per license',403);
      }
      return errorResponse(e.message,403);
    }

    // ✅ FIX: Get quota with max_batch_size
    const quota = await env.DB.prepare(
      `SELECT daily_limit,monthly_limit,max_batch_size FROM plan_quotas WHERE plan=?`
    ).bind(payload.plan).first() as any;

    if (!quota) {
      return errorResponse('Plan quota not found',404);
    }

    // ✅ Get total usage across all devices for this license
    const today = Math.floor(new Date().setHours(0,0,0,0)/1000);
    const totalUsage = await env.DB.prepare(`
      SELECT SUM(daily_requests) as t FROM device_sessions
      WHERE user_id=? AND daily_reset_at>=?
    `).bind(user.id, today).first() as any;

    const totalUsed = totalUsage?.t || 0;
    const dailyLimit = quota.daily_limit || 10;
    const monthlyLimit = quota.monthly_limit || 1000;
    const maxBatchSize = quota.max_batch_size || 10;
    const canUse = totalUsed < dailyLimit;

    return jsonResponse({
      success: true,
      daily_used: totalUsed,
      daily_limit: dailyLimit,
      daily_remaining: Math.max(0, dailyLimit - totalUsed),
      monthly_limit: monthlyLimit,
      max_batch_size: maxBatchSize,
      device_used: session.daily_requests || 0,
      can_use: canUse,
      plan: payload.plan
    });

  } catch(e:any) {
    console.error('[STATS] Error:', e.message, e.stack);
    return errorResponse(`Stats Error: ${e.message}`, 500);
  }
});

// ================= AUTH =================

router.post('/api/auth/validate', async (req:Request, env:Env) => {
  try {

    const { license_key } = await req.json() as any;
    if (!license_key) return errorResponse('License key required',400);

    const local = await env.DB.prepare(
      `SELECT * FROM users WHERE license_key=?`
    ).bind(license_key).first() as any;

    const now = Math.floor(Date.now()/1000);

    if (local) {

      if (local.status !== 'active') return errorResponse('License inactive',403);
      if (local.expires_at < now) return errorResponse('License expired',403);

      const token = await generateJWT({
        sub: license_key,
        plan: local.plan,
        iat: Date.now(),
        exp: local.expires_at
      }, env.JWT_SECRET);

      const quota = await env.DB.prepare(
        `SELECT * FROM plan_quotas WHERE plan=?`
      ).bind(local.plan).first();

      return jsonResponse({
        success:true,
        token,
        user:{
          email: local.email,
          plan: local.plan,
          quota,
          expiry_date: new Date(local.expires_at*1000).toISOString()
        }
      });
    }

    // === DODO VERIFY ===

    const dodo = await fetch('https://test.dodopayments.com/api/v1/licenses/validate',{
      method:'POST',
      headers:{
        Authorization:`Bearer ${env.DODO_API_KEY}`,
        'Content-Type':'application/json'
      },
      body:JSON.stringify({license_key})
    });

    if (!dodo.ok) return errorResponse('Invalid license',403);

    const lic = await fetch(`https://test.dodopayments.com/api/v1/licenses/${license_key}`,{
      headers:{Authorization:`Bearer ${env.DODO_API_KEY}`}
    });

    const licData:any = await lic.json();

    const plan = licData?.metadata?.plan_type || 'monthly';
    const email = licData?.customer?.email || `user_${license_key.slice(0,6)}@zonkey.ai`;

    let duration = 30*86400;
    if(plan==='yearly') duration = 365*86400;
    if(plan==='lifetime') duration = 100*365*86400;

    const expires = now + duration;

    await env.DB.prepare(`
      INSERT INTO users(id,email,license_key,plan,created_at,expires_at,status)
      VALUES(?,?,?,?,?,?, 'active')
      ON CONFLICT(license_key)
      DO UPDATE SET plan=excluded.plan,expires_at=excluded.expires_at
    `).bind(
      crypto.randomUUID(),email,license_key,plan,now,expires
    ).run();

    const token = await generateJWT({
      sub: license_key,
      plan,
      iat: Date.now(),
      exp: expires
    }, env.JWT_SECRET);

    const quota = await env.DB.prepare(
      `SELECT * FROM plan_quotas WHERE plan=?`
    ).bind(plan).first();

    return jsonResponse({
      success:true,
      token,
      user:{
        email,
        plan,
        quota,
        expiry_date:new Date(expires*1000).toISOString()
      }
    });

  } catch(e:any){
    return errorResponse(e.message,500);
  }
});

// ================= KEYWORD GENERATION =================

router.post('/api/ai/generate-keywords', async (req:Request, env:Env) => {
  try {

    const token=req.headers.get('Authorization')?.replace('Bearer ','')||'';
    const deviceId=req.headers.get('X-Device-ID')||'';
    const agent=req.headers.get('X-Device-Agent')||'';

    const payload:any = await verifyJWT(token,env.JWT_SECRET);
    if(!payload) return errorResponse('Unauthorized',401);

    const user=await env.DB.prepare(
      `SELECT id,license_key FROM users WHERE license_key=?`
    ).bind(payload.sub).first() as any;

    if(!user) return errorResponse('User not found',404);

    let session;
    try{
      session=await getOrCreateDeviceSession(user.id,user.license_key,deviceId,agent,env);
    }catch(e: any){
      if (e.message === 'DEVICE_LIMIT_REACHED') {
        return errorResponse('Device limit reached - Max 2 devices per license',403);
      }
      return errorResponse(e.message,403);
    }

    const quota=await env.DB.prepare(
      `SELECT daily_limit FROM plan_quotas WHERE plan=?`
    ).bind(payload.plan).first() as any;

    const today = Math.floor(new Date().setHours(0,0,0,0)/1000);

    const total = await env.DB.prepare(`
      SELECT SUM(daily_requests) as t
      FROM device_sessions
      WHERE user_id=? AND daily_reset_at>=?
    `).bind(user.id,today).first() as any;

    const used = total?.t || 0;
    const dailyLimit = quota?.daily_limit||10;

    if(used >= dailyLimit){
      return errorResponse(`Daily limit exceeded - Used ${used}/${dailyLimit}`,429);
    }

    const { titles } = await req.json() as any;
    if(!Array.isArray(titles)||!titles.length) return errorResponse('No titles',400);

    const keyRow=await env.DB.prepare(
      `SELECT api_key FROM system_api_keys WHERE provider='deepseek' AND is_active=1 LIMIT 1`
    ).first() as any;

    if (!keyRow?.api_key) {
      return errorResponse('AI service not configured',500);
    }

    const prompt = `You are a keyword research expert for Amazon products.

Given these product titles, generate 4 keywords for different content types.

Return ONLY this JSON structure, nothing else:

[
  {
    "review":"keyword for review article",
    "comparison":"keyword for comparison article",
    "howto":"keyword for how-to guide",
    "roundup":"keyword for roundup/list article"
  }
]

Product Titles:
${titles.join('\n')}`;

    const ai = await fetch('https://api.deepseek.com/v1/chat/completions',{
      method:'POST',
      headers:{
        Authorization:`Bearer ${keyRow.api_key}`,
        'Content-Type':'application/json'
      },
      body:JSON.stringify({
        model:'deepseek-chat',
        temperature: 0.7,
        max_tokens: 1000,
        messages:[
          {
            role:'system',
            content:'Return ONLY valid JSON. No markdown, no extra text.'
          },
          {
            role:'user',
            content: prompt
          }
        ]
      })
    });

    if (!ai.ok) {
      const errorText = await ai.text();
      console.error('[KEYWORDS] ❌ DeepSeek error:', errorText);
      return errorResponse(`AI service error: ${ai.statusText}`, 500);
    }

    const data:any = await ai.json();
    let content = data.choices?.[0]?.message?.content || '[]';

    let flatResult: string[] = [];

    try {
      content = content.replace(/```json/g, '').replace(/```/g, '').trim();
      const start = content.indexOf('[');
      const end = content.lastIndexOf(']');

      if (start !== -1 && end !== -1) {
        content = content.slice(start, end + 1);
      }

      const parsed: any = JSON.parse(content);

      if (Array.isArray(parsed)) {
        if (parsed.length === 1 && typeof parsed[0] === 'object') {
          const obj = parsed[0] as Record<string, any>;
          flatResult = Object.values(obj)
            .filter((v: any) => v && String(v).trim().length > 0)
            .map((v: any) => String(v).trim());
        } else {
          flatResult = parsed.map((item: any): string => {
            if (typeof item === 'string') return item.trim();
            if (typeof item === 'object' && item !== null) {
              const values = Object.values(item);
              return String(values[0] || '').trim();
            }
            return '';
          }).filter((v: string) => v && v.length > 0);
        }
      } else if (typeof parsed === 'object' && parsed !== null) {
        flatResult = Object.values(parsed)
          .filter((v: any) => v && String(v).trim().length > 0)
          .map((v: any) => String(v).trim());
      }

    } catch (parseError: any) {
      const lines = content.split('\n').filter((line: string) => line.trim().length > 0);
      flatResult = lines
        .map((line: string) => {
          const cleaned = line.replace(/[^\w\s]/g, '').trim();
          return cleaned.length > 0 ? cleaned : '';
        })
        .filter((v: string) => v && v.length > 0);
    }

    if (!Array.isArray(flatResult)) {
      flatResult = [];
    }

    await incrementDeviceUsage(session.id, env);

    await env.DB.prepare(
      `INSERT INTO usage_logs(user_id,action,metadata)
       VALUES(?,?,?)`
    ).bind(user.id, 'generate_keywords', JSON.stringify({
      titles_count: titles.length,
      keywords_generated: flatResult.length
    })).run();

    return jsonResponse({ success: true, result: flatResult });

  } catch(e:any){
    console.error('[KEYWORDS] ❌ Error:', e.message);
    return errorResponse(e.message, 500);
  }
});

// ================= AI PROCESS =================

router.post('/api/ai/process', async (req:Request, env:Env) => {
  try {

    const token=req.headers.get('Authorization')?.replace('Bearer ','')||'';
    const deviceId=req.headers.get('X-Device-ID')||'';
    const agent=req.headers.get('X-Device-Agent')||'';

    const payload:any = await verifyJWT(token,env.JWT_SECRET);
    if(!payload) return errorResponse('Unauthorized',401);

    const user=await env.DB.prepare(
      `SELECT id,license_key FROM users WHERE license_key=?`
    ).bind(payload.sub).first() as any;

    if(!user) return errorResponse('User not found',404);

    let session;
    try{
      session=await getOrCreateDeviceSession(user.id,user.license_key,deviceId,agent,env);
    }catch(e: any){
      if (e.message === 'DEVICE_LIMIT_REACHED') {
        return errorResponse('Device limit reached - Max 2 devices per license',403);
      }
      return errorResponse(e.message,403);
    }

    const quota=await env.DB.prepare(
      `SELECT daily_limit FROM plan_quotas WHERE plan=?`
    ).bind(payload.plan).first() as any;

    const today = Math.floor(new Date().setHours(0,0,0,0)/1000);

    const total = await env.DB.prepare(`
      SELECT SUM(daily_requests) as t
      FROM device_sessions
      WHERE user_id=? AND daily_reset_at>=?
    `).bind(user.id,today).first() as any;

    const used = total?.t || 0;
    const dailyLimit = quota?.daily_limit||10;

    if(used >= dailyLimit){
      return errorResponse(`Daily limit exceeded - Used ${used}/${dailyLimit}`,429);
    }

    const body=await req.json() as any;

    const apiRow=await env.DB.prepare(
      `SELECT provider,api_key,model FROM system_api_keys WHERE is_active=1 LIMIT 1`
    ).first() as any;

    const provider=apiRow?.provider||'openai';
    const apiKey=apiRow?.api_key||env.AI_API_KEY;
    const model=apiRow?.model||'gpt-4o-mini';

    const endpoint=provider==='deepseek'
      ? 'https://api.deepseek.com/v1/chat/completions'
      : 'https://api.openai.com/v1/chat/completions';

    const prompt=`Categorize keywords into categories. Return ONLY JSON.
Categories: ${body.categories?.join(', ') || 'Reviews, Comparisons, Guides, Best Lists, How-To, Problems'}

Keywords:
${body.data.join('\n')}

Return format (JSON only):
{
  "category_name": ["keyword1", "keyword2"]
}`;

    const ai=await fetch(endpoint,{
      method:'POST',
      headers:{
        Authorization:`Bearer ${apiKey}`,
        'Content-Type':'application/json'
      },
      body:JSON.stringify({
        model,
        temperature: 0.7,
        max_tokens: 2000,
        messages:[
          {role:'system',content:'Return ONLY valid JSON object'},
          {role:'user',content:prompt}
        ]
      })
    });

    if (!ai.ok) {
      return errorResponse(`AI service error: ${ai.statusText}`, 500);
    }

    const raw:any=await ai.json();
    let result=raw.choices?.[0]?.message?.content||'{}';

    try{
      result = result.replace(/```json/g, '').replace(/```/g, '').trim();
      const start = result.indexOf('{');
      const end = result.lastIndexOf('}');
      if (start !== -1 && end !== -1) {
        result = result.slice(start, end + 1);
      }
      result=JSON.parse(result);
    }catch{
      result={};
    }

    await incrementDeviceUsage(session.id,env);

    return jsonResponse({success:true,result});

  }catch(e:any){
    console.error('[AI] ❌ Error:', e.message);
    return errorResponse(e.message,500);
  }
});

// ================= PRODUCT SCORE =================

router.post('/api/score-products', handleScoreProducts);

// ================= WEBHOOK =================

router.post('/v1/webhooks/dodo', async (r:Request, env:Env, ctx:ExecutionContext)=>{
  return await handleDodoWebhook(r,env,ctx);
});

router.all('*',()=>errorResponse('Not Found',404));

// ================= EXPORT =================

export default {
  async fetch(request:Request, env:Env, ctx:ExecutionContext):Promise<Response>{
    try{

      const url=new URL(request.url);
      if(url.pathname==='/v1/webhooks/dodo' && request.method==='POST'){
        return await handleDodoWebhook(request,env,ctx);
      }

      return await router.fetch(request,env,ctx);

    }catch(e:any){
      return errorResponse(e.message||'Internal Error',500);
    }
  }
};
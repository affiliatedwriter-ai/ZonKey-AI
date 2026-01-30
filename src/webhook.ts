// worker/src/webhook.ts

import { Env } from './types';
import { sendLicenseEmail } from './email';

// Product Configuration - ✅ সঠিক duration সহ
const PRODUCTS: Record<string, { plan: string; durationDays: number; name: string }> = {
  // Monthly Plan - 30 days
  'pdt_0NWZwZB3eia1vz1BCOw6C': { plan: 'monthly', durationDays: 30, name: 'Monthly Pro' },
  // Yearly Plan - 365 days
  'pdt_0NWa2tSwTrvneWU2Yh423': { plan: 'yearly', durationDays: 365, name: 'Yearly Pro' },
  // Lifetime Deal - 100 years (36500 days)
  'pdt_0NWZx6IG1WxAoyOv9korR': { plan: 'lifetime', durationDays: 36500, name: 'Lifetime Deal' }
};

// ✅ License key generator with proper template literals
function generateKey(plan: string): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let random = '';
  for (let i = 0; i < 12; i++) random += chars.charAt(Math.floor(Math.random() * chars.length));
  return `AKH-${plan.toUpperCase()}-${random.substring(0, 4)}-${random.substring(4, 8)}-${random.substring(8)}`;
}

// Store processed webhook IDs to prevent duplicates
const processedWebhooks = new Set<string>();

// Helper to convert base64 to Uint8Array
function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// Helper to convert Uint8Array to base64
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Web Crypto signature verification (Svix/Dodo format)
async function verifySignature(
  payload: string, 
  signature: string, 
  timestamp: string, 
  webhookId: string, 
  secret: string
): Promise<boolean> {
  try {
    const encoder = new TextEncoder();
    
    // Extract the actual secret (remove 'whsec_' prefix if present)
    const secretKey = secret.startsWith('whsec_') ? secret.slice(6) : secret;
    
    console.log(`🔐 Secret prefix check: starts with whsec_=${secret.startsWith('whsec_')}`);
    console.log(`🔐 Secret key length after prefix removal: ${secretKey.length}`);
    
    // Decode the base64 secret
    let keyData: Uint8Array;
    try {
      keyData = base64ToUint8Array(secretKey);
      console.log(`🔐 Decoded key length: ${keyData.length} bytes`);
    } catch (decodeErr) {
      console.error('Failed to decode secret as base64:', decodeErr);
      // Fallback: Try using the secret directly as UTF-8
      keyData = encoder.encode(secretKey);
      console.log(`🔐 Using secret as UTF-8, length: ${keyData.length} bytes`);
    }
    
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify']
    );

    // Svix signature format: {msg_id}.{timestamp}.{payload}
    const signedData = `${webhookId}.${timestamp}.${payload}`;
    console.log(`🔐 Signed data preview: ${signedData.substring(0, 80)}...`);
    
    const expectedSignature = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(signedData)
    );

    // Convert to base64 for comparison (Svix/Dodo uses base64)
    const expectedSignatureBase64 = uint8ArrayToBase64(new Uint8Array(expectedSignature));
    console.log(`🔐 Expected signature: ${expectedSignatureBase64.substring(0, 20)}...`);

    // Parse the signature header - format: "v1,<sig1> v1,<sig2>"
    const signatures = signature.split(' ').map(s => s.replace('v1,', ''));
    console.log(`🔐 Received signatures: ${signatures.map(s => s.substring(0, 20) + '...').join(', ')}`);
    
    // Check if any of the provided signatures match
    const isValid = signatures.some(sig => sig === expectedSignatureBase64);
    console.log(`🔐 Signature match: ${isValid}`);
    
    return isValid;
  } catch (e) {
    console.error('Signature verification error:', e);
    return false;
  }
}

export async function handleDodoWebhook(
  request: Request, 
  env: Env, 
  ctx: ExecutionContext
): Promise<Response> {
  try {
    // SAFETY: Check if request body exists first
    if (!request.body) {
      return new Response(JSON.stringify({ error: "No request body" }), { status: 400 });
    }

    const webhookId = request.headers.get("webhook-id") || "";
    const webhookSig = request.headers.get("webhook-signature") || "";
    const webhookTs = request.headers.get("webhook-timestamp") || "";

    // DEBUG: Log all headers for debugging
    console.log("🔍 DEBUG - All headers:");
    for (const [key, value] of request.headers.entries()) {
      console.log(`${key}: ${value}`);
    }
    
    console.log(`🔍 Webhook ID: "${webhookId}"`);
    console.log(`🔍 Signature: "${webhookSig}"`);
    console.log(`🔍 Timestamp: "${webhookTs}"`);

    // SAFETY: Clone request before reading body
    const requestClone = request.clone();
    
    // IMPORTANT: Read RAW body as text once
    const rawBody = await requestClone.text();
    console.log(`📦 Raw Body: "${rawBody}"`);

    // SAFETY: Validate inputs
    if (!webhookId || !webhookSig || !webhookTs) {
      return new Response(JSON.stringify({ 
        error: "Missing required headers",
        headers: { 
          'webhook-id': webhookId,
          'webhook-signature': webhookSig,
          'webhook-timestamp': webhookTs
        }
      }), { status: 400 });
    }

    // ✅ Check if webhook secret is configured
    if (!env.DODO_WEBHOOK_SECRET) {
      console.error('❌ DODO_WEBHOOK_SECRET is not configured');
      console.warn('⚠️ Skipping signature verification - secret not configured');
    } else {
      // ✅ Verify webhook signature
      const isValid = await verifySignature(rawBody, webhookSig, webhookTs, webhookId, env.DODO_WEBHOOK_SECRET);

      console.log(`✅ Signature Valid: ${isValid}`);

      if (!isValid) {
        console.error('❌ Invalid webhook signature');
        // DEBUG info
        const signedMessage = `${webhookId}.${webhookTs}.${rawBody}`;
        console.log(`Signed Message: "${signedMessage}"`);
        
        return new Response(JSON.stringify({ 
          error: "Invalid signature",
          debug: {
            webhookId,
            webhookSig,
            webhookTs,
            rawBody: rawBody.substring(0, 100) + '...'
          }
        }), { status: 401 });
      }
      console.log('✅ Webhook signature verified');
    }

    // ✅ Check for duplicate webhooks
    if (processedWebhooks.has(webhookId)) {
      console.log(`⚠️ Duplicate webhook ${webhookId}, skipping`);
      return new Response(JSON.stringify({ received: true, duplicate: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    processedWebhooks.add(webhookId);

    // ✅ Parse JSON payload
    let payload: { type: string; data: unknown };
    try {
      payload = JSON.parse(rawBody);
    } catch (e: unknown) {
      const error = e instanceof Error ? e.message : 'Unknown parse error';
      console.error('❌ Failed to parse JSON:', error);
      return new Response(JSON.stringify({ error: 'Invalid JSON payload' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    console.log(`📦 Webhook Event Type: ${payload.type}`);

    const { type, data } = payload;
    
    // ✅ Process asynchronously in background using ctx.waitUntil
    ctx.waitUntil(processWebhookAsync(type, data, env));

    return new Response(JSON.stringify({ received: true, webhookId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : 'Unknown error';
    const stack = e instanceof Error ? e.stack : undefined;
    console.error('❌ Webhook Error:', error);
    if (stack) console.error('Stack:', stack);
    return new Response(JSON.stringify({
      error: 'Internal Server Error',
      details: error
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

// ✅ Background processing function - OPTIMIZED EXPIRY CALCULATION
async function processWebhookAsync(type: string, data: unknown, env: Env): Promise<void> {
  try {
    // Type guard for data object
    const webhookData = data as Record<string, unknown>;
    const customer = webhookData.customer as Record<string, unknown> | undefined;
    
    // ✅ Handle failed payments / cancellations
    if (type === 'payment.failed' || type === 'subscription.cancelled' || type === 'subscription.payment_failed') {
      const email = customer?.email || webhookData.customer_email;
      if (email) {
        await env.DB.prepare("UPDATE users SET status = 'expired' WHERE email = ?").bind(email).run();
        console.log(`❌ Deactivated license for: ${email}`);
      }
      return;
    }
    
    // ✅ Handle successful payments
    if (type === 'payment.succeeded' || type === 'subscription.created' || type === 'subscription.active') {
      
      const email = (customer?.email || webhookData.customer_email) as string | undefined;
      const lines = webhookData.lines as Array<Record<string, unknown>> | undefined;
      let productId = (webhookData.product_id || lines?.[0]?.product_id) as string | undefined;
      
      // ✅ Default to monthly if subscription without product_id
      if (!productId && webhookData.subscription_id) {
        console.log(`🔄 Subscription payment detected for ${email}, using default monthly plan`);
        productId = 'pdt_0NWZwZB3eia1vz1BCOw6C';
      }

      console.log(`📧 Email: ${email}`);
      console.log(`🆔 Product ID: ${productId}`);

      if (!email || !productId) {
        console.error('❌ Missing email or productId');
        return;
      }

      // ✅ Get product configuration
      const productConfig = PRODUCTS[productId];
      if (!productConfig) {
        console.error(`❌ Unknown Product ID: ${productId}`);
        return;
      }

      console.log(`💳 Processing ${productConfig.plan} plan (${productConfig.durationDays} days)`);

      interface UserRecord {
        id: string;
        license_key: string;
        expires_at: number;
      }
      
      const existingUser = await env.DB.prepare(
        "SELECT * FROM users WHERE email = ?"
      ).bind(email).first() as UserRecord | null;
      
      let finalLicenseKey = '';
      const now = Math.floor(Date.now() / 1000);
      
      // ✅ CRITICAL: Calculate duration in seconds from product config
      const durationSeconds = productConfig.durationDays * 86400;
      
      console.log(`⏰ Duration: ${productConfig.durationDays} days = ${durationSeconds} seconds`);

      if (existingUser) {
        // ✅ EXISTING USER: Renew/extend license
        console.log(`🔄 Renewing license for: ${email}`);
        finalLicenseKey = existingUser.license_key;
        const currentExpiry = existingUser.expires_at || 0;
        
        // ✅ If expired, start from now; otherwise extend from current expiry
        const newExpiry = (currentExpiry > now ? currentExpiry : now) + durationSeconds;

        await env.DB.prepare(
          "UPDATE users SET plan = ?, status = 'active', expires_at = ?, payment_provider = 'dodo_webhook' WHERE id = ?"
        ).bind(productConfig.plan, newExpiry, existingUser.id).run();
        
        console.log(`✅ License extended for: ${email}`);
        console.log(`📅 New expiry: ${new Date(newExpiry * 1000).toISOString()}`);

      } else {
        // ✅ NEW USER: Create license
        console.log(`✨ Creating new license for: ${email}`);
        finalLicenseKey = generateKey(productConfig.plan);
        
        // ✅ CRITICAL: New expiry = now + duration
        const newExpiry = now + durationSeconds;
        const userId = crypto.randomUUID();

        await env.DB.prepare(
          "INSERT INTO users (id, email, license_key, plan, status, created_at, expires_at, payment_provider) VALUES (?, ?, ?, ?, 'active', ?, ?, 'dodo_webhook')"
        ).bind(userId, email, finalLicenseKey, productConfig.plan, now, newExpiry).run();
        
        console.log(`✅ New license created for: ${email}`);
        console.log(`🔑 License Key: ${finalLicenseKey}`);
        console.log(`📅 Expires: ${new Date(newExpiry * 1000).toISOString()}`);
      }

      // ✅ Send license email
      if (env.RESEND_API_KEY) {
        try {
          console.log(`📧 Sending email to: ${email}`);
          const emailResult = await sendLicenseEmail(email, finalLicenseKey, productConfig.name, env.RESEND_API_KEY);
          console.log(`📧 Email Result: ${emailResult ? 'Success' : 'Failed'}`);
        } catch (mailErr) {
          console.error('❌ Mail Error:', mailErr);
        }
      } else {
        console.warn('⚠️ RESEND_API_KEY is missing, skipping email.');
      }

      console.log(`✅ Webhook processing completed for: ${email}`);
    }
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : 'Unknown error';
    console.error('❌ Background processing error:', error);
  }
}
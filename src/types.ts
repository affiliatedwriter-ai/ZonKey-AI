// Type definitions for ZonKey AI Worker

export interface Env {
  DB: D1Database;
  JWT_SECRET: string;
  DODO_API_KEY: string;
  AI_API_KEY: string;
  RESEND_API_KEY: string;
  DODO_WEBHOOK_SECRET: string;
}

export interface JWTPayload {
  sub: string;
  plan: string;
  iat: number;
  exp: number;
}

export interface User {
  id: string;
  license_key: string;
  email: string;
  plan: string;
  expires_at: number;
  status: string;
  created_at: number;
}

export interface Product {
  title: string;
  rating?: number;
  reviews?: number;
  bought?: number;
  asin?: string;
  price?: string;
  description?: string;
  category?: string;
}

export interface ScoredProduct extends Product {
  score: number;
  level: 'high' | 'medium' | 'low';
  reasons?: string[];
}

export interface PlanQuota {
  plan: string;
  daily_limit: number;
  monthly_limit: number;
  credits: number;
  max_batch_size: number;
}

export interface UsageLog {
  user_id: string;
  action: string;
  tokens_used: number;
  credits_used: number;
  timestamp: number;
  metadata?: string;
}

export interface ApiKey {
  id: number;
  provider: string;
  api_key: string;
  model: string;
  is_active: number;
  created_at: number;
}

export interface WebhookPayload {
  type: string;
  data: Record<string, unknown>;
}

export interface DeepsikResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { total_tokens?: number };
}

export interface AuthResponse {
  success: boolean;
  token?: string;
  user?: {
    email: string;
    plan: string;
    quota?: PlanQuota;
    expiry_date?: string;
  };
  error?: string;
}

export interface ApiResponse<T> {
  success: boolean;
  result?: T;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface KeywordResult {
  review: string;
  comparison: string;
  roundup: string;
  howto?: string;
}

export interface CategoryResult {
  [category: string]: string[];
}
-- 1. Reset Tables (Clean start)
DROP TABLE IF EXISTS usage_logs;
DROP TABLE IF EXISTS system_api_keys;
DROP TABLE IF EXISTS plan_quotas;
DROP TABLE IF EXISTS users;

-- 2. Create Plan Quotas Table
CREATE TABLE plan_quotas (
  plan TEXT PRIMARY KEY,
  daily_limit INTEGER NOT NULL,
  monthly_limit INTEGER NOT NULL,
  credits INTEGER NOT NULL,
  max_batch_size INTEGER NOT NULL,
  rate_limit_per_minute INTEGER NOT NULL,
  features TEXT
);

-- 3. Insert Plans Data
INSERT INTO plan_quotas (plan, daily_limit, monthly_limit, credits, max_batch_size, rate_limit_per_minute, features) VALUES 
('free_trial', 5, 50, 500, 5, 5, '{"support": "basic", "models": ["gpt-3.5"]}'),
('monthly', 50, 1000, 10000, 20, 60, '{"support": "priority", "models": ["gpt-4", "deepseek"]}'),
('yearly', 100, 5000, 60000, 50, 100, '{"support": "priority", "models": ["gpt-4", "deepseek"]}'),
('lifetime', 200, 10000, 500000, 100, 200, '{"support": "vip", "models": ["gpt-4", "deepseek"]}');

-- 4. Create Users Table
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  license_key TEXT UNIQUE NOT NULL,
  plan TEXT CHECK(plan IN ('free_trial', 'monthly', 'yearly', 'lifetime')) DEFAULT 'free_trial',
  status TEXT CHECK(status IN ('active', 'suspended', 'expired')) DEFAULT 'active',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_login INTEGER,
  total_requests INTEGER DEFAULT 0,
  provider_subscription_id TEXT,
  payment_provider TEXT,
  FOREIGN KEY (plan) REFERENCES plan_quotas(plan)
);

CREATE INDEX idx_license_key ON users(license_key);
CREATE INDEX idx_email ON users(email);

-- 5. Create Usage Logs Table
CREATE TABLE usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  tokens_used INTEGER DEFAULT 0,
  credits_used INTEGER DEFAULT 1,
  timestamp INTEGER DEFAULT (strftime('%s', 'now')),
  metadata TEXT
);

CREATE INDEX idx_usage_user_time ON usage_logs(user_id, timestamp);

-- 6. Create System API Keys Table
CREATE TABLE system_api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  api_key TEXT NOT NULL,
  model TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- 7. Insert Placeholder API Keys
INSERT INTO system_api_keys (provider, api_key, model, is_active) VALUES 
('deepseek', 'sk-aaff3d629ac54a65a708a81f44feade9', 'deepseek-chat', 1);
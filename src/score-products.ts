import { jsonResponse, errorResponse } from './utils';
import { verifyJWT } from './auth';
import { Env } from './types';

interface Product {
  title: string;
  rating?: number;
  reviews?: number;
  bought?: number;
  asin?: string;
  price?: string;
  description?: string;
  category?: string;
}

interface ScoredProduct extends Product {
  score: number;
  level: 'high' | 'medium' | 'low';
  reasons: string[];
}

// Core business logic - product scoring algorithm
function calculateProductScore(product: Product): ScoredProduct {
  const { rating = 0, reviews = 0, bought = 0 } = product;
  let score = 0;
  const reasons: string[] = [];

  // Sales volume scoring (40% weight)
  if (bought >= 1000) {
    score += 40;
    reasons.push('High sales volume (1000+ bought)');
  } else if (bought >= 500) {
    score += 25;
    reasons.push('Good sales volume (500+ bought)');
  } else if (bought >= 100) {
    score += 10;
    reasons.push('Moderate sales volume (100+ bought)');
  }

  // Review count scoring (30% weight)
  if (reviews === 0 && bought > 50) {
    score += 40;
    reasons.push('Popular product with no reviews yet');
  } else if (reviews < 50) {
    score += 30;
    reasons.push('Low review count (< 50 reviews)');
  } else if (reviews < 500) {
    score += 10;
    reasons.push('Moderate review count (< 500 reviews)');
  }

  // Rating scoring (30% weight)
  if (rating >= 4.5) {
    score += 30;
    reasons.push('Excellent rating (4.5+ stars)');
  } else if (rating >= 4.0) {
    score += 20;
    reasons.push('Good rating (4.0+ stars)');
  } else if (rating >= 3.5) {
    score += 10;
    reasons.push('Average rating (3.5+ stars)');
  }

  // Quality indicators
  if (product.title && product.title.length > 50) {
    score += 5;
    reasons.push('Detailed product title');
  }

  if (product.price && parseFloat(product.price.replace(/[^0-9.]/g, '')) > 50) {
    score += 5;
    reasons.push('Premium pricing');
  }

  const level = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';

  return {
    ...product,
    score,
    level,
    reasons
  };
}

// Batch processing with filtering
function processProducts(products: Product[]): ScoredProduct[] {
  // Filter out invalid products
  const validProducts = products.filter(p => 
    p.title && 
    p.title.trim().length > 0 && 
    p.title !== 'No Title' &&
    p.title !== 'No title found'
  );

  // Calculate scores for all valid products
  const scoredProducts = validProducts.map(calculateProductScore);

  // Sort by score (highest first)
  return scoredProducts.sort((a, b) => b.score - a.score);
}

export async function handleScoreProducts(request: Request, env: Env): Promise<Response> {
  try {
    // Verify JWT token
    const authHeader = request.headers.get('Authorization') || '';
    const payload = await verifyJWT(authHeader.replace('Bearer ', ''), env.JWT_SECRET);
    
    if (!payload) {
      return errorResponse('Invalid authentication token', 401);
    }

    // Get user from database
    const user = await env.DB.prepare(
      "SELECT id FROM users WHERE license_key = ?"
    ).bind(payload.sub).first() as { id: string } | null;

    if (!user) {
      return errorResponse('User not found', 404);
    }

    // Check rate limiting
    const today = Math.floor(new Date().setHours(0,0,0,0) / 1000);
    
    const usage = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM usage_logs WHERE user_id = ? AND timestamp >= ?"
    ).bind(user.id, today).first() as { count: number } | null;

    const quota = await env.DB.prepare(
      "SELECT daily_limit FROM plan_quotas WHERE plan = ?"
    ).bind(payload.plan).first() as { daily_limit: number } | null;

    if (usage && quota && usage.count >= quota.daily_limit) {
      return errorResponse('Daily rate limit exceeded', 429);
    }

    // Parse request body safely
    let body: { products: Product[]; filters?: { minScore?: number; maxResults?: number; categories?: string[] } };
    try {
      body = await request.json() as { 
        products: Product[];
        filters?: {
          minScore?: number;
          maxResults?: number;
          categories?: string[];
        }
      };
    } catch (error) {
      body = { products: [], filters: {} };
    }

    if (!body.products || !Array.isArray(body.products)) {
      return errorResponse('Invalid products data', 400);
    }

    // Process products with business logic
    const scoredProducts = processProducts(body.products);

    // Apply filters
    let filteredProducts = scoredProducts;
    
    if (body.filters) {
      if (typeof body.filters.minScore === 'number') {
        filteredProducts = filteredProducts.filter(p => p.score >= body.filters!.minScore!);
      }
      
      if (typeof body.filters.maxResults === 'number') {
        filteredProducts = filteredProducts.slice(0, body.filters!.maxResults!);
      }
    }

    // Log usage
    const filters = body.filters ?? {};
    await env.DB.prepare(
      "INSERT INTO usage_logs (user_id, action, tokens_used, credits_used, timestamp, metadata) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(
      user.id,
      'score_products',
      0, // No AI tokens used for scoring
      1,
      Math.floor(Date.now() / 1000),
      JSON.stringify({ 
        products_processed: scoredProducts.length,
        products_filtered: filteredProducts.length,
        filters
      })
    ).run();
    return jsonResponse({
      success: true,
      products: filteredProducts,
      metadata: {
        total_processed: scoredProducts.length,
        total_filtered: filteredProducts.length,
        filters
      }
    });

  } catch (error) {
    console.error('Score products error:', error);
    return errorResponse('Internal server error', 500);
  }
}

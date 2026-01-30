import { jwtVerify } from 'jose';

export interface JWTPayload {
  sub: string;
  plan: string;
  iat: number;
  exp: number;
}

// Verify JWT token
export async function verifyJWT(token: string, secret: string): Promise<JWTPayload | null> {
  try {
    const [header, payload, signature] = token.split('.');
    
    if (header !== 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9') {
      return null;
    }
    
    const decodedPayload = await jwtVerify(
      token,
      new TextEncoder().encode(secret),
      {
        algorithms: ['HS256']
      }
    );
    
    return decodedPayload.payload as unknown as JWTPayload;
    
  } catch (error) {
    console.error('JWT verification error:', error);
    return null;
  }
}

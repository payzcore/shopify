/**
 * Redis-backed store for shop tokens and payment-to-order mappings.
 *
 * Uses ioredis for persistent storage. Shop tokens and payment mappings
 * survive app restarts. Falls back to in-memory store if REDIS_URL
 * is not configured (development only).
 */

import Redis from 'ioredis'
import type { Network, Token } from './services/payzcore'

// ── Types ──

export interface ShopData {
  accessToken: string
  scope: string
  installedAt: string
}

export interface PaymentMapping {
  shopDomain: string
  shopifyOrderId: number
  shopifyOrderName: string
  amount: string
  currency: string
  customerEmail: string
  network: Network
  token: Token
  payzCorePaymentId: string
  address: string
  expectedAmount: string
  qrCode: string
  expiresAt: string
  status: string
  createdAt: string
  /** Instructions for the payer — static wallet mode */
  notice?: string
  /** Whether the payer must submit their transaction hash — static wallet mode */
  requiresTxid?: boolean
  /** Endpoint to POST tx_hash to — static wallet mode */
  confirmEndpoint?: string
}

// ── Redis Client ──

const REDIS_URL = process.env.REDIS_URL || ''
let redis: Redis | null = null

function getRedis(): Redis {
  if (!redis) {
    if (!REDIS_URL) {
      throw new Error('REDIS_URL is required for the Shopify app store')
    }
    redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    })
    redis.on('error', (err) => console.error('[Store] Redis error:', err))
    redis.connect().catch((err) => console.error('[Store] Redis connect error:', err))
  }
  return redis
}

// Key prefixes
const SHOP_PREFIX = 'shopify:shop:'
const PAYMENT_PREFIX = 'shopify:payment:'

// Payment mappings expire after 7 days
const PAYMENT_TTL = 86400 * 7

// ── Startup Check ──

/**
 * Verify Redis is configured and connectable at startup.
 * Throws a clear error if REDIS_URL is missing or Redis cannot be reached.
 * Must be called before the server starts accepting requests.
 */
export async function verifyRedisConnection(): Promise<void> {
  if (!REDIS_URL) {
    throw new Error(
      '[Store] REDIS_URL environment variable is required. ' +
      'The Shopify app requires Redis for persistent shop token and payment mapping storage. ' +
      'Set REDIS_URL (e.g. redis://localhost:6379) and restart.'
    )
  }

  const client = getRedis()
  try {
    const pong = await client.ping()
    if (pong !== 'PONG') {
      throw new Error(`Unexpected PING response: ${pong}`)
    }
    console.log('[Store] Redis connection verified successfully')
  } catch (error) {
    throw new Error(
      `[Store] Failed to connect to Redis at startup. ` +
      `Shop tokens will be lost without Redis. ` +
      `Error: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

// ── Shop Methods ──

export async function saveShop(domain: string, data: ShopData): Promise<void> {
  await getRedis().set(`${SHOP_PREFIX}${domain}`, JSON.stringify(data))
}

export async function getShop(domain: string): Promise<ShopData | null> {
  const raw = await getRedis().get(`${SHOP_PREFIX}${domain}`)
  return raw ? JSON.parse(raw) : null
}

export async function deleteShop(domain: string): Promise<void> {
  await getRedis().del(`${SHOP_PREFIX}${domain}`)
}

export async function hasShop(domain: string): Promise<boolean> {
  const exists = await getRedis().exists(`${SHOP_PREFIX}${domain}`)
  return exists === 1
}

// ── Payment Mapping Methods ──

export async function savePaymentMapping(paymentId: string, mapping: PaymentMapping): Promise<void> {
  await getRedis().set(`${PAYMENT_PREFIX}${paymentId}`, JSON.stringify(mapping), 'EX', PAYMENT_TTL)
}

export async function getPaymentMapping(paymentId: string): Promise<PaymentMapping | null> {
  const raw = await getRedis().get(`${PAYMENT_PREFIX}${paymentId}`)
  return raw ? JSON.parse(raw) : null
}

export async function updatePaymentMappingStatus(paymentId: string, status: string): Promise<void> {
  const raw = await getRedis().get(`${PAYMENT_PREFIX}${paymentId}`)
  if (raw) {
    const mapping: PaymentMapping = JSON.parse(raw)
    mapping.status = status
    // Preserve remaining TTL
    const ttl = await getRedis().ttl(`${PAYMENT_PREFIX}${paymentId}`)
    const expiry = ttl > 0 ? ttl : PAYMENT_TTL
    await getRedis().set(`${PAYMENT_PREFIX}${paymentId}`, JSON.stringify(mapping), 'EX', expiry)
  }
}

export async function deletePaymentMapping(paymentId: string): Promise<void> {
  await getRedis().del(`${PAYMENT_PREFIX}${paymentId}`)
}

/**
 * Find payment mapping by Shopify order ID.
 * Uses a SCAN to avoid blocking Redis with KEYS.
 */
export async function findPaymentByOrderId(shopDomain: string, orderId: number): Promise<PaymentMapping | null> {
  let cursor = '0'
  do {
    const [nextCursor, keys] = await getRedis().scan(cursor, 'MATCH', `${PAYMENT_PREFIX}*`, 'COUNT', 100)
    cursor = nextCursor
    for (const key of keys) {
      const raw = await getRedis().get(key)
      if (raw) {
        const mapping: PaymentMapping = JSON.parse(raw)
        if (mapping.shopDomain === shopDomain && mapping.shopifyOrderId === orderId) {
          return mapping
        }
      }
    }
  } while (cursor !== '0')
  return null
}

// ── Cleanup ──

/**
 * Redis handles expiry via TTL, so explicit cleanup is not needed.
 * This function is kept for backward compatibility but is a no-op.
 */
export async function cleanupExpiredMappings(): Promise<number> {
  // Redis TTL handles expiry automatically
  return 0
}

/**
 * Gracefully disconnect Redis.
 */
export async function disconnectStore(): Promise<void> {
  if (redis) {
    await redis.quit()
    redis = null
  }
}

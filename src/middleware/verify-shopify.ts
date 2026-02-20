/**
 * Shopify HMAC Verification Middleware
 *
 * Verifies that incoming requests originate from Shopify
 * by validating the HMAC signature against the app's API secret.
 *
 * Used for:
 * - OAuth callback verification (query string HMAC)
 * - App proxy requests
 * - Webhook verification (X-Shopify-Hmac-Sha256 header)
 */

import { createHmac, timingSafeEqual } from 'crypto'
import type { Request, Response, NextFunction } from 'express'
import type { AppConfig } from '../config'

/**
 * Verify Shopify query string HMAC.
 *
 * Shopify appends an `hmac` parameter to OAuth callbacks and app proxy URLs.
 * The HMAC is computed over all other query parameters (sorted, excluding `hmac` itself).
 */
export function verifyShopifyQuery(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const query = { ...req.query } as Record<string, string>
    const hmac = query.hmac

    if (!hmac) {
      res.status(401).json({ error: 'Missing HMAC parameter' })
      return
    }

    // Remove hmac from query params before computing signature
    delete query.hmac

    // Sort parameters alphabetically and create the message
    const message = Object.keys(query)
      .sort()
      .map((key) => `${key}=${query[key]}`)
      .join('&')

    const computed = createHmac('sha256', config.shopify.apiSecret)
      .update(message)
      .digest('hex')

    if (computed.length !== hmac.length) {
      res.status(401).json({ error: 'Invalid HMAC signature' })
      return
    }

    try {
      const isValid = timingSafeEqual(
        Buffer.from(computed, 'hex'),
        Buffer.from(hmac, 'hex'),
      )
      if (!isValid) {
        res.status(401).json({ error: 'Invalid HMAC signature' })
        return
      }
    } catch {
      res.status(401).json({ error: 'Invalid HMAC signature' })
      return
    }

    next()
  }
}

/**
 * Verify Shopify webhook HMAC.
 *
 * Shopify sends a X-Shopify-Hmac-Sha256 header containing a Base64-encoded
 * HMAC-SHA256 of the raw request body, signed with the app's API secret.
 */
export function verifyShopifyWebhook(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const hmacHeader = req.headers['x-shopify-hmac-sha256'] as string | undefined

    if (!hmacHeader) {
      res.status(401).json({ error: 'Missing Shopify HMAC header' })
      return
    }

    // req.body must be the raw Buffer (use express.raw() on the route)
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody
    if (!rawBody) {
      res.status(400).json({ error: 'Missing request body' })
      return
    }

    const computed = createHmac('sha256', config.shopify.apiSecret)
      .update(rawBody)
      .digest('base64')

    try {
      const isValid = timingSafeEqual(
        Buffer.from(computed, 'base64'),
        Buffer.from(hmacHeader, 'base64'),
      )
      if (!isValid) {
        res.status(401).json({ error: 'Invalid Shopify webhook signature' })
        return
      }
    } catch {
      res.status(401).json({ error: 'Invalid Shopify webhook signature' })
      return
    }

    next()
  }
}

/**
 * Validate that a shop domain looks legitimate.
 * Must match *.myshopify.com pattern.
 */
export function isValidShopDomain(shop: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)
}

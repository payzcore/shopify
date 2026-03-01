/**
 * PayzCore Webhook Signature Verification Middleware
 *
 * Verifies that incoming webhook requests originate from PayzCore
 * by validating the HMAC-SHA256 signature in the X-PayzCore-Signature header.
 *
 * The signature covers: HMAC-SHA256(timestamp + "." + raw_body, webhook_secret)
 * and is sent as a hex-encoded string.
 */

import { createHmac, timingSafeEqual } from 'crypto'
import type { Request, Response, NextFunction } from 'express'
import type { AppConfig } from '../config'

/**
 * Express middleware that verifies PayzCore webhook signatures.
 *
 * IMPORTANT: The route using this middleware must capture the raw body.
 * Use express.raw({ type: 'application/json' }) or a custom body parser
 * that preserves the raw Buffer.
 */
export function verifyPayzCoreWebhook(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const signature = req.headers['x-payzcore-signature'] as string | undefined
    const timestamp = req.headers['x-payzcore-timestamp'] as string | undefined

    if (!signature) {
      console.warn('[PayzCore Webhook] Missing X-PayzCore-Signature header')
      res.status(401).json({ error: 'Missing signature header' })
      return
    }

    if (!timestamp) {
      console.warn('[PayzCore Webhook] Missing X-PayzCore-Timestamp header')
      res.status(401).json({ error: 'Missing timestamp header' })
      return
    }

    // Replay protection: reject stale webhooks (±5 min)
    const ts = new Date(timestamp).getTime()
    if (isNaN(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
      console.warn('[PayzCore Webhook] Timestamp too old or invalid')
      res.status(401).json({ error: 'Timestamp validation failed' })
      return
    }

    // Get raw body - must be a string or Buffer
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody
    if (!rawBody) {
      console.warn('[PayzCore Webhook] Missing raw body for signature verification')
      res.status(400).json({ error: 'Missing request body' })
      return
    }

    // Signature covers timestamp + body
    const message = `${timestamp}.${rawBody.toString('utf8')}`
    const expected = createHmac('sha256', config.payzcore.webhookSecret)
      .update(message)
      .digest('hex')

    // Validate signature is a proper hex string before comparison
    if (!/^[a-f0-9]{64}$/i.test(signature)) {
      console.warn('[PayzCore Webhook] Invalid signature format')
      res.status(401).json({ error: 'Invalid signature' })
      return
    }

    try {
      const isValid = timingSafeEqual(
        Buffer.from(signature, 'hex'),
        Buffer.from(expected, 'hex'),
      )

      if (!isValid) {
        console.warn('[PayzCore Webhook] Invalid signature')
        res.status(401).json({ error: 'Invalid signature' })
        return
      }
    } catch {
      console.warn('[PayzCore Webhook] Signature verification failed')
      res.status(401).json({ error: 'Invalid signature' })
      return
    }

    next()
  }
}

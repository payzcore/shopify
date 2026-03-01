/**
 * PayzCore Webhook Handler
 *
 * Receives webhook notifications from PayzCore when payment status changes.
 * Processes the following events:
 *
 * - payment.completed: Stablecoin received in full -> mark Shopify order as paid
 * - payment.overpaid: More stablecoin received than expected -> mark order as paid
 * - payment.expired: Payment monitoring window expired -> optionally cancel order
 * - payment.partial: Partial stablecoin received -> log for reference
 *
 * All webhook requests are verified using HMAC-SHA256 signature
 * before processing (via verify-payzcore middleware).
 */

import { Router, raw } from 'express'
import type { AppConfig } from '../config'
import { verifyPayzCoreWebhook } from '../middleware/verify-payzcore'
import { ShopifyClient } from '../services/shopify'
import { NETWORK_EXPLORER_TX } from '../services/payzcore'
import type { Network } from '../services/payzcore'
import { getPaymentMapping, getShop, updatePaymentMappingStatus } from '../store'
import type { PaymentMapping } from '../store'

interface WebhookPayload {
  event: string
  payment_id: string
  external_ref: string
  external_order_id?: string
  network: string
  address: string
  expected_amount: string
  paid_amount: string
  tx_hash: string | null
  status: string
  paid_at: string | null
  metadata: Record<string, unknown>
  timestamp: string
}

export function createWebhookRouter(config: AppConfig): Router {
  const router = Router()

  /**
   * POST /webhooks/payzcore
   *
   * Receives PayzCore webhook notifications.
   *
   * The raw body must be preserved for HMAC verification.
   * Uses express.raw() to parse body as Buffer, then the
   * verify-payzcore middleware checks the signature.
   */
  router.post(
    '/payzcore',
    // Parse body as raw Buffer for HMAC verification
    raw({ type: 'application/json' }),
    // Attach raw body for middleware
    (req, _res, next) => {
      (req as unknown as { rawBody?: Buffer }).rawBody = req.body as Buffer
      // Parse JSON from raw buffer
      try {
        req.body = JSON.parse((req.body as Buffer).toString('utf-8'))
      } catch {
        // Body will remain as Buffer, middleware will handle
      }
      next()
    },
    // Verify HMAC signature
    verifyPayzCoreWebhook(config),
    // Process webhook
    async (req, res) => {
      const payload = req.body as WebhookPayload

      console.log(`[Webhook] Received ${payload.event} for payment ${payload.payment_id}`)

      // Look up the payment mapping
      const mapping = await getPaymentMapping(payload.payment_id)

      if (!mapping) {
        // Payment not found in our store - might be from a different integration
        // Acknowledge receipt to prevent retries
        console.warn(`[Webhook] No mapping found for payment ${payload.payment_id}`)
        res.json({ received: true, processed: false, reason: 'no_mapping' })
        return
      }

      // Update local status
      await updatePaymentMappingStatus(payload.payment_id, payload.status)

      // Get shop access token
      const shopData = await getShop(mapping.shopDomain)
      if (!shopData) {
        console.error(`[Webhook] No shop data for ${mapping.shopDomain}`)
        res.json({ received: true, processed: false, reason: 'shop_not_found' })
        return
      }

      const shopify = new ShopifyClient(mapping.shopDomain, shopData.accessToken)

      try {
        switch (payload.event) {
          case 'payment.completed':
          case 'payment.overpaid': {
            await handlePaymentSuccess(shopify, mapping, payload)
            break
          }

          case 'payment.expired': {
            await handlePaymentExpired(shopify, mapping, payload)
            break
          }

          case 'payment.cancelled': {
            await handlePaymentCancelled(shopify, mapping, payload)
            break
          }

          case 'payment.partial': {
            await handlePaymentPartial(shopify, mapping, payload)
            break
          }

          default: {
            console.warn(`[Webhook] Unknown event: ${payload.event}`)
          }
        }

        res.json({ received: true, processed: true })
      } catch (error) {
        console.error(`[Webhook] Processing error for ${payload.payment_id}:`, error)
        // Return 500 so PayzCore retries the webhook
        res.status(500).json({ received: true, processed: false, reason: 'processing_error' })
      }
    },
  )

  return router
}

/**
 * Handle payment.completed / payment.overpaid events.
 *
 * When PayzCore detects that the expected stablecoin amount (or more) has been
 * received on the monitored blockchain address:
 * 1. Create a Shopify transaction to mark the order as paid
 * 2. Add order note with transaction details
 * 3. Tag the order for easy filtering
 */
async function handlePaymentSuccess(
  shopify: ShopifyClient,
  mapping: PaymentMapping,
  payload: WebhookPayload,
): Promise<void> {
  if (!mapping) return

  // Resolve token from mapping or fallback to USDT
  const tokenLabel = mapping.token || 'USDT'

  console.log(
    `[Webhook] Payment successful for order ${mapping.shopifyOrderName} ` +
    `(${payload.paid_amount} ${tokenLabel} on ${payload.network})`
  )

  // Check order status first to avoid duplicate transactions
  try {
    const order = await shopify.getOrder(mapping.shopifyOrderId)
    if (order.financial_status === 'paid') {
      console.log(`[Webhook] Order ${mapping.shopifyOrderName} already marked as paid, skipping`)
      return
    }
  } catch (error) {
    console.warn(`[Webhook] Could not check order status, proceeding:`, error)
  }

  // Mark order as paid in Shopify
  await shopify.markOrderAsPaid(mapping.shopifyOrderId, {
    amount: payload.paid_amount || mapping.amount,
    currency: mapping.currency,
    txHash: payload.tx_hash,
    network: payload.network,
    token: tokenLabel,
    payzCorePaymentId: payload.payment_id,
  })

  // Build explorer URL dynamically from network
  const explorerBase = NETWORK_EXPLORER_TX[payload.network as Network]
  const explorerUrl = explorerBase
    ? `${explorerBase}${payload.tx_hash}`
    : payload.tx_hash

  const note = [
    `Crypto payment received`,
    `Amount: ${payload.paid_amount} ${tokenLabel} (${payload.network})`,
    `Address: ${payload.address}`,
    payload.tx_hash ? `TX: ${explorerUrl}` : null,
    `Payment ID: ${payload.payment_id}`,
    `Detected at: ${payload.paid_at || payload.timestamp}`,
    payload.event === 'payment.overpaid'
      ? `Note: Customer overpaid (expected ${payload.expected_amount} ${tokenLabel})`
      : null,
  ]
    .filter(Boolean)
    .join('\n')

  await shopify.addOrderNote(mapping.shopifyOrderId, note)

  // Tag order with token name (lowercase)
  const tokenTag = tokenLabel.toLowerCase()
  const tags = payload.event === 'payment.overpaid'
    ? `crypto-paid, payzcore, ${tokenTag}, overpaid`
    : `crypto-paid, payzcore, ${tokenTag}`

  await shopify.addOrderTags(mapping.shopifyOrderId, tags)

  console.log(`[Webhook] Order ${mapping.shopifyOrderName} marked as paid`)
}

/**
 * Handle payment.expired events.
 *
 * When a PayzCore monitoring request expires without receiving
 * the expected stablecoin amount:
 * 1. Cancel the Shopify order
 * 2. Add note explaining the expiry
 * 3. Tag the order for reference
 */
async function handlePaymentExpired(
  shopify: ShopifyClient,
  mapping: PaymentMapping,
  payload: WebhookPayload,
): Promise<void> {
  if (!mapping) return

  console.log(`[Webhook] Payment expired for order ${mapping.shopifyOrderName}`)

  try {
    // Check if order is already cancelled or paid
    const order = await shopify.getOrder(mapping.shopifyOrderId)
    if (order.cancelled_at || order.financial_status === 'paid') {
      console.log(`[Webhook] Order ${mapping.shopifyOrderName} already ${order.cancelled_at ? 'cancelled' : 'paid'}, skipping`)
      return
    }

    // Cancel the order
    const expiredToken = mapping.token || 'USDT'
    await shopify.cancelOrder(
      mapping.shopifyOrderId,
      `Crypto payment expired. The customer did not send ${expiredToken} within the payment window. Payment ID: ${payload.payment_id}`,
    )

    await shopify.addOrderTags(mapping.shopifyOrderId, 'crypto-expired, payzcore')

    console.log(`[Webhook] Order ${mapping.shopifyOrderName} cancelled due to payment expiry`)
  } catch (error) {
    // Order might already be cancelled or in an unfulfillable state
    console.warn(`[Webhook] Could not cancel order ${mapping.shopifyOrderName}:`, error)
  }
}

/**
 * Handle payment.cancelled events.
 *
 * When a PayzCore payment is cancelled by the merchant:
 * 1. Cancel the Shopify order
 * 2. Add note explaining the cancellation
 * 3. Tag the order for reference
 */
async function handlePaymentCancelled(
  shopify: ShopifyClient,
  mapping: PaymentMapping,
  payload: WebhookPayload,
): Promise<void> {
  if (!mapping) return

  console.log(`[Webhook] Payment cancelled for order ${mapping.shopifyOrderName}`)

  try {
    const order = await shopify.getOrder(mapping.shopifyOrderId)
    if (order.cancelled_at || order.financial_status === 'paid') {
      console.log(`[Webhook] Order ${mapping.shopifyOrderName} already ${order.cancelled_at ? 'cancelled' : 'paid'}, skipping`)
      return
    }

    await shopify.cancelOrder(
      mapping.shopifyOrderId,
      `Crypto payment cancelled by the merchant. Payment ID: ${payload.payment_id}`,
    )

    await shopify.addOrderTags(mapping.shopifyOrderId, 'crypto-cancelled, payzcore')

    console.log(`[Webhook] Order ${mapping.shopifyOrderName} cancelled due to payment cancellation`)
  } catch (error) {
    console.warn(`[Webhook] Could not cancel order ${mapping.shopifyOrderName}:`, error)
  }
}

/**
 * Handle payment.partial events.
 *
 * When PayzCore detects a partial stablecoin transfer:
 * 1. Add note to Shopify order about partial payment
 * 2. Tag the order for merchant review
 *
 * The order is NOT marked as paid - merchant decides how to handle.
 */
async function handlePaymentPartial(
  shopify: ShopifyClient,
  mapping: PaymentMapping,
  payload: WebhookPayload,
): Promise<void> {
  if (!mapping) return

  const tokenLabel = mapping.token || 'USDT'

  console.log(
    `[Webhook] Partial payment for order ${mapping.shopifyOrderName}: ` +
    `${payload.paid_amount}/${payload.expected_amount} ${tokenLabel}`
  )

  const explorerBase = NETWORK_EXPLORER_TX[payload.network as Network]
  const txLink = (explorerBase && payload.tx_hash) ? `${explorerBase}${payload.tx_hash}` : payload.tx_hash

  const note = [
    `Partial crypto payment detected`,
    `Received: ${payload.paid_amount} ${tokenLabel} (expected: ${payload.expected_amount} ${tokenLabel})`,
    `Network: ${payload.network}`,
    `Address: ${payload.address}`,
    txLink ? `TX: ${txLink}` : null,
    `Payment ID: ${payload.payment_id}`,
    `The payment window is still active. Customer may send the remaining amount.`,
  ]
    .filter(Boolean)
    .join('\n')

  try {
    await shopify.addOrderNote(mapping.shopifyOrderId, note)
    await shopify.addOrderTags(mapping.shopifyOrderId, 'crypto-partial, payzcore')
  } catch (error) {
    console.warn(`[Webhook] Could not update order ${mapping.shopifyOrderName} for partial:`, error)
  }
}

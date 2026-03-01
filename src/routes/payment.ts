/**
 * Payment Routes
 *
 * Handles the customer-facing payment flow:
 * 1. /payment/create - Initiates a PayzCore monitoring request for a Shopify order
 * 2. /payment/:paymentId - Renders the payment page (address, QR, countdown)
 * 3. /payment/:paymentId/status - JSON polling endpoint for payment status
 * 4. /payment/:paymentId/complete - Redirects customer back to Shopify after payment
 *
 * Flow:
 * Shopify checkout -> "Pay with Crypto" -> /payment/create -> PayzCore API
 *   -> /payment/:id (show address + QR) -> poll status -> auto-redirect on success
 */

import { Router } from 'express'
import type { AppConfig } from '../config'
import {
  PayzCoreClient,
  NETWORK_LABELS,
  NETWORK_EXPLORER_TX,
  VALID_NETWORK_TOKEN,
  isValidNetwork,
  isValidToken,
  isValidNetworkToken,
} from '../services/payzcore'
import type { Network, Token } from '../services/payzcore'
import {
  getShop,
  savePaymentMapping,
  getPaymentMapping,
  updatePaymentMappingStatus,
} from '../store'
import { isValidShopDomain } from '../middleware/verify-shopify'
import { loadTexts } from '../lib/texts'

export function createPaymentRouter(config: AppConfig): Router {
  const router = Router()
  const payzcore = new PayzCoreClient(config)

  /** Human-readable network labels with fee hints for the network selector */
  const NETWORK_SELECTOR_LABELS: Record<string, string> = {
    TRC20: 'TRON (TRC20)',
    BEP20: 'BNB Smart Chain (BEP20) - Low fees',
    ERC20: 'Ethereum (ERC20)',
    POLYGON: 'Polygon - Lowest fees',
    ARBITRUM: 'Arbitrum (L2) - Low fees',
  }

  /**
   * GET /payment/create
   *
   * Initiates a crypto payment for a Shopify order.
   * If multiple chains are enabled and the customer hasn't chosen one yet,
   * shows a network selection page first.
   *
   * Query params:
   * - shop: store-name.myshopify.com
   * - order_id: Shopify order ID (numeric)
   * - order_name: Shopify order name (#1001)
   * - amount: Order total in store currency
   * - currency: Store currency (USD, EUR, etc.)
   * - email: Customer email
   * - network: TRC20, BEP20, ERC20, POLYGON, or ARBITRUM (optional, defaults to config)
   * - token: USDT or USDC (optional, defaults to config)
   * - return_url: URL to redirect after payment (Shopify thank-you page)
   *
   * This endpoint is called from Shopify's additional scripts or
   * a custom checkout extension.
   */
  router.get('/create', async (req, res) => {
    const {
      shop,
      order_id,
      order_name,
      amount,
      currency,
      email,
      network,
      token,
      address: staticAddress,
      return_url,
    } = req.query as Record<string, string | undefined>

    // Validate required parameters
    if (!shop || !isValidShopDomain(shop)) {
      res.status(400).render('error', {
        title: 'Invalid Request',
        message: 'Invalid or missing shop domain.',
        appUrl: config.app.url,
        texts: loadTexts(),
      })
      return
    }

    if (!order_id || !amount) {
      res.status(400).render('error', {
        title: 'Invalid Request',
        message: 'Missing order ID or amount.',
        appUrl: config.app.url,
        texts: loadTexts(),
      })
      return
    }

    const shopData = await getShop(shop)
    if (!shopData) {
      res.status(403).render('error', {
        title: 'App Not Installed',
        message: 'This shop has not installed the PayzCore app. Please install it from the Shopify App Store.',
        appUrl: config.app.url,
        texts: loadTexts(),
      })
      return
    }

    // ── Multi-network selection ──
    // If multiple networks are enabled and customer hasn't selected one yet,
    // show the network selector page before creating the payment.
    const showNetworkSelector = config.app.enabledNetworks.length > 1
    const networkSpecified = network && isValidNetwork(network)

    if (showNetworkSelector && !networkSpecified) {
      // Build the list of enabled networks with labels and supported tokens
      const enabledNetworkOptions = config.app.enabledNetworks.map(c => ({
        code: c,
        label: NETWORK_SELECTOR_LABELS[c] || NETWORK_LABELS[c] || c,
        tokens: VALID_NETWORK_TOKEN[c] as readonly string[],
      }))

      // Build base URL params to forward when the customer selects a network
      const forwardParams: Record<string, string> = {}
      if (shop) forwardParams.shop = shop
      if (order_id) forwardParams.order_id = order_id
      if (order_name) forwardParams.order_name = order_name
      if (amount) forwardParams.amount = amount
      if (currency) forwardParams.currency = currency
      if (email) forwardParams.email = email
      if (staticAddress) forwardParams.address = staticAddress
      if (return_url) forwardParams.return_url = return_url

      res.render('network-select', {
        enabledNetworks: enabledNetworkOptions,
        defaultToken: config.app.defaultToken,
        orderName: order_name || `#${order_id}`,
        amount,
        currency: currency || 'USD',
        forwardParams,
        appUrl: config.app.url,
        texts: loadTexts(),
      })
      return
    }

    // Resolve network: use query param if valid, otherwise fall back to config default
    const paymentNetwork: Network = (network && isValidNetwork(network)) ? network : config.app.defaultNetwork

    // Resolve token: use query param if valid, otherwise fall back to config default
    const paymentToken: Token = (token && isValidToken(token)) ? token : config.app.defaultToken

    // Validate selected network is in the enabled list
    if (!config.app.enabledNetworks.includes(paymentNetwork)) {
      res.status(400).render('error', {
        title: 'Invalid Network',
        message: `${paymentNetwork} is not enabled. Available networks: ${config.app.enabledNetworks.join(', ')}`,
        appUrl: config.app.url,
        texts: loadTexts(),
      })
      return
    }

    // Validate network+token combination (e.g. TRC20 only supports USDT)
    if (!isValidNetworkToken(paymentNetwork, paymentToken)) {
      res.status(400).render('error', {
        title: 'Invalid Configuration',
        message: `${paymentToken} is not supported on ${paymentNetwork}.`,
        appUrl: config.app.url,
        texts: loadTexts(),
      })
      return
    }

    const requestedAmount = parseFloat(amount)

    if (isNaN(requestedAmount) || requestedAmount <= 0) {
      res.status(400).render('error', {
        title: 'Invalid Amount',
        message: 'The order amount is invalid.',
        appUrl: config.app.url,
        texts: loadTexts(),
      })
      return
    }

    // ── B1: Verify order amount against Shopify Admin API ──
    // Use the Shopify-verified amount as the source of truth for the PayzCore payment
    let verifiedAmount: number
    try {
      const orderResponse = await fetch(
        `https://${shop}/admin/api/2024-10/orders/${order_id}.json`,
        {
          headers: {
            'X-Shopify-Access-Token': shopData.accessToken,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(15_000),
        },
      )

      if (!orderResponse.ok) {
        console.error(`[Payment] Failed to verify order ${order_id} with Shopify: ${orderResponse.status}`)
        res.status(400).render('error', {
          title: 'Order Verification Failed',
          message: 'Could not verify the order with Shopify. Please try again.',
          appUrl: config.app.url,
          texts: loadTexts(),
        })
        return
      }

      const orderData = await orderResponse.json() as {
        order: { total_outstanding: string; total_price: string; financial_status: string }
      }
      verifiedAmount = parseFloat(orderData.order.total_outstanding || orderData.order.total_price)

      // Reject if the order is already paid or in a terminal financial state
      const terminalStatuses = ['paid', 'refunded', 'voided']
      if (terminalStatuses.includes(orderData.order.financial_status)) {
        console.warn(
          `[Payment] Order ${order_id} has terminal financial_status: ${orderData.order.financial_status}`
        )
        res.status(400).render('error', {
          title: 'Order Already Paid',
          message: 'This order has already been paid or is no longer payable.',
          appUrl: config.app.url,
          texts: loadTexts(),
        })
        return
      }

      // Reject if the requested amount doesn't match the actual order
      if (Math.abs(verifiedAmount - requestedAmount) > 0.01) {
        console.error(
          `[Payment] Amount mismatch for order ${order_id}: ` +
          `requested=${requestedAmount}, verified=${verifiedAmount}`
        )
        res.status(400).render('error', {
          title: 'Amount Mismatch',
          message: 'The payment amount does not match the order total.',
          appUrl: config.app.url,
          texts: loadTexts(),
        })
        return
      }
    } catch (error) {
      console.error(`[Payment] Order verification error for ${order_id}:`, error)
      res.status(500).render('error', {
        title: 'Verification Error',
        message: 'Could not verify the order. Please try again.',
        appUrl: config.app.url,
        texts: loadTexts(),
      })
      return
    }

    try {
      // Create PayzCore monitoring request using the Shopify-verified amount
      const createParams: Parameters<typeof payzcore.createPayment>[0] = {
        amount: verifiedAmount,
        network: paymentNetwork,
        token: paymentToken,
        external_ref: email || `shopify-customer-${order_id}`,
        external_order_id: `shopify-${shop}-${order_id}`,
        expires_in: 3600, // 1 hour
        metadata: {
          source: 'shopify',
          shop_domain: shop,
          shopify_order_id: order_id,
          shopify_order_name: order_name || `#${order_id}`,
          currency: currency || 'USD',
          token: paymentToken,
        },
      }

      // Optional: pass a static wallet address if provided
      if (staticAddress) {
        createParams.address = staticAddress
      }

      const result = await payzcore.createPayment(createParams)

      const payment = result.payment

      // Resolve token from API response or use the one we sent
      const resolvedToken = (payment.token as Token) || paymentToken

      // Store mapping for webhook processing
      await savePaymentMapping(payment.id, {
        shopDomain: shop,
        shopifyOrderId: parseInt(order_id, 10),
        shopifyOrderName: order_name || `#${order_id}`,
        amount: amount,
        currency: currency || 'USD',
        customerEmail: email || '',
        network: paymentNetwork,
        token: resolvedToken,
        payzCorePaymentId: payment.id,
        address: payment.address,
        expectedAmount: payment.amount,
        qrCode: payment.qr_code || '',
        expiresAt: payment.expires_at,
        status: payment.status,
        createdAt: new Date().toISOString(),
        notice: payment.notice,
        requiresTxid: payment.requires_txid,
        confirmEndpoint: payment.confirm_endpoint,
      })

      // Store return URL in session for post-payment redirect
      // Validate return_url to prevent open redirect attacks
      const safeReturnUrl = (() => {
        if (!return_url) return `https://${shop}/account`
        try {
          const parsed = new URL(return_url)
          // Allow HTTPS-only URLs. Shopify sends return_url with the store's canonical domain
          // which may be a custom domain (store.com) or myshopify.com domain.
          // Block non-HTTPS and javascript: URIs to prevent open redirect attacks.
          if (parsed.protocol === 'https:') {
            return return_url
          }
        } catch {}
        return `https://${shop}/account`
      })()
      if (req.session) {
        req.session.returnUrl = safeReturnUrl
      }

      // Redirect to payment page
      res.redirect(`/payment/${payment.id}`)
    } catch (error) {
      console.error('[Payment] Failed to create PayzCore monitoring request:', error)
      res.status(500).render('error', {
        title: 'Payment Error',
        message: 'Unable to create payment. Please try again or contact the store.',
        appUrl: config.app.url,
        texts: loadTexts(),
      })
    }
  })

  /**
   * GET /payment/:paymentId
   *
   * Render the payment page showing:
   * - Amount to send (USDT/USDC)
   * - Blockchain network (TRC20/BEP20/ERC20/POLYGON/ARBITRUM)
   * - Wallet address (with copy button)
   * - QR code
   * - Countdown timer
   * - Status indicator (auto-polls)
   */
  router.get('/:paymentId', async (req, res) => {
    const { paymentId } = req.params
    const mapping = await getPaymentMapping(paymentId)

    if (!mapping) {
      res.status(404).render('error', {
        title: 'Payment Not Found',
        message: 'This payment does not exist or has expired.',
        appUrl: config.app.url,
        texts: loadTexts(),
      })
      return
    }

    const returnUrl = req.session?.returnUrl || `https://${mapping.shopDomain}/account`

    res.render('payment', {
      paymentId: mapping.payzCorePaymentId,
      address: mapping.address,
      amount: mapping.expectedAmount,
      network: mapping.network,
      networkLabel: NETWORK_LABELS[mapping.network] || mapping.network,
      token: mapping.token || 'USDT',
      qrCode: mapping.qrCode,
      expiresAt: mapping.expiresAt,
      status: mapping.status,
      orderName: mapping.shopifyOrderName,
      shopDomain: mapping.shopDomain,
      returnUrl,
      appUrl: config.app.url,
      texts: loadTexts(),
      notice: mapping.notice || '',
      requiresTxid: mapping.requiresTxid || false,
    })
  })

  /**
   * GET /payment/:paymentId/status
   *
   * JSON endpoint for polling payment status.
   * Called by the payment page every 10 seconds.
   */
  router.get('/:paymentId/status', async (req, res) => {
    const { paymentId } = req.params
    const mapping = await getPaymentMapping(paymentId)

    if (!mapping) {
      res.status(404).json({ error: 'Payment not found' })
      return
    }

    try {
      // Query PayzCore for real-time status
      const result = await payzcore.getPayment(paymentId)
      const payment = result.payment

      // Update local mapping
      await updatePaymentMappingStatus(paymentId, payment.status)

      const isTerminal = ['paid', 'overpaid', 'expired', 'cancelled'].includes(payment.status)
      const isPaid = payment.status === 'paid' || payment.status === 'overpaid'

      res.json({
        status: payment.status,
        paid_amount: payment.paid_amount,
        expected_amount: payment.expected_amount,
        tx_hash: payment.tx_hash,
        transactions: payment.transactions,
        is_terminal: isTerminal,
        is_paid: isPaid,
      })
    } catch (error) {
      console.error(`[Payment] Status check failed for ${paymentId}:`, error)

      // Return cached status on API failure
      res.json({
        status: mapping.status,
        paid_amount: '0',
        expected_amount: mapping.expectedAmount,
        tx_hash: null,
        transactions: [],
        is_terminal: false,
        is_paid: false,
      })
    }
  })

  /**
   * POST /payment/:paymentId/confirm
   *
   * Submit a transaction hash for a static wallet payment.
   * Only available when requires_txid is true.
   * Proxies the tx_hash to the PayzCore confirm endpoint.
   */
  router.post('/:paymentId/confirm', async (req, res) => {
    const { paymentId } = req.params
    const mapping = await getPaymentMapping(paymentId)

    if (!mapping) {
      res.status(404).json({ error: 'Payment not found' })
      return
    }

    if (!mapping.requiresTxid || !mapping.confirmEndpoint) {
      res.status(400).json({ error: 'Transaction hash submission is not required for this payment' })
      return
    }

    const txHash = req.body?.tx_hash
    if (!txHash || typeof txHash !== 'string' || txHash.trim().length === 0) {
      res.status(400).json({ error: 'Missing or invalid tx_hash' })
      return
    }

    // Validate tx_hash format (hex string, 10-128 chars)
    const cleanTxHash = txHash.trim().replace(/^0x/, '')
    if (!/^[a-fA-F0-9]{10,128}$/.test(cleanTxHash)) {
      res.status(400).json({ error: 'Invalid transaction hash format' })
      return
    }

    try {
      const result = await payzcore.confirmPayment(mapping.confirmEndpoint, txHash.trim())
      res.json(result)
    } catch (error) {
      console.error(`[Payment] Confirm failed for ${paymentId}:`, error)
      res.status(500).json({ error: 'Failed to submit transaction hash. Please try again.' })
    }
  })

  /**
   * GET /payment/:paymentId/complete
   *
   * Redirect customer back to Shopify after successful payment.
   * Shows a brief success message before redirecting.
   */
  router.get('/:paymentId/complete', async (req, res) => {
    const { paymentId } = req.params
    const mapping = await getPaymentMapping(paymentId)

    if (!mapping) {
      res.status(404).render('error', {
        title: 'Payment Not Found',
        message: 'This payment does not exist.',
        appUrl: config.app.url,
        texts: loadTexts(),
      })
      return
    }

    const returnUrl = req.session?.returnUrl || `https://${mapping.shopDomain}/account`

    // Try to fetch tx_hash from PayzCore for the explorer link
    let txHash: string | null = null
    try {
      const result = await payzcore.getPayment(paymentId)
      txHash = result.payment.tx_hash || null
    } catch {
      // Non-critical — render page without explorer link
    }

    const explorerBase = NETWORK_EXPLORER_TX[mapping.network] || ''
    const explorerUrl = (explorerBase && txHash) ? `${explorerBase}${txHash}` : ''

    res.render('complete', {
      orderName: mapping.shopifyOrderName,
      amount: mapping.expectedAmount,
      network: mapping.network,
      token: mapping.token || 'USDT',
      returnUrl,
      appUrl: config.app.url,
      texts: loadTexts(),
      txHash: txHash || '',
      explorerUrl,
    })
  })

  return router
}

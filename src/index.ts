/**
 * PayzCore Shopify App
 *
 * Express.js app that integrates Shopify stores with PayzCore
 * blockchain transaction monitoring API.
 *
 * Adds "Pay with Crypto" as a payment method in Shopify:
 * 1. Customer selects crypto payment at checkout
 * 2. App creates a PayzCore monitoring request
 * 3. Customer sends stablecoins (USDT or USDC) to the provided address
 * 4. PayzCore detects the transfer and sends a webhook
 * 5. App marks the Shopify order as paid
 *
 * This app does NOT hold, transmit, or custody any funds.
 * It is a monitoring integration only.
 */

import express from 'express'
import cookieSession from 'cookie-session'
import path from 'path'
import { loadConfig, fetchConfigFromApi } from './config'
import { createAuthRouter } from './routes/auth'
import { createPaymentRouter } from './routes/payment'
import { createWebhookRouter } from './routes/webhook'
import { cleanupExpiredMappings, disconnectStore, verifyRedisConnection } from './store'
import { loadTexts } from './lib/texts'

// ── Load Configuration ──

const config = loadConfig()

// ── B5: HTTPS Enforcement ──

if (process.env.NODE_ENV === 'production') {
  const appUrl = config.app.url
  if (!appUrl.startsWith('https://')) {
    throw new Error('APP_URL must use HTTPS in production')
  }
}

// ── Create Express App ──

const app = express()

// Trust proxy (for reverse proxy / load balancer setups)
app.set('trust proxy', 1)

// EJS view engine
app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, 'views'))

// ── Middleware ──

// Session (for OAuth nonce and return URLs)
app.use(
  cookieSession({
    name: 'payzcore_shopify',
    keys: [config.app.sessionSecret],
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    secure: config.app.url.startsWith('https'),
    httpOnly: true,
    sameSite: 'lax',
  }),
)

// Static files (CSS, JS)
app.use(express.static(path.join(__dirname, '..', 'public')))

// JSON body parser for most routes (not webhooks - they need raw body)
app.use((req, res, next) => {
  // Skip JSON parsing for webhook routes (they use raw body)
  if (req.path.startsWith('/webhooks/')) {
    return next()
  }
  express.json()(req, res, next)
})

// ── Routes ──

// Shopify OAuth
app.use('/auth', createAuthRouter(config))

// Payment pages
app.use('/payment', createPaymentRouter(config))

// PayzCore webhooks (raw body for HMAC verification)
app.use('/webhooks', createWebhookRouter(config))

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: '@payzcore/shopify',
    version: '1.1.1',
    timestamp: new Date().toISOString(),
  })
})

// Root - installation entry point
app.get('/', (req, res) => {
  const shop = req.query.shop as string | undefined
  if (shop) {
    // Redirect to install flow
    res.redirect(`/auth/install?shop=${encodeURIComponent(shop)}`)
    return
  }

  res.json({
    name: '@payzcore/shopify',
    description: 'Shopify integration for PayzCore stablecoin transaction monitoring',
    version: '1.1.1',
    docs: 'https://docs.payzcore.com',
    endpoints: {
      install: '/auth/install?shop=store-name.myshopify.com',
      health: '/health',
    },
  })
})

// 404 handler
app.use((_req, res) => {
  res.status(404).render('error', {
    title: 'Page Not Found',
    message: 'The requested page does not exist.',
    appUrl: config.app.url,
    texts: loadTexts(),
  })
})

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Error]', err.message, err.stack)
  res.status(500).render('error', {
    title: 'Internal Error',
    message: 'An unexpected error occurred. Please try again.',
    appUrl: config.app.url,
    texts: loadTexts(),
  })
})

// ── Start Server ──

// Verify Redis is available before accepting requests (shop tokens require Redis)
let server: ReturnType<typeof app.listen>

;(async () => {
  try {
    await verifyRedisConnection()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }

  // Fetch network config from PayzCore API (non-fatal)
  await fetchConfigFromApi(config)

  server = app.listen(config.app.port, () => {
    console.log(`[PayzCore Shopify] Server running on port ${config.app.port}`)
    console.log(`[PayzCore Shopify] App URL: ${config.app.url}`)
    console.log(`[PayzCore Shopify] PayzCore API: ${config.payzcore.apiUrl}`)
    console.log(`[PayzCore Shopify] Enabled networks: ${config.app.enabledNetworks.join(', ')}`)
    console.log(`[PayzCore Shopify] Default network: ${config.app.defaultNetwork}`)
    console.log(`[PayzCore Shopify] Default token: ${config.app.defaultToken}`)
  })
})()

// ── Periodic Cleanup ──

// Periodic cleanup (Redis TTL handles expiry, this is a no-op but kept for logging)
const cleanupInterval = setInterval(async () => {
  const removed = await cleanupExpiredMappings()
  if (removed > 0) {
    console.log(`[Cleanup] Removed ${removed} expired payment mapping(s)`)
  }
}, 60 * 60 * 1000)

// ── Graceful Shutdown ──

function shutdown(signal: string): void {
  console.log(`[PayzCore Shopify] Received ${signal}, shutting down...`)
  clearInterval(cleanupInterval)

  if (!server) {
    disconnectStore().finally(() => process.exit(0))
    return
  }

  server.close(async () => {
    await disconnectStore()
    console.log('[PayzCore Shopify] Server closed')
    process.exit(0)
  })

  // Force exit after 10 seconds
  setTimeout(() => {
    console.error('[PayzCore Shopify] Forced exit after timeout')
    process.exit(1)
  }, 10_000)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

export default app

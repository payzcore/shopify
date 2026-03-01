/**
 * Shopify OAuth Routes
 *
 * Handles the Shopify OAuth flow for app installation:
 * 1. /auth/install - Redirects merchant to Shopify's OAuth consent screen
 * 2. /auth/callback - Exchanges authorization code for permanent access token
 *
 * After successful installation, the shop's access token is stored
 * for making Shopify Admin API calls (marking orders as paid, etc.).
 */

import { Router } from 'express'
import { createHmac } from 'crypto'
import type { AppConfig } from '../config'
import { isValidShopDomain, verifyShopifyQuery } from '../middleware/verify-shopify'
import { hasShop, saveShop } from '../store'

// Scopes needed: read/write orders to mark them as paid
const SCOPES = 'read_orders,write_orders'

export function createAuthRouter(config: AppConfig): Router {
  const router = Router()

  /**
   * GET /auth/install
   *
   * Start the Shopify OAuth flow. Merchant clicks "Install" in Shopify admin,
   * which sends them here with ?shop=store-name.myshopify.com
   */
  router.get('/install', (req, res) => {
    const shop = req.query.shop as string | undefined

    if (!shop || !isValidShopDomain(shop)) {
      res.status(400).send('Missing or invalid shop parameter. Expected: store-name.myshopify.com')
      return
    }

    // Generate a nonce for CSRF protection
    const nonce = createHmac('sha256', config.shopify.apiSecret)
      .update(`${shop}:${Date.now()}`)
      .digest('hex')
      .slice(0, 32)

    // Store nonce in session for validation in callback
    if (req.session) {
      req.session.shopifyNonce = nonce
      req.session.shopDomain = shop
    }

    const redirectUri = `${config.app.url}/auth/callback`
    const installUrl =
      `https://${shop}/admin/oauth/authorize` +
      `?client_id=${config.shopify.apiKey}` +
      `&scope=${SCOPES}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${nonce}`

    res.redirect(installUrl)
  })

  /**
   * GET /auth/callback
   *
   * Shopify redirects here after merchant approves the app.
   * Exchange the temporary code for a permanent access token.
   */
  router.get('/callback', verifyShopifyQuery(config), async (req, res) => {
    const shop = req.query.shop as string | undefined
    const code = req.query.code as string | undefined
    const state = req.query.state as string | undefined

    if (!shop || !isValidShopDomain(shop)) {
      res.status(400).send('Invalid shop domain')
      return
    }

    if (!code) {
      res.status(400).send('Missing authorization code')
      return
    }

    // Verify nonce matches (CSRF protection)
    if (req.session && state !== req.session.shopifyNonce) {
      res.status(403).send('State parameter mismatch. Possible CSRF attack.')
      return
    }

    try {
      // Exchange code for permanent access token
      const tokenResponse = await fetch(
        `https://${shop}/admin/oauth/access_token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: config.shopify.apiKey,
            client_secret: config.shopify.apiSecret,
            code,
          }),
          signal: AbortSignal.timeout(15_000),
        },
      )

      if (!tokenResponse.ok) {
        const text = await tokenResponse.text().catch(() => 'Unknown error')
        console.error(`[Auth] Token exchange failed for ${shop}: ${text}`)
        res.status(500).send('Failed to exchange authorization code. Please try again.')
        return
      }

      const tokenData = (await tokenResponse.json()) as {
        access_token: string
        scope: string
      }

      // Store shop credentials
      await saveShop(shop, {
        accessToken: tokenData.access_token,
        scope: tokenData.scope,
        installedAt: new Date().toISOString(),
      })

      console.log(`[Auth] App installed for shop: ${shop} (scopes: ${tokenData.scope})`)

      // Clear session nonce
      if (req.session) {
        req.session.shopifyNonce = null
        req.session.shopDomain = null
      }

      // Redirect to Shopify admin with success message
      res.redirect(`https://${shop}/admin/apps`)
    } catch (error) {
      console.error(`[Auth] OAuth callback error for ${shop}:`, error)
      res.status(500).send('Installation failed. Please try again.')
    }
  })

  /**
   * GET /auth/status
   *
   * Check if a shop is installed (for health checks).
   */
  router.get('/status', async (req, res) => {
    const shop = req.query.shop as string | undefined

    if (!shop || !isValidShopDomain(shop)) {
      res.status(400).json({ error: 'Invalid shop domain' })
      return
    }

    // Do not expose the access token, just confirm installation status
    const installed = await hasShop(shop)
    res.json({ shop, installed })
  })

  return router
}

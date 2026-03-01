# @payzcore/shopify

Shopify integration for PayzCore stablecoin transaction monitoring API.

Adds **"Pay with Crypto"** as a payment option in Shopify stores. Supports multiple networks (TRC20, BEP20, ERC20, Polygon, Arbitrum) and tokens (USDT, USDC). When a customer selects this method, the app creates a PayzCore monitoring request, displays a payment page with the blockchain address and QR code, and automatically marks the Shopify order as paid when the stablecoin transfer is detected.

**This integration does NOT hold, transmit, or custody any funds.** It monitors blockchain addresses for incoming USDT/USDC transfers and notifies Shopify when a transfer is detected.

## Important

**PayzCore is a blockchain monitoring service, not a payment processor.** All payments are sent directly to your own wallet addresses. PayzCore never holds, transfers, or has access to your funds.

- **Your wallets, your funds** — You provide your own wallet (HD xPub or static addresses). Customers pay directly to your addresses.
- **Read-only monitoring** — PayzCore watches the blockchain for incoming transactions and sends webhook notifications. That's it.
- **Protection Key security** — Sensitive operations like wallet management, address changes, and API key regeneration require a Protection Key that only you set. PayzCore cannot perform these actions without your authorization.
- **Your responsibility** — You are responsible for securing your own wallets and private keys. PayzCore provides monitoring and notification only.

## How It Works

```
Customer → Shopify Checkout → "Pay with Crypto" → PayzCore App
  → Selects blockchain network (if multiple enabled)
  → Shows address + QR code + countdown
  → Customer sends USDT/USDC from their wallet
  → PayzCore detects incoming transfer (blockchain monitoring)
  → Webhook → App marks Shopify order as paid
  → Customer auto-redirected to order confirmation
```

### Static Wallet Support

If your PayzCore project uses static (dedicated) wallet addresses instead of HD-derived addresses, the app handles this automatically:

- Pass the `address` query parameter in the payment creation URL to assign a specific wallet address
- If the API returns `requires_txid: true`, the payment page displays a transaction hash submission form so the customer can paste their tx hash after sending
- If the API returns a `notice` field, it is displayed as a highlighted banner on the payment page (e.g. "Send exactly 50.003 USDT")
- The submitted tx hash is forwarded to PayzCore via the `confirm_endpoint` returned in the payment response

## Prerequisites

- **PayzCore account** with an active project ([app.payzcore.com](https://app.payzcore.com))
- **Shopify Partner account** ([partners.shopify.com](https://partners.shopify.com))
- **Node.js 18+** (or Docker)
- A server/VPS to host the app (with a public URL and SSL)

## Quick Start

### 1. Create a Shopify App

1. Go to [Shopify Partners](https://partners.shopify.com) and create a new app
2. Set the App URL to your server: `https://your-app-domain.com`
3. Set the Allowed redirection URL to: `https://your-app-domain.com/auth/callback`
4. Note the **API Key** and **API Secret Key**

### 2. Configure PayzCore

1. Log in to [app.payzcore.com](https://app.payzcore.com)
2. Create a project (or use an existing one)
3. Note the **API Key** (`pk_live_xxx`) and **Webhook Secret** (`whsec_xxx`)
4. Set the project webhook URL to: `https://your-app-domain.com/webhooks/payzcore`

### 3. Deploy the App

```bash
# Clone and install
cd packages/shopify
npm install

# Configure environment
cp .env.example .env
# Edit .env with your credentials

# Development
npm run dev

# Production
npm run build
npm start
```

### 4. Install on Your Shopify Store

Visit: `https://your-app-domain.com/auth/install?shop=your-store.myshopify.com`

This initiates the OAuth flow and installs the app on your store.

### 5. Add Payment Link to Checkout

Add this to your Shopify checkout page or as an additional script:

```html
<script>
  // Redirect to crypto payment when customer clicks "Pay with Crypto"
  function payWithCrypto(network, token) {
    var shop = Shopify.shop;
    var orderId = Shopify.checkout.order_id;
    var amount = Shopify.checkout.payment_due;
    var currency = Shopify.checkout.currency;
    var email = Shopify.checkout.email;
    var returnUrl = window.location.href;

    var url =
      'https://your-app-domain.com/payment/create' +
      '?shop=' + encodeURIComponent(shop) +
      '&order_id=' + orderId +
      '&amount=' + amount +
      '&currency=' + currency +
      '&email=' + encodeURIComponent(email) +
      '&return_url=' + encodeURIComponent(returnUrl);

    // Optional: specify network and token (defaults to app config if omitted)
    // If ENABLED_NETWORKS has multiple entries and no network param is passed,
    // the app will show a network selector page to the customer.
    // Networks: TRC20, BEP20, ERC20, POLYGON, ARBITRUM
    // Tokens: USDT, USDC
    if (network) url += '&network=' + network;
    if (token) url += '&token=' + token;

    // Optional: specify a static wallet address (static wallet mode)
    // if (address) url += '&address=' + encodeURIComponent(address);

    window.location.href = url;
  }

  // Examples:
  // payWithCrypto();                    // Uses app defaults
  // payWithCrypto('TRC20', 'USDT');     // USDT on TRON
  // payWithCrypto('POLYGON', 'USDC');   // USDC on Polygon
</script>
```

For a more integrated approach, create a Shopify Script or use the Additional Scripts setting in your Shopify admin under Settings > Checkout.

## Docker Deployment

```bash
# Build
docker build -t payzcore-shopify .

# Run
docker run -d \
  --name payzcore-shopify \
  -p 3001:3001 \
  --env-file .env \
  payzcore-shopify
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SHOPIFY_API_KEY` | Yes | Shopify app API key |
| `SHOPIFY_API_SECRET` | Yes | Shopify app API secret |
| `PAYZCORE_API_KEY` | Yes | PayzCore project API key (`pk_live_xxx`) |
| `PAYZCORE_WEBHOOK_SECRET` | Yes | PayzCore project webhook secret (`whsec_xxx`) |
| `PAYZCORE_API_URL` | No | PayzCore API URL (default: `https://api.payzcore.com`) |
| `APP_URL` | Yes | Public URL of this app (no trailing slash) |
| `PORT` | No | Server port (default: `3001`) |
| `SESSION_SECRET` | Yes | Random string for session encryption (64+ chars) |
| `DEFAULT_NETWORK` | No | Default blockchain network: `TRC20`, `BEP20`, `ERC20`, `POLYGON`, or `ARBITRUM` (default: `TRC20`) |
| `DEFAULT_TOKEN` | No | Default stablecoin token: `USDT` or `USDC` (default: `USDT`) |
| `ENABLED_NETWORKS` | No | Comma-separated list of networks customers can choose from (e.g. `TRC20,BEP20,POLYGON`). If not set, only `DEFAULT_NETWORK` is available. When multiple networks are enabled, customers see a network selection page before paying. |

## Webhook Events

The app processes these PayzCore webhook events:

| Event | Action |
|-------|--------|
| `payment.completed` | Marks Shopify order as paid, adds transaction note |
| `payment.overpaid` | Marks Shopify order as paid, notes overpayment |
| `payment.expired` | Cancels the Shopify order |
| `payment.cancelled` | Payment cancelled by the merchant |
| `payment.partial` | Adds note about partial payment (order stays open) |

## Architecture

```
Shopify Store
    |
    | Customer selects "Pay with USDT"
    v
PayzCore Shopify App (this)
    |
    |-- /auth/*          Shopify OAuth (install, callback)
    |-- /payment/*       Payment pages (create, show, status, complete)
    |-- /webhooks/*      PayzCore webhook handler
    |
    |-- PayzCore API     Creates monitoring requests, checks status
    |-- Shopify API      Marks orders paid, adds notes/tags
```

## Security

- All Shopify requests verified via HMAC-SHA256
- All PayzCore webhooks verified via HMAC-SHA256
- Shop domain validation (must match `*.myshopify.com`)
- OAuth state parameter for CSRF protection
- Secure, HTTP-only session cookies
- Timing-safe signature comparison

## Before Going Live

**Always test your setup before accepting real payments:**

1. **Verify your wallet** — In the PayzCore dashboard, verify that your wallet addresses are correct. For HD wallets, click "Verify Key" and compare address #0 with your wallet app.
2. **Run a test order** — Place a test order for a small amount ($1–5) and complete the payment. Verify the funds arrive in your wallet.
3. **Test sweeping** — Send the test funds back out to confirm you control the addresses with your private keys.

> **Warning:** Wrong wallet configuration means payments go to addresses you don't control. Funds sent to incorrect addresses are permanently lost. PayzCore is watch-only and cannot recover funds. Please test before going live.

## See Also

- [Getting Started](https://docs.payzcore.com/getting-started) — Account setup and first payment
- [Webhooks Guide](https://docs.payzcore.com/guides/webhooks) — Events, headers, and signature verification
- [Supported Networks](https://docs.payzcore.com/guides/networks) — Available networks and tokens
- [Error Reference](https://docs.payzcore.com/guides/errors) — HTTP status codes and troubleshooting
- [API Reference](https://docs.payzcore.com) — Interactive API documentation

## License

MIT - PayzCore 2026

/**
 * Shopify Admin API Client
 *
 * Handles order management via Shopify's REST Admin API.
 * Used to mark orders as paid when PayzCore detects incoming USDT,
 * and to cancel orders when payment monitoring requests expire.
 */

const API_VERSION = '2024-10'
const REQUEST_TIMEOUT = 15_000

export interface ShopifyOrder {
  id: number
  name: string
  email: string
  financial_status: string
  total_price: string
  currency: string
  created_at: string
  cancelled_at: string | null
  note: string | null
  tags: string
}

export interface ShopifyTransaction {
  id: number
  order_id: number
  kind: string
  status: string
  amount: string
  currency: string
  gateway: string
}

export class ShopifyClient {
  private readonly shopDomain: string
  private readonly accessToken: string

  constructor(shopDomain: string, accessToken: string) {
    this.shopDomain = shopDomain
    this.accessToken = accessToken
  }

  /**
   * Make authenticated request to Shopify Admin API.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `https://${this.shopDomain}/admin/api/${API_VERSION}${path}`

    const headers: Record<string, string> = {
      'X-Shopify-Access-Token': this.accessToken,
      'Content-Type': 'application/json',
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error')
      throw new Error(`Shopify API error (${response.status}): ${text}`)
    }

    return (await response.json()) as T
  }

  /**
   * Get order details by ID.
   */
  async getOrder(orderId: number): Promise<ShopifyOrder> {
    const data = await this.request<{ order: ShopifyOrder }>(
      'GET',
      `/orders/${orderId}.json`,
    )
    return data.order
  }

  /**
   * Mark an order as paid by creating a capture transaction.
   *
   * This is used when PayzCore detects that the full USDT amount
   * has been received on the monitored blockchain address.
   */
  async markOrderAsPaid(
    orderId: number,
    details: {
      amount: string
      currency: string
      txHash: string | null
      network: string
      token?: string
      payzCorePaymentId: string
    },
  ): Promise<ShopifyTransaction> {
    const tokenLabel = details.token || 'USDT'

    // Create a transaction to mark the order as paid
    const data = await this.request<{ transaction: ShopifyTransaction }>(
      'POST',
      `/orders/${orderId}/transactions.json`,
      {
        transaction: {
          kind: 'capture',
          status: 'success',
          amount: details.amount,
          currency: details.currency,
          gateway: `PayzCore ${tokenLabel}`,
          source: 'external',
          message: `${tokenLabel} received on ${details.network}. PayzCore ID: ${details.payzCorePaymentId}${details.txHash ? `. TX: ${details.txHash}` : ''}`,
        },
      },
    )

    return data.transaction
  }

  /**
   * Add a note to an order with transaction details.
   */
  async addOrderNote(orderId: number, note: string): Promise<void> {
    await this.request('PUT', `/orders/${orderId}.json`, {
      order: {
        id: orderId,
        note,
      },
    })
  }

  /**
   * Add tags to an order for filtering in Shopify admin.
   */
  async addOrderTags(orderId: number, tags: string): Promise<void> {
    // Get current tags first
    const order = await this.getOrder(orderId)
    const currentTags = order.tags ? order.tags.split(', ') : []
    const newTags = tags.split(', ')

    // Merge without duplicates
    const mergedTags = [...new Set([...currentTags, ...newTags])]

    await this.request('PUT', `/orders/${orderId}.json`, {
      order: {
        id: orderId,
        tags: mergedTags.join(', '),
      },
    })
  }

  /**
   * Cancel an order (used when payment monitoring request expires).
   */
  async cancelOrder(orderId: number, reason: string): Promise<void> {
    await this.request('POST', `/orders/${orderId}/cancel.json`, {
      reason: 'other',
      note: reason,
      email: true,
    })
  }
}

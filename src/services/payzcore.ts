/**
 * PayzCore API Client
 *
 * Communicates with PayzCore blockchain transaction monitoring API
 * to create and query payment monitoring requests.
 */

import type { AppConfig } from '../config'

// ── Types ──

export type Network = 'TRC20' | 'BEP20' | 'ERC20' | 'POLYGON' | 'ARBITRUM'

export type Token = 'USDT' | 'USDC'

/** All supported networks */
export const SUPPORTED_NETWORKS: readonly Network[] = ['TRC20', 'BEP20', 'ERC20', 'POLYGON', 'ARBITRUM'] as const

/** All supported tokens */
export const SUPPORTED_TOKENS: readonly Token[] = ['USDT', 'USDC'] as const

/**
 * Valid network+token combinations.
 * TRC20 only supports USDT (Circle discontinued USDC on Tron).
 * All EVM networks support both USDT and USDC.
 */
export const VALID_NETWORK_TOKEN: Record<Network, readonly Token[]> = {
  TRC20: ['USDT'],
  BEP20: ['USDT', 'USDC'],
  ERC20: ['USDT', 'USDC'],
  POLYGON: ['USDT', 'USDC'],
  ARBITRUM: ['USDT', 'USDC'],
}

/** Check if a network+token combination is valid */
export function isValidNetworkToken(network: Network, token: Token): boolean {
  return (VALID_NETWORK_TOKEN[network] as readonly string[]).includes(token)
}

/** Human-readable network names */
export const NETWORK_LABELS: Record<Network, string> = {
  TRC20: 'TRON (TRC20)',
  BEP20: 'BNB Smart Chain (BEP20)',
  ERC20: 'Ethereum (ERC20)',
  POLYGON: 'Polygon',
  ARBITRUM: 'Arbitrum',
}

/** Block explorer base URLs for transactions */
export const NETWORK_EXPLORER_TX: Record<Network, string> = {
  TRC20: 'https://tronscan.org/#/transaction/',
  BEP20: 'https://bscscan.com/tx/',
  ERC20: 'https://etherscan.io/tx/',
  POLYGON: 'https://polygonscan.com/tx/',
  ARBITRUM: 'https://arbiscan.io/tx/',
}

export type PaymentStatus =
  | 'pending'
  | 'confirming'
  | 'partial'
  | 'paid'
  | 'overpaid'
  | 'expired'
  | 'cancelled'

export interface CreatePaymentParams {
  amount: number
  network: Network
  token?: Token
  external_ref: string
  external_order_id?: string
  /** Pre-assign a specific static wallet address (static wallet mode only) */
  address?: string
  expires_in?: number
  metadata?: Record<string, unknown>
}

export interface PayzCorePayment {
  id: string
  address: string
  amount: string
  network: Network
  token?: string
  status: PaymentStatus
  expires_at: string
  external_order_id?: string
  qr_code?: string
  /** Instructions for the payer (e.g. "Send exactly 50.003 USDT") — static wallet mode */
  notice?: string
  /** Whether the payer must submit their transaction hash — static wallet mode */
  requires_txid?: boolean
  /** Endpoint to POST tx_hash to for confirmation — static wallet mode */
  confirm_endpoint?: string
}

export interface CreatePaymentResponse {
  success: boolean
  existing?: boolean
  payment: PayzCorePayment
}

export interface GetPaymentResponse {
  success: boolean
  payment: {
    id: string
    status: PaymentStatus
    expected_amount: string
    paid_amount: string
    address: string
    network: Network
    token?: string
    tx_hash: string | null
    expires_at: string
    transactions: Array<{
      tx_hash: string
      amount: string
      from: string
      confirmed: boolean
    }>
  }
}

// ── Helpers ──

/** Type guard for Network values */
export function isValidNetwork(value: string): value is Network {
  return (SUPPORTED_NETWORKS as readonly string[]).includes(value)
}

/** Type guard for Token values */
export function isValidToken(value: string): value is Token {
  return (SUPPORTED_TOKENS as readonly string[]).includes(value)
}

// ── Client ──

const REQUEST_TIMEOUT = 30_000

export class PayzCoreClient {
  private readonly apiKey: string
  private readonly baseUrl: string

  constructor(config: AppConfig) {
    this.apiKey = config.payzcore.apiKey
    this.baseUrl = config.payzcore.apiUrl
  }

  /**
   * Create a new payment monitoring request.
   *
   * PayzCore derives a unique blockchain address, creates a monitoring order,
   * and returns the address + QR code for the customer to send stablecoins to.
   */
  async createPayment(params: CreatePaymentParams): Promise<CreatePaymentResponse> {
    // Build payload, only include token if explicitly set (backward compat)
    const payload: Record<string, unknown> = { ...params }
    if (!payload.token) {
      delete payload.token // Let the API default to USDT
    }

    const response = await fetch(`${this.baseUrl}/v1/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'User-Agent': '@payzcore/shopify/1.0.0',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => 'Unknown error')
      throw new Error(`PayzCore API error (${response.status}): ${body}`)
    }

    return (await response.json()) as CreatePaymentResponse
  }

  /**
   * Submit a transaction hash to confirm a payment (static wallet mode).
   *
   * When `requires_txid` is true in the payment creation response,
   * the customer must submit their transaction hash via this endpoint.
   */
  async confirmPayment(confirmEndpoint: string, txHash: string): Promise<{ success: boolean }> {
    const response = await fetch(`${this.baseUrl}${confirmEndpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'User-Agent': '@payzcore/shopify/1.0.0',
      },
      body: JSON.stringify({ tx_hash: txHash }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => 'Unknown error')
      throw new Error(`PayzCore API error (${response.status}): ${body}`)
    }

    return (await response.json()) as { success: boolean }
  }

  /**
   * Get current payment status with real-time blockchain check.
   *
   * PayzCore checks the blockchain for incoming transactions
   * and returns the latest status.
   */
  async getPayment(paymentId: string): Promise<GetPaymentResponse> {
    const response = await fetch(`${this.baseUrl}/v1/payments/${paymentId}`, {
      method: 'GET',
      headers: {
        'x-api-key': this.apiKey,
        'User-Agent': '@payzcore/shopify/1.0.0',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => 'Unknown error')
      throw new Error(`PayzCore API error (${response.status}): ${body}`)
    }

    return (await response.json()) as GetPaymentResponse
  }
}

/**
 * Application configuration loaded from environment variables.
 * Validates all required values at startup.
 */

import type { Network, Token } from './services/payzcore'

// Inline validation to avoid circular dependency at runtime
// (payzcore.ts imports AppConfig from here)
const VALID_NETWORKS = ['TRC20', 'BEP20', 'ERC20', 'POLYGON', 'ARBITRUM'] as const
const VALID_TOKENS = ['USDT', 'USDC'] as const

/** Valid network+token combinations. TRC20 supports USDT only. */
const VALID_NETWORK_TOKEN: Record<string, readonly string[]> = {
  TRC20: ['USDT'],
  BEP20: ['USDT', 'USDC'],
  ERC20: ['USDT', 'USDC'],
  POLYGON: ['USDT', 'USDC'],
  ARBITRUM: ['USDT', 'USDC'],
}

export interface AppConfig {
  shopify: {
    apiKey: string
    apiSecret: string
  }
  payzcore: {
    apiKey: string
    webhookSecret: string
    apiUrl: string
  }
  app: {
    url: string
    port: number
    sessionSecret: string
    enabledNetworks: Network[]
    defaultNetwork: Network
    defaultToken: Token
  }
}

export function loadConfig(): AppConfig {
  const required = (key: string): string => {
    const value = process.env[key]
    if (!value) {
      throw new Error(`Missing required environment variable: ${key}`)
    }
    return value
  }

  const network = process.env.DEFAULT_NETWORK ?? (process.env.DEFAULT_CHAIN ?? 'TRC20')
  if (!(VALID_NETWORKS as readonly string[]).includes(network)) {
    throw new Error(`DEFAULT_NETWORK must be one of: ${VALID_NETWORKS.join(', ')} (got: ${network})`)
  }

  const token = process.env.DEFAULT_TOKEN ?? 'USDT'
  if (!(VALID_TOKENS as readonly string[]).includes(token)) {
    throw new Error(`DEFAULT_TOKEN must be one of: ${VALID_TOKENS.join(', ')} (got: ${token})`)
  }

  // Validate network+token combination
  const validTokensForNetwork = VALID_NETWORK_TOKEN[network]
  if (!validTokensForNetwork || !validTokensForNetwork.includes(token)) {
    throw new Error(
      `USDC is not supported on TRC20. Use USDT or switch to an EVM network.`
    )
  }

  // ENABLED_NETWORKS is optional. If not set, networks are fetched from
  // PayzCore API at startup via fetchConfigFromApi().
  const enabledNetworksStr = process.env.ENABLED_NETWORKS ?? process.env.ENABLED_CHAINS
  let enabledNetworks: Network[]
  let configDefaultToken = token as Token

  if (enabledNetworksStr) {
    enabledNetworks = enabledNetworksStr
      .split(',')
      .map(c => c.trim())
      .filter(c => (VALID_NETWORKS as readonly string[]).includes(c)) as Network[]

    if (enabledNetworks.length === 0) {
      throw new Error(
        `ENABLED_NETWORKS must contain at least one valid network: ${VALID_NETWORKS.join(', ')}`
      )
    }
  } else {
    // Default to single network; will be overridden by fetchConfigFromApi() at startup
    enabledNetworks = [network as Network]
  }

  return {
    shopify: {
      apiKey: required('SHOPIFY_API_KEY'),
      apiSecret: required('SHOPIFY_API_SECRET'),
    },
    payzcore: {
      apiKey: required('PAYZCORE_API_KEY'),
      webhookSecret: required('PAYZCORE_WEBHOOK_SECRET'),
      apiUrl: (process.env.PAYZCORE_API_URL ?? 'https://api.payzcore.com').replace(/\/+$/, ''),
    },
    app: {
      url: required('APP_URL').replace(/\/+$/, ''),
      port: parseInt(process.env.PORT ?? '3001', 10),
      sessionSecret: (() => {
        const s = required('SESSION_SECRET')
        if (s.length < 32) {
          throw new Error('SESSION_SECRET must be at least 32 characters long')
        }
        return s
      })(),
      enabledNetworks,
      defaultNetwork: enabledNetworks[0], // first enabled network is the default
      defaultToken: configDefaultToken,
    },
  }
}

/**
 * Fetch available networks/tokens from PayzCore API config endpoint.
 * Updates the config object in-place if ENABLED_NETWORKS env is not set.
 * Called once at startup. Non-fatal: logs warning on failure.
 */
export async function fetchConfigFromApi(config: AppConfig): Promise<void> {
  // Skip if ENABLED_NETWORKS is explicitly set via env
  if (process.env.ENABLED_NETWORKS || process.env.ENABLED_CHAINS) {
    return
  }

  try {
    const url = `${config.payzcore.apiUrl}/v1/config`
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-api-key': config.payzcore.apiKey,
        'Accept': 'application/json',
        'User-Agent': 'payzcore-shopify/1.0.0',
      },
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) {
      console.warn(`[PayzCore Config] API returned ${res.status}, using defaults`)
      return
    }

    const data = await res.json() as {
      networks?: Array<{ network: string }>
      default_token?: string
    }

    if (data.networks && Array.isArray(data.networks) && data.networks.length > 0) {
      const networks = data.networks
        .map(c => c.network)
        .filter(c => (VALID_NETWORKS as readonly string[]).includes(c)) as Network[]

      if (networks.length > 0) {
        config.app.enabledNetworks = networks
        config.app.defaultNetwork = networks[0]
        console.log(`[PayzCore Config] Fetched networks from API: ${networks.join(', ')}`)
      }
    }

    if (data.default_token && (VALID_TOKENS as readonly string[]).includes(data.default_token)) {
      config.app.defaultToken = data.default_token as Token
      console.log(`[PayzCore Config] Default token from API: ${data.default_token}`)
    }
  } catch (err) {
    console.warn(`[PayzCore Config] Failed to fetch config from API: ${err instanceof Error ? err.message : err}`)
  }
}

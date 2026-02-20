/**
 * Application configuration loaded from environment variables.
 * Validates all required values at startup.
 */

import type { Chain, Token } from './services/payzcore'

// Inline validation to avoid circular dependency at runtime
// (payzcore.ts imports AppConfig from here)
const VALID_CHAINS = ['TRC20', 'BEP20', 'ERC20', 'POLYGON', 'ARBITRUM'] as const
const VALID_TOKENS = ['USDT', 'USDC'] as const

/** Valid chain+token combinations. TRC20 supports USDT only. */
const VALID_CHAIN_TOKEN: Record<string, readonly string[]> = {
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
    enabledChains: Chain[]
    defaultChain: Chain
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

  const chain = process.env.DEFAULT_CHAIN ?? 'TRC20'
  if (!(VALID_CHAINS as readonly string[]).includes(chain)) {
    throw new Error(`DEFAULT_CHAIN must be one of: ${VALID_CHAINS.join(', ')} (got: ${chain})`)
  }

  const token = process.env.DEFAULT_TOKEN ?? 'USDT'
  if (!(VALID_TOKENS as readonly string[]).includes(token)) {
    throw new Error(`DEFAULT_TOKEN must be one of: ${VALID_TOKENS.join(', ')} (got: ${token})`)
  }

  // Validate chain+token combination
  const validTokensForChain = VALID_CHAIN_TOKEN[chain]
  if (!validTokensForChain || !validTokensForChain.includes(token)) {
    throw new Error(
      `USDC is not supported on TRC20. Use USDT or switch to an EVM chain.`
    )
  }

  // ENABLED_CHAINS is optional. If not set, chains are fetched from
  // PayzCore API at startup via fetchConfigFromApi().
  const enabledChainsStr = process.env.ENABLED_CHAINS
  let enabledChains: Chain[]
  let configDefaultToken = token as Token

  if (enabledChainsStr) {
    enabledChains = enabledChainsStr
      .split(',')
      .map(c => c.trim())
      .filter(c => (VALID_CHAINS as readonly string[]).includes(c)) as Chain[]

    if (enabledChains.length === 0) {
      throw new Error(
        `ENABLED_CHAINS must contain at least one valid chain: ${VALID_CHAINS.join(', ')}`
      )
    }
  } else {
    // Default to single chain; will be overridden by fetchConfigFromApi() at startup
    enabledChains = [chain as Chain]
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
      enabledChains,
      defaultChain: enabledChains[0], // first enabled chain is the default
      defaultToken: configDefaultToken,
    },
  }
}

/**
 * Fetch available chains/token from PayzCore API config endpoint.
 * Updates the config object in-place if ENABLED_CHAINS env is not set.
 * Called once at startup. Non-fatal: logs warning on failure.
 */
export async function fetchConfigFromApi(config: AppConfig): Promise<void> {
  // Skip if ENABLED_CHAINS is explicitly set via env
  if (process.env.ENABLED_CHAINS) {
    return
  }

  try {
    const url = `${config.payzcore.apiUrl}/api/v1/config`
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-api-key': config.payzcore.apiKey,
        'Accept': 'application/json',
        'User-Agent': 'payzcore-shopify/1.1.1',
      },
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) {
      console.warn(`[PayzCore Config] API returned ${res.status}, using defaults`)
      return
    }

    const data = await res.json() as {
      chains?: Array<{ chain: string }>
      default_token?: string
    }

    if (data.chains && Array.isArray(data.chains) && data.chains.length > 0) {
      const chains = data.chains
        .map(c => c.chain)
        .filter(c => (VALID_CHAINS as readonly string[]).includes(c)) as Chain[]

      if (chains.length > 0) {
        config.app.enabledChains = chains
        config.app.defaultChain = chains[0]
        console.log(`[PayzCore Config] Fetched chains from API: ${chains.join(', ')}`)
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

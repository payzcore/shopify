import { readFileSync, existsSync } from 'fs';
import path from 'path';

interface PaymentTexts {
  payment: Record<string, string>;
  status: Record<string, string>;
  complete: Record<string, string>;
  error: Record<string, string>;
  networkSelector: Record<string, string>;
}

let cachedTexts: PaymentTexts | null = null;

const DEFAULTS: PaymentTexts = {
  payment: {
    sendExactly: 'Send exactly',
    viaNetwork: 'via {network}',
    scanQr: 'Scan with your wallet app',
    sendToAddress: 'Send to this address',
    timeRemaining: 'Time remaining',
    warningLine1: 'Send only {token} on the {network} network',
    warningLine2: 'Send the exact amount shown above',
    warningLine3: 'Sending wrong token or network may result in permanent loss',
    paymentReceived: 'Payment Received',
    paymentReceivedDetail: 'Your payment of {amount} {token} has been detected.',
    redirecting: 'Redirecting you back to the store...',
    returnToStore: 'Return to Store',
    paymentExpired: 'Payment Expired',
    paymentExpiredDetail: 'The payment window has closed. Please create a new order to try again.',
    securedBy: 'Secured by',
    copy: 'Copy',
    copied: 'Copied',
    txidLabel: 'After sending, paste your transaction hash below',
    txidPlaceholder: 'Transaction hash (e.g. 0xabc...)',
    txidSubmit: 'Submit',
  },
  status: {
    pending: 'Waiting for payment...',
    confirming: 'Transaction detected, confirming...',
    partial: 'Partial payment received',
    paid: 'Payment confirmed',
    overpaid: 'Payment confirmed (overpaid)',
    expired: 'Payment expired',
    cancelled: 'Payment cancelled',
  },
  complete: {
    title: 'Payment Successful',
    detail: '{amount} {token} received on {network} for order {order}.',
    processing: 'Your order is now being processed.',
    returnToStore: 'Return to Store',
    securedBy: 'Secured by',
  },
  error: {
    goBack: 'Go Back',
    securedBy: 'Secured by',
  },
  networkSelector: {
    title: 'Select Network',
    description: 'Choose which blockchain network to pay on',
    tokenLabel: 'Token',
    continueButton: 'Continue to Payment',
    orderLabel: 'Order',
    amountLabel: 'Amount',
    usdcNotOnTrc20: 'USDC is not available on TRC20. Please select USDT or choose a different network.',
  },
};

export function loadTexts(): PaymentTexts {
  if (cachedTexts) return cachedTexts;

  const configPath = path.join(process.cwd(), 'config', 'texts.json');

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const custom = JSON.parse(raw);
      // Deep merge: custom overrides defaults
      cachedTexts = {
        payment: { ...DEFAULTS.payment, ...custom.payment },
        status: { ...DEFAULTS.status, ...custom.status },
        complete: { ...DEFAULTS.complete, ...custom.complete },
        error: { ...DEFAULTS.error, ...custom.error },
        networkSelector: { ...DEFAULTS.networkSelector, ...custom.networkSelector },
      };
    } catch {
      cachedTexts = DEFAULTS;
    }
  } else {
    cachedTexts = DEFAULTS;
  }

  return cachedTexts;
}

export function replaceVars(text: string, vars: Record<string, string>): string {
  let result = text;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }
  return result;
}

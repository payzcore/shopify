/**
 * PayzCore Shopify Payment Page - Client-Side JavaScript
 *
 * Handles:
 * - Countdown timer to payment expiry
 * - Status polling (every 10 seconds) with consecutive failure tracking
 * - Copy address and amount to clipboard
 * - Auto-redirect on successful payment
 * - Expired state handling
 * - TX hash client-side validation
 * - Timer expiry disables txid form
 */

(function () {
  'use strict';

  // ── Configuration ──

  var POLL_INTERVAL = 10000; // 10 seconds
  var REDIRECT_DELAY = 5000; // 5 seconds after payment confirmed
  var TOTAL_DURATION = 3600; // 1 hour default (recalculated from expiresAt)
  var COPY_FEEDBACK_DURATION = 3000; // 3 seconds for copy feedback
  var MAX_POLL_FAILURES = 3; // Show warning after this many consecutive failures

  // ── State ──

  var payment = window.__PAYMENT__;
  var pollTimer = null;
  var countdownTimer = null;
  var isTerminal = false;
  var timerExpired = false;
  var consecutivePollFailures = 0;

  // ── DOM Elements ──

  var statusBanner = document.getElementById('status-banner');
  var statusText = document.getElementById('status-text');
  var paymentCard = document.getElementById('payment-card');
  var successOverlay = document.getElementById('success-overlay');
  var expiredOverlay = document.getElementById('expired-overlay');
  var successAmount = document.getElementById('success-amount');
  var countdownEl = document.getElementById('countdown');
  var timerBarFill = document.getElementById('timer-bar-fill');

  // ── Initialize ──

  if (payment) {
    startCountdown();
    startPolling();
  }

  // ── Countdown Timer ──

  function startCountdown() {
    var expiresAt = new Date(payment.expiresAt).getTime();
    var now = Date.now();
    TOTAL_DURATION = Math.max(1, Math.floor((expiresAt - now) / 1000));

    updateCountdown();
    countdownTimer = setInterval(updateCountdown, 1000);
  }

  function updateCountdown() {
    var expiresAt = new Date(payment.expiresAt).getTime();
    var now = Date.now();
    var remaining = Math.max(0, Math.floor((expiresAt - now) / 1000));

    if (remaining <= 0 && !isTerminal) {
      clearInterval(countdownTimer);
      timerExpired = true;
      disableTxidForm();
      showExpired();
      return;
    }

    var minutes = Math.floor(remaining / 60);
    var seconds = remaining % 60;
    var display = pad(minutes) + ':' + pad(seconds);

    if (countdownEl) {
      countdownEl.textContent = display;

      // Color warnings based on time remaining
      countdownEl.classList.remove('timer-warning', 'timer-critical');
      if (remaining < 120) {
        countdownEl.classList.add('timer-critical');
      } else if (remaining < 300) {
        countdownEl.classList.add('timer-warning');
      }
    }

    // Update progress bar
    if (timerBarFill) {
      var progress = Math.max(0, (remaining / TOTAL_DURATION) * 100);
      timerBarFill.style.width = progress + '%';

      timerBarFill.classList.remove('bar-warning', 'bar-critical');
      if (remaining < 120) {
        timerBarFill.classList.add('bar-critical');
      } else if (remaining < 300) {
        timerBarFill.classList.add('bar-warning');
      }
    }
  }

  function pad(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  // ── Status Polling ──

  function startPolling() {
    pollTimer = setInterval(pollStatus, POLL_INTERVAL);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function pollStatus() {
    if (isTerminal) {
      stopPolling();
      return;
    }

    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/payment/' + payment.id + '/status', true);
    xhr.timeout = 15000;

    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;

      if (xhr.status !== 200) {
        handlePollFailure();
        return;
      }

      try {
        var data = JSON.parse(xhr.responseText);
        consecutivePollFailures = 0;
        hidePollWarning();
        handleStatusUpdate(data);
      } catch (e) {
        handlePollFailure();
      }
    };

    xhr.onerror = function () {
      handlePollFailure();
    };

    xhr.ontimeout = function () {
      handlePollFailure();
    };

    xhr.send();
  }

  function handlePollFailure() {
    consecutivePollFailures++;
    if (consecutivePollFailures >= MAX_POLL_FAILURES) {
      showPollWarning();
    }
  }

  function showPollWarning() {
    var existing = document.getElementById('poll-warning');
    if (existing) return;

    var warning = document.createElement('div');
    warning.id = 'poll-warning';
    warning.className = 'poll-warning';
    warning.textContent = 'Connection issue. Status updates may be delayed. We will keep trying...';

    if (statusBanner && statusBanner.parentNode) {
      statusBanner.parentNode.insertBefore(warning, statusBanner.nextSibling);
    }
  }

  function hidePollWarning() {
    var existing = document.getElementById('poll-warning');
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
  }

  function handleStatusUpdate(data) {
    updateStatusBanner(data.status);

    if (data.is_paid) {
      isTerminal = true;
      stopPolling();
      clearInterval(countdownTimer);
      showSuccess(data.paid_amount || data.expected_amount);
    } else if (data.status === 'expired' || data.status === 'cancelled') {
      isTerminal = true;
      stopPolling();
      clearInterval(countdownTimer);
      timerExpired = true;
      disableTxidForm();
      showExpired();
    } else if (data.status === 'confirming') {
      updateStatusBanner('confirming');
    } else if (data.status === 'partial') {
      updateStatusBanner('partial');
      if (statusText) {
        var partialMsg = (window.statusTexts && window.statusTexts.partial) || 'Partial payment received';
        statusText.textContent = partialMsg + ' (' + data.paid_amount + ' USDT)';
      }
      showPartialGuidance();
    }
  }

  function showPartialGuidance() {
    var existing = document.getElementById('partial-guidance');
    if (existing) return;

    var guidance = document.createElement('div');
    guidance.id = 'partial-guidance';
    guidance.className = 'partial-guidance';
    guidance.textContent = window.partialGuidance || 'Send the remaining amount to the same address';

    // Insert after status banner
    if (statusBanner && statusBanner.parentNode) {
      statusBanner.parentNode.insertBefore(guidance, statusBanner.nextSibling);
    }
  }

  function updateStatusBanner(status) {
    if (!statusBanner || !statusText) return;

    // Remove all status classes
    statusBanner.className = 'status-banner status-' + status;

    // statusTexts is injected from the template via window.statusTexts
    var messages = window.statusTexts || {
      pending: 'Waiting for payment...',
      confirming: 'Transaction detected, confirming...',
      partial: 'Partial payment received',
      paid: 'Payment confirmed',
      overpaid: 'Payment confirmed (overpaid)',
      expired: 'Payment expired',
      cancelled: 'Payment cancelled',
    };

    statusText.textContent = messages[status] || status;
  }

  // ── State Transitions ──

  function showSuccess(amount) {
    if (paymentCard) paymentCard.style.display = 'none';
    if (statusBanner) statusBanner.style.display = 'none';
    if (successOverlay) {
      successOverlay.style.display = 'flex';
      if (successAmount) successAmount.textContent = amount;
    }

    // Auto-redirect after delay
    setTimeout(function () {
      window.location.href = payment.returnUrl || '/payment/' + payment.id + '/complete';
    }, REDIRECT_DELAY);
  }

  function showExpired() {
    if (paymentCard) paymentCard.style.display = 'none';
    if (statusBanner) statusBanner.style.display = 'none';
    if (expiredOverlay) expiredOverlay.style.display = 'flex';
  }

  // ── Disable TX Hash Form on Expiry ──

  function disableTxidForm() {
    var input = document.getElementById('txid-input');
    var btn = document.getElementById('txid-btn');
    if (input) input.disabled = true;
    if (btn) {
      btn.disabled = true;
      btn.style.opacity = '0.4';
    }
  }

  // ── TX Hash Validation ──

  function isValidTxHash(hash) {
    // Strip optional 0x prefix then check hex format, 10-128 chars
    var clean = hash.replace(/^0x/i, '');
    return /^[a-fA-F0-9]{10,128}$/.test(clean);
  }

  // ── Submit Transaction Hash (static wallet mode) ──

  window.submitTxHash = function () {
    var input = document.getElementById('txid-input');
    var btn = document.getElementById('txid-btn');
    var statusEl = document.getElementById('txid-status');

    if (!input || !btn) return;

    // Block submission if timer has expired
    if (timerExpired) {
      if (statusEl) {
        statusEl.textContent = 'Payment has expired. You can no longer submit a transaction hash.';
        statusEl.className = 'txid-status txid-error';
      }
      return;
    }

    var txHash = input.value.trim();
    if (!txHash) {
      if (statusEl) {
        statusEl.textContent = 'Please enter a transaction hash.';
        statusEl.className = 'txid-status txid-error';
      }
      return;
    }

    // Client-side hex format validation
    if (!isValidTxHash(txHash)) {
      if (statusEl) {
        statusEl.textContent = 'Invalid format. Transaction hash must be a hexadecimal string (e.g. 0xabc123...).';
        statusEl.className = 'txid-status txid-error';
      }
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Submitting...';
    if (statusEl) {
      statusEl.textContent = '';
      statusEl.className = 'txid-status';
    }

    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/payment/' + payment.id + '/confirm', true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.timeout = 30000;

    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;

      btn.disabled = false;
      btn.textContent = 'Submit';

      if (xhr.status === 200) {
        if (statusEl) {
          statusEl.textContent = 'Transaction hash submitted. Waiting for confirmation...';
          statusEl.className = 'txid-status txid-success';
        }
        input.disabled = true;
        btn.style.display = 'none';
      } else {
        var msg = 'Failed to submit. Please try again.';
        try {
          var data = JSON.parse(xhr.responseText);
          if (data.error) msg = data.error;
        } catch (e) { /* ignore */ }
        if (statusEl) {
          statusEl.textContent = msg;
          statusEl.className = 'txid-status txid-error';
        }
      }
    };

    xhr.onerror = function () {
      btn.disabled = false;
      btn.textContent = 'Submit';
      if (statusEl) {
        statusEl.textContent = 'Network error. Please try again.';
        statusEl.className = 'txid-status txid-error';
      }
    };

    xhr.send(JSON.stringify({ tx_hash: txHash }));
  };

  // ── Copy Address ──

  window.copyAddress = function () {
    var addressText = document.getElementById('address-text');
    var copyBtn = document.getElementById('copy-btn');
    var copyTextEl = document.getElementById('copy-text');

    if (!addressText) return;

    var text = addressText.textContent || addressText.innerText;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        showCopied(copyBtn, copyTextEl);
      }).catch(function () {
        fallbackCopy(text, copyBtn, copyTextEl);
      });
    } else {
      fallbackCopy(text, copyBtn, copyTextEl);
    }
  };

  // ── Copy Amount ──

  window.copyAmount = function () {
    var amountEl = document.getElementById('payment-amount');
    var copyBtn = document.getElementById('copy-amount-btn');
    var copyTextEl = document.getElementById('copy-amount-text');

    if (!amountEl) return;

    var text = amountEl.textContent || amountEl.innerText;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        showCopied(copyBtn, copyTextEl);
      }).catch(function () {
        fallbackCopy(text, copyBtn, copyTextEl);
      });
    } else {
      fallbackCopy(text, copyBtn, copyTextEl);
    }
  };

  function fallbackCopy(text, copyBtn, copyTextEl) {
    var textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      showCopied(copyBtn, copyTextEl);
    } catch (e) {
      // Copy failed silently
    }
    document.body.removeChild(textarea);
  }

  function showCopied(copyBtn, copyTextEl) {
    // copyTexts is injected from the template via window.copyTexts
    var ct = window.copyTexts || { copy: 'Copy', copied: 'Copied' };
    if (copyBtn) copyBtn.classList.add('copied');
    if (copyTextEl) copyTextEl.textContent = ct.copied;

    setTimeout(function () {
      if (copyBtn) copyBtn.classList.remove('copied');
      if (copyTextEl) copyTextEl.textContent = ct.copy;
    }, COPY_FEEDBACK_DURATION);
  }
})();

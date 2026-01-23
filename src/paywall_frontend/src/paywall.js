import { Actor, HttpAgent } from '@dfinity/agent';
import { AuthClient } from '@dfinity/auth-client';
import { IDL } from '@dfinity/candid';
import { Buffer } from 'buffer';
import { LedgerCanister, principalToAccountIdentifier } from '@dfinity/ledger-icp';
import { Principal } from '@dfinity/principal';

const II_URL = 'https://id.ai/#authorize';
const DEFAULT_LEDGER_ID = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const LEDGER_FEE_E8S = 10000n;
const PERIODIC_CHECK_INTERVAL_MS = 30000;
const TAMPER_CHECK_INTERVAL_MS = 5000;
const DEVTOOLS_THRESHOLD_PX = 160;
const OVERLAY_STYLE =
  'position:fixed;inset:0;background:rgba(6,9,20,0.88);color:#fff;z-index:999999999;display:flex;align-items:center;justify-content:center;padding:24px;pointer-events:all;';
let storedBodyStyles = null;
let overlayObserver = null;
let paywallActive = false;
let tamperDetected = false;
let tamperReason = null;
let tamperIntervalId = null;
let tamperContext = null;
let activeOverlay = null;
let interactionsDisabled = false;
let lastTamperLogAt = 0;

if (!globalThis.Buffer) {
  globalThis.Buffer = Buffer;
}

const stringifyWithBigInt = (value) => {
  if (value === null || value === undefined) return 'null';
  try {
    return JSON.stringify(
      value,
      (key, currentValue) =>
        typeof currentValue === 'bigint'
          ? currentValue.toString()
          : currentValue,
    );
  } catch (error) {
    return String(value);
  }
};

const isMobile = () => {
  const userAgent = navigator?.userAgent || '';
  return /Mobile|Android|iP(ad|hone|od)|BlackBerry|IEMobile|Kindle|Silk|Opera Mini/i.test(
    userAgent,
  );
};

const formatErrorMessage = (error, fallback) => {
  if (!error) return fallback;
  if (typeof error === 'string') return error;
  if (typeof error?.message === 'string' && error.message.trim()) {
    return error.message;
  }
  return stringifyWithBigInt(error);
};

const formatDuration = (durationNs) => {
  if (typeof durationNs !== 'bigint' || durationNs < 0n) {
    return 'an unknown duration';
  }
  const totalSeconds = Number(durationNs / 1_000_000_000n);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor(((totalSeconds % 86400) % 3600) / 60);
  const seconds = (totalSeconds % 86400) % 60;
  let result = '';
  if (days > 0) {
    result += `${days} days, `;
  }
  result += `${hours} hours, ${minutes} minutes, ${seconds} seconds`;
  return result;
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pollHasAccess = async (
  authedActor,
  principal,
  paywallId,
  maxAttempts = 10,
  delayMs = 1000,
) => {
  console.log(`Starting pollHasAccess for paywall ${paywallId}`);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const hasAccess = await authedActor.hasAccess(principal, paywallId);
      if (hasAccess) {
        console.log(`Access granted on attempt ${attempt + 1}`);
        return true;
      }
      console.log(`No access on attempt ${attempt + 1}, retrying...`);
    } catch (error) {
      console.warn(`Poll attempt ${attempt + 1} failed:`, error);
    }
    if (attempt < maxAttempts - 1) {
      await delay(delayMs);
    }
  }
  console.log(`Polling failed after ${maxAttempts} attempts`);
  return false;
};

const unwrapSubaccount = (subaccount) => {
  if (!Array.isArray(subaccount) || subaccount.length === 0) {
    return undefined;
  }
  const bytes = subaccount[0];
  return bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
};

const idlFactory = ({ IDL }) => {
  const Dest = IDL.Variant({
    Principal: IDL.Record({ principal: IDL.Principal, convertToCycles: IDL.Bool }),
    AccountId: IDL.Vec(IDL.Nat8),
  });
  const Destination = IDL.Record({
    dest: Dest,
    percentage: IDL.Nat,
  });
  const PaywallConfig = IDL.Record({
    price_e8s: IDL.Nat,
    target_url: IDL.Text,
    session_duration_ns: IDL.Nat,
    destinations: IDL.Vec(Destination),
    login_prompt_text: IDL.Opt(IDL.Text),
    payment_prompt_text: IDL.Opt(IDL.Text),
  });
  const Account = IDL.Record({
    owner: IDL.Principal,
    subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
  });
  const PaymentResult = IDL.Variant({ Ok: IDL.Null, Err: IDL.Text });
  const WithdrawTo = IDL.Variant({
    Account: Account,
    LegacyAccountId: IDL.Vec(IDL.Nat8),
  });
  const TransferResult = IDL.Variant({ Ok: IDL.Nat, Err: IDL.Text });
  return IDL.Service({
    getPaywallConfig: IDL.Func([IDL.Text], [IDL.Opt(PaywallConfig)], ['query']),
    getPaymentAccount: IDL.Func([IDL.Text], [IDL.Opt(Account)], []),
    getUserAccount: IDL.Func([], [Account], []),
    hasAccess: IDL.Func([IDL.Principal, IDL.Text], [IDL.Bool], ['query']),
    payFromBalance: IDL.Func([IDL.Text], [PaymentResult], []),
    verifyPayment: IDL.Func([IDL.Text], [PaymentResult], []),
    withdrawFromWallet: IDL.Func([IDL.Nat, WithdrawTo], [TransferResult], []),
    getAccessExpiry: IDL.Func([IDL.Principal, IDL.Text], [IDL.Opt(IDL.Int)], ['query']),
    logTamper: IDL.Func([IDL.Text, IDL.Text], [], ['query']),
  });
};

const bytesToHex = (bytes) =>
  Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

const hexToBytes = (hex) => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
};

const getExpectedScriptHash = (scriptTag) =>
  (scriptTag?.dataset?.integrityHash || window.PAYWALL_SCRIPT_HASH || '')
    .trim()
    .toLowerCase();

const fetchScriptHash = async (scriptTag) => {
  if (!scriptTag?.src || !window.crypto?.subtle) return null;
  try {
    const response = await fetch(scriptTag.src, { cache: 'no-store' });
    if (!response.ok) {
      return null;
    }
    const buffer = await response.arrayBuffer();
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', buffer);
    return bytesToHex(new Uint8Array(hashBuffer));
  } catch (error) {
    console.warn('Failed to hash paywall script:', error);
    return null;
  }
};

const logTamper = async (details) => {
  if (!tamperContext?.actor || !tamperContext?.paywallId) return;
  const now = Date.now();
  if (now - lastTamperLogAt < 10_000) return;
  lastTamperLogAt = now;
  try {
    await tamperContext.actor.logTamper(tamperContext.paywallId, details);
  } catch (error) {
    console.warn('Tamper log failed:', error);
  }
};

const markTamper = (details) => {
  tamperDetected = true;
  if (!tamperReason) {
    tamperReason = details;
  }
  const warning = activeOverlay?.querySelector('#tamper-warning');
  if (warning) {
    warning.style.display = 'block';
  }
  void logTamper(details);
};

const checkScriptIntegrity = async (scriptTag, expectedHash) => {
  if (!expectedHash) return true;
  const hash = await fetchScriptHash(scriptTag);
  if (!hash) return true;
  return hash === expectedHash;
};

const detectDevTools = () => {
  const widthGap = Math.abs(window.outerWidth - window.innerWidth);
  const heightGap = Math.abs(window.outerHeight - window.innerHeight);
  return widthGap < DEVTOOLS_THRESHOLD_PX && heightGap < DEVTOOLS_THRESHOLD_PX;
};

const runTamperCheck = async () => {
  if (!tamperContext || tamperDetected) return !tamperDetected;
  const integrityOk = await checkScriptIntegrity(
    tamperContext.scriptTag,
    tamperContext.expectedScriptHash,
  );
  if (!integrityOk) {
    markTamper('Script integrity check failed');
  }
  if (!isMobile() && !detectDevTools()) {
    markTamper('Dev tools detected');
  }
  return !tamperDetected;
};

const startTamperChecks = () => {
  if (tamperIntervalId) return;
  tamperIntervalId = setInterval(() => {
    if (!paywallActive) return;
    void runTamperCheck();
  }, TAMPER_CHECK_INTERVAL_MS);
};

const stopTamperChecks = () => {
  if (tamperIntervalId) {
    clearInterval(tamperIntervalId);
    tamperIntervalId = null;
  }
};

const buildOverlay = (onLogin) => {
  const overlay = document.createElement('div');
  overlay.style.cssText = OVERLAY_STYLE;
  const panel = document.createElement('div');
  panel.style.cssText =
    'background:#111827;padding:32px 32px 24px;border-radius:16px;width:min(92vw,520px);max-height:90vh;overflow:auto;text-align:center;box-shadow:0 20px 40px rgba(0,0,0,0.45);';
  panel.id = 'paywall-panel';
  panel.innerHTML = `
    <h2 style="margin:0 0 12px;font-size:clamp(20px,5.5vw,26px);">Payment required</h2>
    <p style="margin:0 0 16px;font-size:clamp(15px,4.2vw,18px);" id="paywall-login-prompt">Log in to check access.</p>
    <button id="paywall-login" style="background:#4f46e5;color:#fff;border:none;border-radius:10px;padding:12px 16px;font-size:clamp(15px,4.2vw,18px);cursor:pointer;margin-bottom:12px;min-height:44px;">Log in to check access</button>
    <div id="paywall-details" style="display:none;margin-top:16px;text-align:left;font-size:clamp(14px,3.8vw,16px);"></div>
    <div id="paywall-loading" style="display:none;margin-top:16px;color:#9ca3af;">Loading...</div>
    <div id="paywall-error" style="display:none;margin-top:16px;color:#ef4444;"></div>
    <p id="tamper-warning" style="display:none;color:#ef4444;font-weight:bold;">Tampering detected! Access blocked.</p>
  `;
  overlay.appendChild(panel);

  const logoLink = document.createElement('a');
  logoLink.href = 'https://4kz7m-7iaaa-aaaab-adm5a-cai.icp0.io/';
  logoLink.target = '_blank';
  logoLink.rel = 'noopener noreferrer';
  logoLink.style.cssText =
    'position:absolute;bottom:16px;left:50%;transform:translateX(-50%);text-decoration:none;';

  const logoImg = document.createElement('img');
  logoImg.src = 'https://4kz7m-7iaaa-aaaab-adm5a-cai.icp0.io/logo.png';
  logoImg.alt = 'IC Paywall logo';
  logoImg.style.cssText =
    'width:24vw;max-width:240px;min-width:140px;height:auto;cursor:pointer;';

  logoLink.appendChild(logoImg);
  overlay.appendChild(logoLink);

  const updatePanelMaxHeight = () => {
    const logoHeight = logoImg.offsetHeight;
    if (logoHeight > 0) {
      panel.style.maxHeight = `calc(90vh - ${logoHeight + 32}px)`;
    }
  };

  logoImg.addEventListener('load', updatePanelMaxHeight);

  overlay.__paywallLogo = logoImg;
  overlay.__paywallPanel = panel;
  overlay.__updatePanelMaxHeight = updatePanelMaxHeight;

  overlay.querySelector('#paywall-login').addEventListener('click', onLogin);
  return overlay;
};

const setupPaymentUI = async (
  overlay,
  authedActor,
  identity,
  config,
  paywallId,
  agent,
  ledgerId,
  onAccessGranted,
) => {
  const details = overlay.querySelector('#paywall-details');
  details.style.display = 'block';
  details.innerHTML = '';

  const priceE8s = BigInt(config.price_e8s);
  const priceIcp = Number(priceE8s) / 100_000_000;
  const transferCount = BigInt(config.destinations.length + 1);
  const requiredBalanceE8s = priceE8s + LEDGER_FEE_E8S * transferCount;
  const requiredBalanceIcp = Number(requiredBalanceE8s) / 100_000_000;
  const totalCostLabel = requiredBalanceIcp.toFixed(8);
  const paymentPromptText =
    config.payment_prompt_text?.[0]?.trim() ||
    'Complete payment to continue.';

  const userAccount = await authedActor.getUserAccount();
  const ledger = LedgerCanister.create({
    agent,
    canisterId: Principal.fromText(ledgerId),
  });
  const userSubaccount = unwrapSubaccount(userAccount.subaccount);
  let userBalanceE8s = 0n;
  try {
    const accountIdentifier = principalToAccountIdentifier(
      userAccount.owner,
      userSubaccount,
    );
    userBalanceE8s = await ledger.accountBalance({
      accountIdentifier,
      certified: false,
    });
  } catch (error) {
    console.error('Error fetching user balance:', error);
    alert(
      'Failed to fetch your balance. Assuming 0 ICP. Please try again or deposit manually.',
    );
  }
  const userBalanceIcp = Number(userBalanceE8s) / 100_000_000;
  const accountIdentifier = principalToAccountIdentifier(
    userAccount.owner,
    userSubaccount,
  );

  const priceLine = document.createElement('p');
  priceLine.style.margin = '0 0 8px';
  priceLine.style.fontSize = '18px';
  priceLine.style.fontWeight = '600';
  priceLine.textContent = `Pay ${totalCostLabel} ICP to continue (includes network fees).`;
  details.appendChild(priceLine);

  const paymentPromptLine = document.createElement('p');
  paymentPromptLine.style.margin = '0 0 12px';
  paymentPromptLine.textContent = paymentPromptText;
  details.appendChild(paymentPromptLine);

  const balanceLine = document.createElement('p');
  balanceLine.style.margin = '0 0 12px';
  balanceLine.textContent = `Your paywall balance: ${userBalanceIcp.toFixed(8)} ICP`;
  details.appendChild(balanceLine);

  const accountInfo = document.createElement('div');
  accountInfo.style.margin = '0 0 12px';
  const accountLabel = document.createElement('p');
  accountLabel.style.margin = '0 0 8px';
  accountLabel.textContent = 'Your Account ID:';
  const accountRow = document.createElement('div');
  accountRow.style.cssText =
    'display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;';
  const accountSpan = document.createElement('span');
  accountSpan.className = 'mono';
  accountSpan.textContent = accountIdentifier;
  accountSpan.style.cssText =
    'word-break:break-all;display:block;max-width:100%;';
  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.textContent = 'Copy';
  copyButton.style.cssText =
    'background:#4f46e5;color:#fff;border:none;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer;';
  copyButton.addEventListener('click', async () => {
    try {
      await copyToClipboard(accountIdentifier);
      copyButton.textContent = 'Copied!';
      setTimeout(() => {
        copyButton.textContent = 'Copy';
      }, 1500);
    } catch (error) {
      console.error('Copy failed:', error);
      alert('Copy failed. Please copy the account ID manually.');
    }
  });
  accountRow.appendChild(accountSpan);
  accountRow.appendChild(copyButton);
  accountInfo.appendChild(accountLabel);
  accountInfo.appendChild(accountRow);
  details.appendChild(accountInfo);

  const buildPayFromBalanceButton = () => {
    const payFromBalanceButton = document.createElement('button');
    payFromBalanceButton.textContent = 'Pay from balance';
    payFromBalanceButton.style.cssText =
      'background:#16a34a;color:#fff;border:none;border-radius:10px;padding:10px 16px;font-size:14px;cursor:pointer;margin-bottom:12px;';
    payFromBalanceButton.addEventListener('click', async () => {
      const duration = formatDuration(config.session_duration_ns);
      const confirmMessage = `Are you sure you want to pay ${totalCostLabel} ICP (includes network fees)? This will unlock the paywall for ${duration}.`;
      if (!confirm(confirmMessage)) {
        return;
      }

      payFromBalanceButton.disabled = true;
      payFromBalanceButton.textContent = 'Processing...';

      try {
        const result = await authedActor.payFromBalance(paywallId);
        if ('Ok' in result) {
          console.log('Payment succeeded, polling for access confirmation...');
          const confirmedAccess = await pollHasAccess(
            authedActor,
            identity.getPrincipal(),
            paywallId,
          );
          if (confirmedAccess) {
            console.log('Access confirmed after payment');
            revealContent(overlay);
            if (onAccessGranted) {
              await onAccessGranted();
            }
            return;
          }
          console.warn('Access not confirmed after polling');
          alert(
            'Payment succeeded, but access is still propagating. Please wait a moment and refresh.',
          );
          return;
        }
        const errorText = result.Err || 'Unknown error';
        console.error('Payment failed:', errorText);
        console.info('Payment result:', stringifyWithBigInt(result));
        console.info('Paywall ID:', paywallId);
        console.info('Paywall config:', stringifyWithBigInt(config));
        console.info('User principal:', identity.getPrincipal().toText());
        console.info(
          'Destinations:',
          config.destinations.map((destination) => ({
            destination: destination.destination.toText(),
            percentage: destination.percentage.toString(),
            convertToCycles: destination.convertToCycles,
          })),
        );
        alert(
          `Payment could not be completed from your balance: ${errorText}. Check developer console for details.`,
        );
      } catch (error) {
        console.error('Payment error:', error);
        if (error?.stack) {
          console.error('Payment error stack:', error.stack);
        }
        console.info('Payment error details:', stringifyWithBigInt(error));
        console.info('Paywall ID:', paywallId);
        console.info('Paywall config:', stringifyWithBigInt(config));
        console.info('User principal:', identity.getPrincipal().toText());
        console.info(
          'Destinations:',
          config.destinations.map((destination) => ({
            destination: destination.destination.toText(),
            percentage: destination.percentage.toString(),
            convertToCycles: destination.convertToCycles,
          })),
        );
        alert(
          `An error occurred during payment: ${formatErrorMessage(
            error,
            'Unknown error - check console for details',
          )}`,
        );
      } finally {
        payFromBalanceButton.disabled = false;
        payFromBalanceButton.textContent = 'Pay from balance';
      }
    });
    return payFromBalanceButton;
  };

  let payFromBalanceButton = null;
  const showPayFromBalanceButton = () => {
    if (payFromBalanceButton) return;
    payFromBalanceButton = buildPayFromBalanceButton();
    details.appendChild(payFromBalanceButton);
  };

  let note = null;
  const showDepositNote = () => {
    if (note) return;
    note = document.createElement('p');
    note.style.margin = '0 0 12px';
    note.style.fontStyle = 'italic';
    note.textContent =
      `Deposit at least ${requiredBalanceIcp.toFixed(8)} ICP to cover the payment (including network fees) and ledger transfers. Use the Account ID above in your wallet (e.g., NNS dapp) to send ICP. After transfer, refresh or re-login to see updated balance.`;
    details.appendChild(note);
  };

  if (userBalanceE8s >= requiredBalanceE8s) {
    showPayFromBalanceButton();
  } else {
    showDepositNote();
  }

  const refreshButton = document.createElement('button');
  refreshButton.type = 'button';
  refreshButton.textContent = 'Refresh balance';
  refreshButton.style.cssText =
    'background:#3b82f6;color:#fff;border:none;border-radius:10px;padding:10px 16px;font-size:14px;cursor:pointer;margin-bottom:12px;';
  refreshButton.addEventListener('click', async () => {
    refreshButton.disabled = true;
    refreshButton.textContent = 'Refreshing...';
    try {
      const refreshedBalanceE8s = await ledger.accountBalance({
        accountIdentifier,
        certified: false,
      });
      userBalanceE8s = refreshedBalanceE8s;
      const refreshedBalanceIcp = Number(userBalanceE8s) / 100_000_000;
      balanceLine.textContent = `Your paywall balance: ${refreshedBalanceIcp.toFixed(8)} ICP`;

      if (userBalanceE8s >= requiredBalanceE8s) {
        if (note) {
          note.remove();
          note = null;
        }
        showPayFromBalanceButton();
      } else {
        showDepositNote();
      }
    } catch (error) {
      console.error('Error refreshing balance:', error);
      alert('Failed to refresh balance. Please try again.');
    } finally {
      refreshButton.disabled = false;
      refreshButton.textContent = 'Refresh balance';
    }
  });
  details.appendChild(refreshButton);

  const withdrawButton = document.createElement('button');
  withdrawButton.textContent = 'Withdraw from balance';
  withdrawButton.style.cssText =
    'background:#0ea5e9;color:#fff;border:none;border-radius:10px;padding:10px 16px;font-size:14px;cursor:pointer;';
  withdrawButton.addEventListener('click', async () => {
    const destination = prompt('Enter destination Principal or Account ID:');
    if (!destination) return;
    const input = destination.trim();

    let to;
    if (/^[0-9a-fA-F]{64}$/.test(input)) {
      to = { LegacyAccountId: hexToBytes(input) };
    } else {
      try {
        const principal = Principal.fromText(input);
        to = { Account: { owner: principal, subaccount: [] } };
      } catch (error) {
        alert('Invalid input: Must be a valid Principal or 64-hex Account ID.');
        return;
      }
    }

    const amountText = prompt('Enter amount in ICP:');
    if (!amountText) return;

    const amountIcp = Number.parseFloat(amountText);
    if (Number.isNaN(amountIcp) || amountIcp <= 0) {
      alert('Invalid amount.');
      return;
    }
    const amountE8s = BigInt(Math.round(amountIcp * 100_000_000));
    const confirmMessage = `Confirm withdrawal of ${amountIcp.toFixed(8)} ICP to ${destination}?`;
    if (!confirm(confirmMessage)) {
      return;
    }

    withdrawButton.disabled = true;
    withdrawButton.textContent = 'Withdrawing...';
    try {
      const result = await authedActor.withdrawFromWallet(
        amountE8s,
        to,
      );
      let message = '';
      if ('Ok' in result) {
        message = `Withdraw successful! Block index: ${result.Ok}`;
      } else {
        message = `Withdraw failed: ${result.Err}`;
      }
      alert(message);
    } catch (error) {
      const errorMessage = formatErrorMessage(
        error,
        'Unknown error - check console for details',
      );
      alert(`An error occurred during withdrawal: ${errorMessage}`);
      console.error(
        'Withdrawal error:',
        formatErrorMessage(error, 'Unknown error'),
      );
    } finally {
      withdrawButton.disabled = false;
      withdrawButton.textContent = 'Withdraw from balance';
    }
  });
  details.appendChild(withdrawButton);
};

const copyToClipboard = async (text) => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'absolute';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
};

const removeLoginControls = (overlay) => {
  const loginPrompt = overlay.querySelector('#paywall-login-prompt');
  if (loginPrompt) {
    loginPrompt.remove();
  }
  const loginButton = overlay.querySelector('#paywall-login');
  if (loginButton) {
    loginButton.remove();
  }
};

const preventPaywalledInteraction = (event) => {
  if (!paywallActive) return;
  if (activeOverlay && activeOverlay.contains(event.target)) return;
  event.preventDefault();
  event.stopPropagation();
};

const disableInteractions = () => {
  if (interactionsDisabled) return;
  interactionsDisabled = true;
  document.body.style.pointerEvents = 'none';
  document.body.style.userSelect = 'none';
  [
    'keydown',
    'keyup',
    'keypress',
    'contextmenu',
    'wheel',
    'touchmove',
    'pointerdown',
    'mousedown',
    'mouseup',
    'click',
  ].forEach((eventName) => {
    document.addEventListener(eventName, preventPaywalledInteraction, {
      capture: true,
      passive: false,
    });
  });
};

const enableInteractions = () => {
  if (!interactionsDisabled) return;
  interactionsDisabled = false;
  document.body.style.pointerEvents = '';
  document.body.style.userSelect = '';
  [
    'keydown',
    'keyup',
    'keypress',
    'contextmenu',
    'wheel',
    'touchmove',
    'pointerdown',
    'mousedown',
    'mouseup',
    'click',
  ].forEach((eventName) => {
    document.removeEventListener(eventName, preventPaywalledInteraction, {
      capture: true,
    });
  });
};

const hideContent = () => {
  if (storedBodyStyles) return;
  storedBodyStyles = {
    overflow: document.body.style.overflow,
    filter: document.body.style.filter,
    transition: document.body.style.transition,
  };
  document.body.style.overflow = 'hidden';
  document.body.style.filter = 'blur(6px)';
  document.body.style.transition = 'filter 0.2s ease';
  disableInteractions();
};

const restoreContent = () => {
  if (!storedBodyStyles) return;
  document.body.style.overflow = storedBodyStyles.overflow || '';
  document.body.style.filter = storedBodyStyles.filter || '';
  document.body.style.transition = storedBodyStyles.transition || '';
  storedBodyStyles = null;
  enableInteractions();
};

const ensureBodyReady = () =>
  new Promise((resolve) => {
    if (document.body) {
      resolve();
      return;
    }
    window.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
  });

const startOverlayObservers = (overlay) => {
  if (!overlayObserver) {
    overlayObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList' && paywallActive && !overlay.isConnected) {
          document.documentElement.appendChild(overlay);
        }
        if (
          mutation.type === 'attributes' &&
          mutation.target === overlay &&
          mutation.attributeName === 'style'
        ) {
          overlay.style.cssText = OVERLAY_STYLE;
        }
      }
      if (paywallActive && !overlay.isConnected) {
        document.documentElement.appendChild(overlay);
      }
    });
    overlayObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style'],
    });
  }
};

const stopOverlayObservers = () => {
  if (overlayObserver) {
    overlayObserver.disconnect();
    overlayObserver = null;
  }
};

const showOverlay = (overlay) => {
  paywallActive = true;
  activeOverlay = overlay;
  hideContent();
  if (!overlay.isConnected) {
    document.documentElement.appendChild(overlay);
    if (overlay.__paywallLogo?.complete && overlay.__updatePanelMaxHeight) {
      overlay.__updatePanelMaxHeight();
    }
    if (overlay.__updatePanelMaxHeight) {
      requestAnimationFrame(() => overlay.__updatePanelMaxHeight());
    }
  }
  if (tamperDetected) {
    const warning = overlay.querySelector('#tamper-warning');
    if (warning) {
      warning.style.display = 'block';
    }
  }
  startOverlayObservers(overlay);
  startTamperChecks();
  void runTamperCheck();
};

const revealContent = (overlay) => {
  if (tamperDetected && isMobile() && tamperReason === 'Dev tools detected') {
    tamperDetected = false;
    tamperReason = null;
    const warning = overlay.querySelector('#tamper-warning');
    if (warning) {
      warning.style.display = 'none';
    }
  }
  if (tamperDetected) {
    showOverlay(overlay);
    return;
  }
  overlay.remove();
  paywallActive = false;
  activeOverlay = null;
  if (overlay?.__onResize) {
    window.removeEventListener('resize', overlay.__onResize);
    overlay.__onResize = null;
  }
  stopOverlayObservers();
  stopTamperChecks();
  restoreContent();
};

const run = async () => {
  try {
    const scriptTag = document.querySelector('script[data-paywall]');
    if (!scriptTag) return;
    const scriptSrc = scriptTag.src || '';
    const paywallUrl = scriptSrc ? new URL(scriptSrc) : null;
    const paywallId = paywallUrl?.searchParams.get('paywallId');
    if (!paywallId) return;
    const backendId =
      scriptTag.dataset.backendId || window.PAYWALL_BACKEND_ID || '';
    const ledgerId =
      scriptTag.dataset.ledgerId ||
      window.PAYWALL_LEDGER_ID ||
      DEFAULT_LEDGER_ID;

    if (!backendId) return;

    const expectedScriptHash = getExpectedScriptHash(scriptTag);
    const agent = new HttpAgent({ host: 'https://icp0.io' });
    const actor = Actor.createActor(idlFactory, {
      agent,
      canisterId: backendId,
    });

    const configResponse = await actor.getPaywallConfig(paywallId);
    const config = configResponse?.[0];
    if (!config || typeof config.price_e8s === 'undefined') return;

    const priceE8s = BigInt(config.price_e8s);
    const priceIcp = Number(priceE8s) / 100_000_000;
    if (!Number.isFinite(priceIcp)) return;
    const loginPromptText =
      config.login_prompt_text?.[0]?.trim() || 'Log in to check access.';

    let accessTimeoutId = null;
    let accessIntervalId = null;

    const clearAccessTimers = () => {
      if (accessTimeoutId) {
        clearTimeout(accessTimeoutId);
        accessTimeoutId = null;
      }
      if (accessIntervalId) {
        clearInterval(accessIntervalId);
        accessIntervalId = null;
      }
    };

    const scheduleAccessTimers = async (authedActor, identity) => {
      clearAccessTimers();
      try {
        const expiryResponse = await authedActor.getAccessExpiry(
          identity.getPrincipal(),
          paywallId,
        );
        const expiryNs = expiryResponse?.[0];
        if (expiryNs) {
          const nowNs = BigInt(Date.now()) * 1_000_000n;
          const remainingNs = expiryNs - nowNs;
          if (remainingNs > 0n) {
            let remainingMs = Number(remainingNs / 1_000_000n);
            if (remainingMs > Number.MAX_SAFE_INTEGER) {
              remainingMs = Number.MAX_SAFE_INTEGER;
            }
            accessTimeoutId = setTimeout(() => {
              void showPaywall(authedActor, identity);
            }, remainingMs);
          }
        }
      } catch (error) {
        console.error('Error fetching access expiry:', error);
      }

      accessIntervalId = setInterval(async () => {
        try {
          const stillHasAccess = await authedActor.hasAccess(
            identity.getPrincipal(),
            paywallId,
          );
          if (stillHasAccess) {
            return;
          }
          console.log('Periodic check failed, confirming...');
          await delay(1000);
          const confirmAccess = await authedActor.hasAccess(
            identity.getPrincipal(),
            paywallId,
          );
          if (confirmAccess) {
            console.log('Access confirmed on second check');
            return;
          }
          console.warn('Access expired on periodic check');
          clearAccessTimers();
          await showPaywall(authedActor, identity);
        } catch (error) {
          console.error('Periodic access check failed:', error);
          await showPaywall(authedActor, identity);
        }
      }, PERIODIC_CHECK_INTERVAL_MS);

      window.addEventListener('beforeunload', () => {
        clearAccessTimers();
      });
    };

    const showPaywall = async (authedActor, identity) => {
      showOverlay(overlay);
      removeLoginControls(overlay);
      await setupPaymentUI(
        overlay,
        authedActor,
        identity,
        config,
        paywallId,
        agent,
        ledgerId,
        async () => {
          await scheduleAccessTimers(authedActor, identity);
        },
      );
    };

    await ensureBodyReady();

    const overlay = buildOverlay(async () => {
      const loading = overlay.querySelector('#paywall-loading');
      const errorMessage = overlay.querySelector('#paywall-error');
      loading.style.display = 'block';
      errorMessage.style.display = 'none';
      try {
        const authClient = await AuthClient.create();
        await new Promise((resolve, reject) => {
          authClient.login({
            identityProvider: II_URL,
            maxTimeToLive: BigInt(8 * 60 * 60 * 1_000_000_000),
            onSuccess: resolve,
            onError: reject,
          });
        });

        const identity = authClient.getIdentity();
        agent.replaceIdentity(identity);
        const authedActor = Actor.createActor(idlFactory, {
          agent,
          canisterId: backendId,
        });

        const hasAccess = await pollHasAccess(
          authedActor,
          identity.getPrincipal(),
          paywallId,
        );
        if (hasAccess) {
          revealContent(overlay);
          await scheduleAccessTimers(authedActor, identity);
          return;
        }

        removeLoginControls(overlay);
        await setupPaymentUI(
          overlay,
          authedActor,
          identity,
          config,
          paywallId,
          agent,
          ledgerId,
          async () => {
            await scheduleAccessTimers(authedActor, identity);
          },
        );
      } catch (error) {
        console.error('Error during login/access check:', error);
        errorMessage.textContent = 'An error occurred. Please try again.';
        errorMessage.style.display = 'block';
      } finally {
        loading.style.display = 'none';
      }
    });

    tamperContext = {
      actor,
      paywallId,
      scriptTag,
      expectedScriptHash,
      overlay,
    };

    if (overlay.__updatePanelMaxHeight) {
      overlay.__onResize = () => overlay.__updatePanelMaxHeight();
      window.addEventListener('resize', overlay.__onResize);
    }

    overlay.querySelector('#paywall-login-prompt').textContent = loginPromptText;

    const authClient = await AuthClient.create();
    const isAuthed = await authClient.isAuthenticated();
    if (isAuthed) {
      const identity = authClient.getIdentity();
      agent.replaceIdentity(identity);
      const authedActor = Actor.createActor(idlFactory, {
        agent,
        canisterId: backendId,
      });
      const hasAccess = await pollHasAccess(
        authedActor,
        identity.getPrincipal(),
        paywallId,
      );
      if (hasAccess) {
        revealContent(overlay);
        await scheduleAccessTimers(authedActor, identity);
        return;
      }
    }

    showOverlay(overlay);

    window.paywallHandshake = async (onFailure) => {
      if (tamperDetected) {
        if (onFailure) onFailure();
        return false;
      }
      try {
        const authClient = await AuthClient.create();
        const isAuthed = await authClient.isAuthenticated();
        if (!isAuthed) {
          if (onFailure) onFailure();
          return false;
        }
        const identity = authClient.getIdentity();
        const handshakeAgent = new HttpAgent({ host: 'https://icp0.io' });
        handshakeAgent.replaceIdentity(identity);
        const authedActor = Actor.createActor(idlFactory, {
          agent: handshakeAgent,
          canisterId: backendId,
        });
        const hasAccess = await authedActor.hasAccess(
          identity.getPrincipal(),
          paywallId,
        );
        const tamperOk = await runTamperCheck();
        if (!tamperOk) {
          if (onFailure) onFailure();
          return false;
        }
        if (!hasAccess && onFailure) {
          onFailure();
        }
        return hasAccess;
      } catch (error) {
        console.error('Handshake failed:', error);
        if (onFailure) onFailure();
        return false;
      }
    };
  } catch (error) {
    console.error('Paywall script error:', error);
    paywallActive = false;
    activeOverlay = null;
    tamperContext = null;
    stopOverlayObservers();
    stopTamperChecks();
    restoreContent();
  }
};

run();

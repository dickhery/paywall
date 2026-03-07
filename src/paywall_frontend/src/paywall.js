import { Actor, HttpAgent } from '@dfinity/agent';
import { AuthClient, LocalStorage } from '@dfinity/auth-client';
import { IDL } from '@dfinity/candid';
import { Buffer } from 'buffer';
import { LedgerCanister, principalToAccountIdentifier } from '@dfinity/ledger-icp';
import { Principal } from '@dfinity/principal';

const II_URL_PRIMARY = 'https://identity.ic0.app/#authorize';
const II_URL_FALLBACK = 'https://identity.internetcomputer.org/#authorize';
const MIN_AUTH_TTL_NS = BigInt(3 * 60 * 60 * 1_000_000_000);
const LOGIN_TIMEOUT_MS = 60000;
const DEFAULT_LEDGER_ID = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const DEFAULT_IC_HOST = 'https://icp-api.io';
const LEDGER_FEE_E8S = 10000n;
const WATERMARK_ID = 'wm-paywall-script-v1-def456-unique';
const TRACKING_URL = 'https://r5s6s-waaaa-aaaab-ac3za-cai.icp0.io/track';
const GRACE_PERIOD_MS = 120000;
const PERIODIC_CHECK_INTERVAL_MS = 30000;
const TAMPER_CHECK_INTERVAL_MS = 5000;
const DEVTOOLS_THRESHOLD_PX = 160;
const OVERLAY_STYLE =
  'position:fixed;inset:0;background:rgba(6,9,20,0.88);color:#fff;z-index:999999999;display:flex;align-items:center;justify-content:center;padding:24px;pointer-events:all;';
const getRecentPaymentKey = (paywallId) => `paywall_recent_${paywallId}`;
const getLocalExpiryKey = (paywallId) => `paywall_expiry_${paywallId}`;
const nowNs = () => BigInt(Date.now()) * 1_000_000n;
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

const formatIcp = (e8s) => {
  const num = typeof e8s === 'bigint' ? Number(e8s) : Number(e8s);
  if (!Number.isFinite(num)) return '0';
  return (num / 100_000_000).toFixed(8).replace(/\.?0+$/, '');
};

const calculateShortfall = (currentE8s, requiredE8s) => {
  if (currentE8s >= requiredE8s) return 0n;
  return requiredE8s - currentE8s;
};

const formatInsufficientBalanceMessage = (message) => {
  if (!message?.includes('Insufficient balance')) {
    return message;
  }

  const match = message.match(/have\s+(\d+),\s*need\s+(\d+)/i);
  if (!match) {
    return message;
  }

  const [, haveRaw, needRaw] = match;
  return `Insufficient balance: you have ${formatIcp(haveRaw)} ICP but need ${formatIcp(needRaw)} ICP.`;
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

const withTimeout = (promise, ms, errorMessage) => {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
};

const createAuthClient = async () => {
  return AuthClient.create({
    storage: new LocalStorage('paywall_'),
    keyType: 'Ed25519',
  });
};

const loginWithFallback = async (authClient) => {
  try {
    await withTimeout(
      new Promise((resolve, reject) => {
        authClient.login({
          identityProvider: II_URL_PRIMARY,
          maxTimeToLive: MIN_AUTH_TTL_NS,
          onSuccess: resolve,
          onError: reject,
        });
      }),
      LOGIN_TIMEOUT_MS,
      'Login timed out. Please try again.',
    );
    return;
  } catch (error) {
    console.warn('Primary Internet Identity login failed, retrying fallback:', error);
    await withTimeout(
      new Promise((resolve, reject) => {
        authClient.login({
          identityProvider: II_URL_FALLBACK,
          maxTimeToLive: MIN_AUTH_TTL_NS,
          onSuccess: resolve,
          onError: reject,
        });
      }),
      LOGIN_TIMEOUT_MS,
      'Login timed out. Please try again.',
    );
  }
};

const initSessionTracker = () => {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams({
    watermark: WATERMARK_ID,
    domain: window.location.host,
  });
  fetch(`${TRACKING_URL}?${params.toString()}`, {
    method: 'GET',
    mode: 'no-cors',
  }).catch(() => {});
};

const pollHasAccess = async (
  authedActor,
  principal,
  paywallId,
  maxAttempts = 30,
  delayMs = 1500,
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

const reportPaymentSuccess = (paywallId, principalText) => {
  const params = new URLSearchParams({
    watermark: 'paywall-success-v1',
    paywallId,
    user: principalText,
  });
  fetch(`${TRACKING_URL}?${params.toString()}`, { mode: 'no-cors' }).catch(() => {});
};

const checkAccessWithGrace = async (authedActor, principal, paywallId) => {
  const localExpiry = readLocalExpiry(paywallId);
  if (localExpiry && localExpiry > nowNs()) {
    return true;
  }

  let hasAccess = await tryHasMyAccess(authedActor, principal, paywallId);
  if (hasAccess) {
    const expiryResponse = await tryGetMyExpiry(authedActor, principal, paywallId);
    const expiryNs = expiryResponse?.[0];
    if (expiryNs) writeLocalExpiry(paywallId, expiryNs);
    return true;
  }

  const key = getRecentPaymentKey(paywallId);
  const timestampStr = localStorage.getItem(key);
  if (timestampStr) {
    const timestamp = Number.parseInt(timestampStr, 10);
    if (!Number.isNaN(timestamp) && Date.now() - timestamp < GRACE_PERIOD_MS) {
      hasAccess = await pollHasAccess(authedActor, principal, paywallId, 60, 800);
      if (hasAccess) {
        const expiryResponse = await tryGetMyExpiry(authedActor, principal, paywallId);
        const expiryNs = expiryResponse?.[0];
        if (expiryNs) writeLocalExpiry(paywallId, expiryNs);
        return true;
      }
    } else {
      localStorage.removeItem(key);
    }
  }
  return false;
};

const readLocalExpiry = (paywallId) => {
  try {
    const raw = localStorage.getItem(getLocalExpiryKey(paywallId));
    if (!raw) return null;
    const value = BigInt(raw);
    return value > 0n ? value : null;
  } catch {
    return null;
  }
};

const writeLocalExpiry = (paywallId, expiryNs) => {
  try {
    if (typeof expiryNs === 'bigint') {
      localStorage.setItem(getLocalExpiryKey(paywallId), expiryNs.toString());
    }
  } catch {}
};

const tryHasMyAccess = async (authedActor, principal, paywallId) => {
  try {
    return await authedActor.hasMyAccess(paywallId);
  } catch (_error) {
    return await authedActor.hasAccess(principal, paywallId);
  }
};

const tryGetMyExpiry = async (authedActor, principal, paywallId) => {
  try {
    return await authedActor.getMyAccessExpiry(paywallId);
  } catch (_error) {
    return await authedActor.getAccessExpiry(principal, paywallId);
  }
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
    usage_count: IDL.Nat,
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
    getUserAccount: IDL.Func([], [Account], []),
    hasAccess: IDL.Func([IDL.Principal, IDL.Text], [IDL.Bool], ['query']),
    hasMyAccess: IDL.Func([IDL.Text], [IDL.Bool], []),
    payFromBalance: IDL.Func([IDL.Text], [PaymentResult], []),
    settleEscrow: IDL.Func([IDL.Text], [PaymentResult], []),
    refundEscrow: IDL.Func([IDL.Text], [PaymentResult], []),
    withdrawFromWallet: IDL.Func([IDL.Nat, WithdrawTo], [TransferResult], []),
    getAccessExpiry: IDL.Func([IDL.Principal, IDL.Text], [IDL.Opt(IDL.Int)], ['query']),
    getMyAccessExpiry: IDL.Func([IDL.Text], [IDL.Opt(IDL.Int)], []),
    getEscrowBalance: IDL.Func([IDL.Text, IDL.Principal], [IDL.Nat], []),
    logTamper: IDL.Func([IDL.Text, IDL.Text], [], ['query']),
  });
};

const bytesToHex = (bytes) =>
  Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

const formatDestinationsForLog = (destinations) =>
  (destinations || []).map((d) => {
    if (d?.dest?.Principal) {
      return {
        type: 'Principal',
        principal: d.dest.Principal.principal.toText(),
        convertToCycles: d.dest.Principal.convertToCycles,
        percentage: d.percentage?.toString?.() ?? String(d.percentage),
      };
    }
    if (d?.dest?.AccountId) {
      const accountIdBytes =
        d.dest.AccountId instanceof Uint8Array
          ? d.dest.AccountId
          : Uint8Array.from(d.dest.AccountId);
      return {
        type: 'AccountId',
        accountIdHex: bytesToHex(accountIdBytes),
        percentage: d.percentage?.toString?.() ?? String(d.percentage),
      };
    }
    return { type: 'Unknown', raw: stringifyWithBigInt(d) };
  });

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

const buildOverlay = (onLogin, formattedPrice = '0') => {
  const overlay = document.createElement('div');
  overlay.style.cssText = OVERLAY_STYLE;
  overlay.id = 'ic-paywall-overlay';

  const panel = document.createElement('div');
  panel.style.cssText =
    'background:#111827;padding:32px 32px 24px;border-radius:16px;width:min(92vw,520px);max-height:90vh;overflow:auto;text-align:center;box-shadow:0 20px 40px rgba(0,0,0,0.45);position:relative;';
  panel.id = 'paywall-panel';
  panel.innerHTML = `
    <button id="paywall-back-btn" style="position:absolute;top:20px;left:20px;background:none;border:none;color:#9ca3af;font-size:28px;line-height:1;cursor:pointer;padding:4px 12px;" aria-label="Go back">←</button>
    <h2 style="margin:0 0 12px;font-size:clamp(20px,5.5vw,26px);padding-left:52px;">${formattedPrice} ICP payment required</h2>
    <p style="margin:0 0 16px;font-size:clamp(15px,4.2vw,18px);" id="paywall-login-prompt">Log in to check access.</p>
    <button id="paywall-login" style="background:#4f46e5;color:#fff;border:none;border-radius:10px;padding:12px 16px;font-size:clamp(15px,4.2vw,18px);cursor:pointer;margin-bottom:12px;min-height:44px;">Log in to check access</button>
    <div id="paywall-details" style="display:none;margin-top:16px;text-align:left;font-size:clamp(14px,3.8vw,16px);"></div>
    <div id="paywall-loading" style="display:none;margin-top:16px;color:#9ca3af;">Loading...</div>
    <div id="paywall-error" style="display:none;margin-top:16px;color:#ef4444;"></div>
    <p id="tamper-warning" style="display:none;color:#ef4444;font-weight:bold;">Tampering detected! Access blocked.</p>
  `;
  overlay.appendChild(panel);

  const backButton = panel.querySelector('#paywall-back-btn');
  if (backButton) {
    backButton.addEventListener('click', () => {
      window.history.back();
    });
  }

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
  const destinationCount = config.destinations?.length ?? 0;
  const ledgerFeeCount = BigInt(destinationCount + 2);
  const requiredBalanceE8s = priceE8s + LEDGER_FEE_E8S * ledgerFeeCount;

  const priceIcp = Number(priceE8s) / 100_000_000;
  const estimatedFeesIcp = Number(LEDGER_FEE_E8S * ledgerFeeCount) / 100_000_000;
  const requiredBalanceIcp = Number(requiredBalanceE8s) / 100_000_000;

  const paymentPromptText =
    config.payment_prompt_text?.[0]?.trim() || 'Complete payment to continue.';

  const ledger = LedgerCanister.create({
    agent,
    canisterId: Principal.fromText(ledgerId),
  });

  const getAccountInfo = async (account, labelForErrors) => {
    const subaccount = unwrapSubaccount(account.subaccount);
    const accountIdentifier = principalToAccountIdentifier(account.owner, subaccount);

    let balanceE8s = 0n;
    try {
      balanceE8s = await ledger.accountBalance({
        accountIdentifier,
        certified: false,
      });
    } catch (error) {
      console.error(`Error fetching ${labelForErrors} balance:`, error);
      alert(
        `Failed to fetch your ${labelForErrors} balance. Assuming 0 ICP. You can still deposit and click Refresh.`,
      );
    }

    return { accountIdentifier, balanceE8s };
  };

  const renderAccountBlock = (title, accountIdentifier, balanceE8s) => {
    const wrapper = document.createElement('div');
    wrapper.style.cssText =
      'margin:12px 0;padding:12px;border:1px solid rgba(255,255,255,0.12);border-radius:12px;background:rgba(255,255,255,0.04);';

    const header = document.createElement('p');
    header.style.cssText = 'margin:0 0 8px;font-weight:700;';
    header.textContent = title;
    wrapper.appendChild(header);

    const bal = document.createElement('p');
    bal.style.cssText = 'margin:0 0 10px;color:#d1d5db;';
    bal.textContent = `Balance: ${(Number(balanceE8s) / 100_000_000).toFixed(8)} ICP`;
    wrapper.appendChild(bal);

    const label = document.createElement('p');
    label.style.cssText = 'margin:0 0 6px;color:#d1d5db;';
    label.textContent = 'Account ID (deposit here):';
    wrapper.appendChild(label);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;';

    const span = document.createElement('span');
    span.textContent = accountIdentifier;
    span.style.cssText =
      'word-break:break-all;display:block;max-width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;font-size:12px;line-height:1.35;';

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.textContent = 'Copy';
    copyButton.style.cssText =
      'background:#4f46e5;color:#fff;border:none;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer;min-height:36px;';
    copyButton.addEventListener('click', async () => {
      try {
        await copyToClipboard(accountIdentifier);
        copyButton.textContent = 'Copied!';
        setTimeout(() => (copyButton.textContent = 'Copy'), 1200);
      } catch (error) {
        console.error('Copy failed:', error);
        alert('Copy failed. Please copy manually.');
      }
    });

    row.appendChild(span);
    row.appendChild(copyButton);
    wrapper.appendChild(row);

    return { wrapper, bal };
  };

  const headline = document.createElement('p');
  headline.style.cssText = 'margin:0 0 10px;font-size:18px;font-weight:700;';
  headline.textContent = `Payment required: ${formatIcp(requiredBalanceE8s)} ICP total (price + fees)`;
  details.appendChild(headline);

  const breakdown = document.createElement('p');
  breakdown.style.cssText = 'margin:0 0 12px;color:#d1d5db;';
  breakdown.textContent =
    `Includes price (${formatIcp(priceE8s)} ICP) + estimated network fees ` +
    `(${formatIcp(LEDGER_FEE_E8S * ledgerFeeCount)} ICP).`;
  details.appendChild(breakdown);

  const promptLine = document.createElement('p');
  promptLine.style.cssText = 'margin:0 0 14px;';
  promptLine.textContent = paymentPromptText;
  details.appendChild(promptLine);

  const guideBtn = document.createElement('button');
  guideBtn.type = 'button';
  guideBtn.textContent = '▼ How this paywall works';
  guideBtn.style.cssText =
    'background:#1f2937;color:#d1d5db;border:none;border-radius:10px;padding:10px 16px;font-size:13px;cursor:pointer;margin:0 0 10px;width:100%;text-align:left;';

  const guideContent = document.createElement('div');
  guideContent.style.cssText =
    'display:none;background:rgba(255,255,255,0.05);padding:14px;border-radius:10px;margin:0 0 12px;font-size:13px;line-height:1.5;color:#e5e7eb;';
  guideContent.innerHTML = `
    <strong>How this paywall works:</strong><br>
    • Deposit ICP to the wallet address above.<br>
    • Click <strong>I have deposited – Unlock now</strong>.<br><br>
    <strong>Button explained:</strong><br>
    • <strong>I have deposited – Unlock now</strong>: Pays from your wallet balance (the only payment method).<br>
    • <strong>Refresh balances</strong>: Updates wallet balance after deposit.<br>
    • <strong>Retry payment settlement</strong>: Retries moving escrowed funds to the paywall owner if settlement got stuck.<br>
    • <strong>Refund escrow</strong>: Sends escrowed funds back to your wallet balance.<br>
    • <strong>Withdraw from wallet balance</strong>: Transfer wallet funds to another account/principal.<br><br>
    Network transfer fees are included in the total required ICP shown above.
  `;

  guideBtn.addEventListener('click', () => {
    const shouldOpen = guideContent.style.display === 'none';
    guideContent.style.display = shouldOpen ? 'block' : 'none';
    guideBtn.textContent = shouldOpen
      ? '▲ How this paywall works'
      : '▼ How this paywall works';
  });

  details.appendChild(guideBtn);
  details.appendChild(guideContent);

  const walletAccount = await authedActor.getUserAccount();
  const walletInfo = await getAccountInfo(walletAccount, 'wallet');

  const walletBlock = renderAccountBlock(
    'Your Paywall Wallet (deposit ICP here)',
    walletInfo.accountIdentifier,
    walletInfo.balanceE8s,
  );
  details.appendChild(walletBlock.wrapper);

  const escrowBalance = await authedActor.getEscrowBalance(paywallId, identity.getPrincipal());
  const escrowWrapper = document.createElement('div');
  escrowWrapper.style.cssText =
    'margin:12px 0;padding:12px;border:1px solid rgba(255,255,255,0.12);border-radius:12px;background:rgba(255,255,255,0.04);';

  const escrowHeader = document.createElement('p');
  escrowHeader.style.cssText = 'margin:0 0 8px;font-weight:700;';
  escrowHeader.textContent = 'Escrow (temporary hold)';
  escrowWrapper.appendChild(escrowHeader);

  const escrowBal = document.createElement('p');
  escrowBal.style.cssText = 'margin:0 0 12px;color:#d1d5db;';
  escrowWrapper.appendChild(escrowBal);

  const escrowRefundNote = document.createElement('p');
  escrowRefundNote.style.cssText = 'margin:4px 0 8px;font-size:12px;color:#9ca3af;display:none;';
  escrowRefundNote.textContent = 'Returns funds to your wallet (no payments in progress)';
  escrowWrapper.appendChild(escrowRefundNote);

  const escrowRefundButton = document.createElement('button');
  escrowRefundButton.type = 'button';
  escrowRefundButton.textContent = 'Refund escrow';
  escrowRefundButton.style.cssText =
    'background:#ef4444;color:#fff;border:none;border-radius:10px;padding:8px 16px;font-size:14px;cursor:pointer;min-height:40px;width:100%;display:none;';
  escrowWrapper.appendChild(escrowRefundButton);

  let escrowBalanceE8s = escrowBalance;
  const updateEscrowUi = (balanceE8s) => {
    escrowBalanceE8s = balanceE8s;
    escrowBal.textContent = `Balance: ${formatIcp(escrowBalanceE8s)} ICP`;
    const showRefund = escrowBalanceE8s > LEDGER_FEE_E8S;
    escrowRefundNote.style.display = showRefund ? 'block' : 'none';
    escrowRefundButton.style.display = showRefund ? 'block' : 'none';
  };

  escrowRefundButton.addEventListener('click', async () => {
    if (!confirm('Refund all escrow back to your Paywall wallet balance?')) return;

    escrowRefundButton.disabled = true;
    escrowRefundButton.textContent = 'Refunding...';
    try {
      const result = await authedActor.refundEscrow(paywallId);
      if ('Ok' in result) {
        alert('✅ Refund submitted successfully. Refreshing balances...');
        refreshButton.click();
      } else {
        alert(`Refund failed: ${result.Err}`);
      }
    } catch (error) {
      alert(`Refund error: ${formatErrorMessage(error, 'Unknown error')}`);
    } finally {
      escrowRefundButton.disabled = false;
      escrowRefundButton.textContent = 'Refund escrow';
    }
  });

  updateEscrowUi(escrowBalance);
  details.appendChild(escrowWrapper);

  const makePaymentBtn = document.createElement('button');
  makePaymentBtn.type = 'button';
  makePaymentBtn.style.cssText =
    'background:#16a34a;color:#fff;border:none;border-radius:12px;padding:14px 20px;font-size:16px;font-weight:600;cursor:pointer;width:100%;margin:16px 0 8px;min-height:52px;';
  makePaymentBtn.textContent = 'I have deposited – Unlock now';

  makePaymentBtn.addEventListener('click', async () => {
    const durationText = formatDuration(config.session_duration_ns);
    const confirmMessage =
      `You are about to be charged ${requiredBalanceIcp.toFixed(8)} ICP TOTAL from your paywall wallet balance.\n\n` +
      `Breakdown:\n` +
      `• Paywall price:          ${priceIcp.toFixed(8)} ICP\n` +
      `• Ledger/network fees (est.): ${estimatedFeesIcp.toFixed(8)} ICP\n\n` +
      `After successful settlement you will have access for ${durationText}.\n\n` +
      '• Any extra ICP left in your wallet stays available for future payments.\n' +
      '• If you have more ICP than you want to lock right now, withdraw it first.\n\n' +
      'Ready to continue with payment?';

    if (!confirm(confirmMessage)) return;

    makePaymentBtn.disabled = true;
    makePaymentBtn.textContent = 'Processing payment…';

    try {
      const result = await authedActor.payFromBalance(paywallId);
      if ('Ok' in result) {
        localStorage.setItem(getRecentPaymentKey(paywallId), Date.now().toString());
        const principal = identity.getPrincipal();
        let confirmedAccess = await tryHasMyAccess(authedActor, principal, paywallId);
        if (!confirmedAccess) {
          confirmedAccess = await pollHasAccess(authedActor, principal, paywallId, 60, 800);
        }
        if (confirmedAccess) {
          const expiryOpt = await tryGetMyExpiry(authedActor, principal, paywallId);
          const expiryNs = expiryOpt?.[0];
          if (expiryNs) writeLocalExpiry(paywallId, expiryNs);
          reportPaymentSuccess(paywallId, principal.toText());
          alert('✅ Payment confirmed! Access granted.');
          revealContent(overlay);
          if (onAccessGranted) await onAccessGranted();
          return;
        }
        alert('Payment succeeded but access is still syncing. Refresh the page.');
      } else {
        const msg = formatInsufficientBalanceMessage(result.Err || 'Unknown error');
        alert(`Payment/settlement issue: ${msg}\n\nYour funds are SAFE in escrow!\n\nClick “Refund escrow” below (it now works reliably).`);
        refreshButton.click();
      }
    } catch (error) {
      alert(`Payment error: ${formatErrorMessage(error, 'Unknown error')}`);
    } finally {
      makePaymentBtn.disabled = false;
      makePaymentBtn.textContent = 'I have deposited – Unlock now';
      updateActionArea();
    }
  });

  const refreshButton = document.createElement('button');
  refreshButton.type = 'button';
  refreshButton.textContent = 'Refresh balances';
  refreshButton.style.cssText =
    'background:#3b82f6;color:#fff;border:none;border-radius:10px;padding:10px 16px;font-size:14px;cursor:pointer;margin:16px 0 12px;min-height:44px;width:100%;';
  details.appendChild(refreshButton);

  const actionArea = document.createElement('div');
  actionArea.id = 'paywall-action-area';
  actionArea.style.cssText =
    'display:flex;flex-wrap:wrap;gap:10px;margin:4px 0 6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.08);';
  details.appendChild(actionArea);

  const insufficientMessage = document.createElement('div');
  insufficientMessage.id = 'insufficient-message';
  insufficientMessage.style.cssText =
    'margin:12px 0;padding:12px;background:rgba(239,68,68,0.1);border:1px solid #ef4444;border-radius:10px;color:#ef4444;font-size:14px;display:none;';
  details.appendChild(insufficientMessage);

  const advancedActions = document.createElement('div');
  advancedActions.style.cssText =
    'display:none;gap:12px;margin-top:12px;border-top:1px dashed rgba(255,255,255,0.2);padding-top:12px;';
  details.appendChild(advancedActions);

  const updateActionArea = () => {
    actionArea.innerHTML = '';
    insufficientMessage.style.display = 'none';

    const hasWalletBalance = walletInfo.balanceE8s > 0n;
    const hasRequiredBalance = walletInfo.balanceE8s >= requiredBalanceE8s;

    if (hasRequiredBalance) {
      actionArea.appendChild(makePaymentBtn);
    }

    if (!hasRequiredBalance) {
      const shortfall = requiredBalanceE8s - walletInfo.balanceE8s;
      insufficientMessage.innerHTML = `
        Deposit at least <strong>${formatIcp(requiredBalanceE8s)} ICP</strong> to your wallet.<br>
        Current balance: ${formatIcp(walletInfo.balanceE8s)} ICP<br>
        <span style="color:#ef4444">Shortfall: ${formatIcp(shortfall)} ICP</span>
      `;
      insufficientMessage.style.display = 'block';
    }

    advancedActions.style.display = hasWalletBalance ? 'grid' : 'none';
  };

  updateActionArea();

  refreshButton.addEventListener('click', async () => {
    refreshButton.disabled = true;
    refreshButton.textContent = 'Refreshing...';
    try {
      const refreshedWallet = await ledger.accountBalance({
        accountIdentifier: walletInfo.accountIdentifier,
        certified: false,
      });
      walletInfo.balanceE8s = refreshedWallet;
      walletBlock.bal.textContent = `Balance: ${(Number(walletInfo.balanceE8s) / 100_000_000).toFixed(8)} ICP`;
      const refreshedEscrow = await authedActor.getEscrowBalance(paywallId, identity.getPrincipal());
      updateEscrowUi(refreshedEscrow);

      updateActionArea();
    } catch (error) {
      console.error('Refresh balance error:', error);
      alert('Failed to refresh balances. Please try again.');
    } finally {
      refreshButton.disabled = false;
      refreshButton.textContent = 'Refresh balances';
    }
  });

  const withdrawButton = document.createElement('button');
  withdrawButton.textContent = 'Withdraw from wallet balance';
  withdrawButton.style.cssText =
    'background:#0ea5e9;color:#fff;border:none;border-radius:10px;padding:10px 16px;font-size:14px;cursor:pointer;min-height:44px;';
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
    if (!confirm(confirmMessage)) return;

    withdrawButton.disabled = true;
    withdrawButton.textContent = 'Withdrawing...';
    try {
      const result = await authedActor.withdrawFromWallet(amountE8s, to);
      if ('Ok' in result) {
        alert(`Withdraw successful! Block index: ${result.Ok}`);
      } else {
        alert(`Withdraw failed: ${result.Err}`);
      }
    } catch (error) {
      alert(`Withdrawal error: ${formatErrorMessage(error, 'Unknown error')}`);
      console.error('Withdrawal error:', error);
    } finally {
      withdrawButton.disabled = false;
      withdrawButton.textContent = 'Withdraw from wallet balance';
    }
  });
  advancedActions.appendChild(withdrawButton);

  const retrySettleButton = document.createElement('button');
  retrySettleButton.textContent = 'Retry payment settlement';
  retrySettleButton.style.cssText =
    'background:#f59e0b;color:#111827;border:none;border-radius:10px;padding:10px 16px;font-size:14px;cursor:pointer;margin-top:12px;min-height:44px;';
  retrySettleButton.addEventListener('click', async () => {
    retrySettleButton.disabled = true;
    retrySettleButton.textContent = 'Retrying...';
    try {
      const result = await authedActor.settleEscrow(paywallId);
      if ('Ok' in result) {
        localStorage.setItem(getRecentPaymentKey(paywallId), Date.now().toString());
        const principal = identity.getPrincipal();
        let confirmedAccess = await tryHasMyAccess(authedActor, principal, paywallId);
        if (!confirmedAccess) {
          confirmedAccess = await pollHasAccess(
            authedActor,
            principal,
            paywallId,
            60,
            800,
          );
        }
        if (confirmedAccess) {
          const expiryOpt = await tryGetMyExpiry(authedActor, principal, paywallId);
          const expiryNs = expiryOpt?.[0];
          if (expiryNs) writeLocalExpiry(paywallId, expiryNs);
          reportPaymentSuccess(paywallId, principal.toText());
          alert('✅ Payment confirmed! Access granted. The page will refresh automatically if needed.');
          revealContent(overlay);
          if (onAccessGranted) await onAccessGranted();
          return;
        }
        alert('Settlement succeeded, but access is still propagating. Please wait and refresh.');
      } else {
        alert(`Payment/settlement issue: ${result.Err}\n\nYour funds are SAFE in escrow!\n\nClick “Refund escrow” below (it now works reliably).`);
        refreshButton.click();
      }
    } catch (error) {
      alert(`Settlement error: ${formatErrorMessage(error, 'Unknown error')}`);
    } finally {
      retrySettleButton.disabled = false;
      retrySettleButton.textContent = 'Retry payment settlement';
    }
  });
  advancedActions.appendChild(retrySettleButton);
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
  window.forceClearPaywall?.();
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

    // NEW: Support forced re-initialization from the main app (for SPA room re-entry)
    const url = new URL(scriptTag.src);
    const forceReinit = url.searchParams.get('forceReinit') === 'true';
    const forceReinitInstanceKey = `__ic_paywall__${backendId}__${paywallId}`;
    if (forceReinit) {
      delete window.__ic_paywall_instances?.[forceReinitInstanceKey];
      console.log('[IC Paywall] forceReinit=true — singleton guard bypassed for room re-entry');
    }

    initSessionTracker();
    const ledgerId =
      scriptTag.dataset.ledgerId ||
      window.PAYWALL_LEDGER_ID ||
      DEFAULT_LEDGER_ID;

    if (!backendId) return;

    const instanceKey = `__ic_paywall__${backendId}__${paywallId}`;
    window.__ic_paywall_instances = window.__ic_paywall_instances || {};
    if (window.__ic_paywall_instances[instanceKey]) {
      console.warn('IC Paywall already initialized for this paywall on this page. Skipping.');
      return;
    }
    window.__ic_paywall_instances[instanceKey] = true;

    const expectedScriptHash = getExpectedScriptHash(scriptTag);
    const icHost = scriptTag.dataset.icHost || window.PAYWALL_IC_HOST || DEFAULT_IC_HOST;
    const agent = new HttpAgent({ host: icHost });
    const actor = Actor.createActor(idlFactory, {
      agent,
      canisterId: backendId,
    });

    const configResponse = await actor.getPaywallConfig(paywallId);
    const config = configResponse?.[0];
    if (!config || typeof config.price_e8s === 'undefined') return;

    const priceE8s = BigInt(config.price_e8s);
    const destinationCount = config.destinations?.length ?? 0;
    const ledgerFeeCount = BigInt(destinationCount + 2);
    const totalRequiredE8s = priceE8s + LEDGER_FEE_E8S * ledgerFeeCount;
    const formattedPrice = formatIcp(totalRequiredE8s);
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
        const principal = identity.getPrincipal();
        const expiryResponse = await tryGetMyExpiry(
          authedActor,
          principal,
          paywallId,
        );
        const expiryNs = expiryResponse?.[0] || readLocalExpiry(paywallId);
        if (expiryNs) writeLocalExpiry(paywallId, expiryNs);
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

      let failureStreak = 0;
      accessIntervalId = setInterval(async () => {
        try {
          const principal = identity.getPrincipal();
          const stillHasAccessQuery = await authedActor.hasAccess(principal, paywallId);
          if (stillHasAccessQuery) {
            failureStreak = 0;
            return;
          }

          const stillHasAccessFresh = await tryHasMyAccess(authedActor, principal, paywallId);
          if (stillHasAccessFresh) {
            const expiryResponse = await tryGetMyExpiry(authedActor, principal, paywallId);
            const expiryNs = expiryResponse?.[0];
            if (expiryNs) writeLocalExpiry(paywallId, expiryNs);
            failureStreak = 0;
            return;
          }

          failureStreak += 1;
          if (failureStreak >= 2) {
            clearAccessTimers();
            await showPaywall(authedActor, identity);
          }
        } catch (error) {
          console.error('Periodic access check failed:', error);
          failureStreak += 1;
          if (failureStreak >= 3) {
            clearAccessTimers();
            await showPaywall(authedActor, identity);
          }
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
      console.log('Login button clicked - starting fresh auth flow');
      const loading = overlay.querySelector('#paywall-loading');
      const errorMessage = overlay.querySelector('#paywall-error');
      loading.style.display = 'block';
      errorMessage.style.display = 'none';

      try {
        console.log('Creating AuthClient for paywall login');
        const authClient = await createAuthClient();
        console.log('AuthClient created, starting Internet Identity login');
        await loginWithFallback(authClient);

        const identity = authClient.getIdentity();
        agent.replaceIdentity(identity);

        const authedActor = Actor.createActor(idlFactory, {
          agent,
          canisterId: backendId,
        });

        const hasAccess = await checkAccessWithGrace(
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
        console.error('=== PAYWALL LOGIN ERROR (full details) ===');
        console.error('Name:', error?.name);
        console.error('Message:', error?.message);
        console.error('Stack:', error?.stack);

        let userMsg = 'An error occurred. Please try again.';
        if (error?.message?.includes('Failed to fetch') || error?.message?.includes('network')) {
          userMsg = 'Network issue – check your connection and try again.';
        } else if (error?.message?.includes('principal') || error?.message?.includes('identity')) {
          userMsg = 'Authentication failed. Refresh the page and try logging in again.';
        } else if (error?.message) {
          userMsg = `Error: ${error.message.substring(0, 120)}`;
        }

        errorMessage.textContent = userMsg;
        errorMessage.style.display = 'block';
      } finally {
        loading.style.display = 'none';
      }
    }, formattedPrice);

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

    const existingAuthClient = await createAuthClient();
    const isAuthed = await existingAuthClient.isAuthenticated();
    if (isAuthed) {
      const identity = existingAuthClient.getIdentity();
      agent.replaceIdentity(identity);
      const authedActor = Actor.createActor(idlFactory, {
        agent,
        canisterId: backendId,
      });
      const hasAccess = await checkAccessWithGrace(
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
        const authClient = await createAuthClient();
        const isAuthed = await authClient.isAuthenticated();
        if (!isAuthed) {
          if (onFailure) onFailure();
          return false;
        }
        const identity = authClient.getIdentity();
        const handshakeAgent = new HttpAgent({ host: icHost });
        handshakeAgent.replaceIdentity(identity);
        const authedActor = Actor.createActor(idlFactory, {
          agent: handshakeAgent,
          canisterId: backendId,
        });
        let hasAccess = await tryHasMyAccess(
          authedActor,
          identity.getPrincipal(),
          paywallId,
        );
        if (!hasAccess) {
          const key = getRecentPaymentKey(paywallId);
          const timestampStr = localStorage.getItem(key);
          if (timestampStr) {
            const timestamp = Number.parseInt(timestampStr, 10);
            if (!Number.isNaN(timestamp) && Date.now() - timestamp < GRACE_PERIOD_MS) {
              hasAccess = await pollHasAccess(
                authedActor,
                identity.getPrincipal(),
                paywallId,
                60,
                800,
              );
            } else {
              localStorage.removeItem(key);
            }
          }
        }
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
    const scriptTag = document.querySelector('script[data-paywall]');
    const scriptSrc = scriptTag?.src || '';
    const paywallUrl = scriptSrc ? new URL(scriptSrc) : null;
    const paywallId = paywallUrl?.searchParams.get('paywallId');
    const backendId = scriptTag?.dataset?.backendId || window.PAYWALL_BACKEND_ID || '';
    const instanceKey = paywallId && backendId ? `__ic_paywall__${backendId}__${paywallId}` : null;
    if (instanceKey && window.__ic_paywall_instances) {
      delete window.__ic_paywall_instances[instanceKey];
    }
    paywallActive = false;
    activeOverlay = null;
    tamperContext = null;
    stopOverlayObservers();
    stopTamperChecks();
    restoreContent();
  }
};

run();

// ==================== BULLETPROOF GLOBAL CLEANUP (NEW) ====================
window.forceClearPaywall = () => {
  try {
    document.getElementById('ic-paywall-overlay')?.remove();
    document
      .querySelectorAll(
        'div[style*="position:fixed"][style*="inset:0"][style*="z-index:999999999"]',
      )
      .forEach((el) => el.remove());

    const body = document.body;
    if (body) {
      body.style.overflow = '';
      body.style.filter = '';
      body.style.transition = '';
      body.style.pointerEvents = '';
      body.style.userSelect = '';
    }

    paywallActive = false;
    activeOverlay = null;
    storedBodyStyles = null;
    tamperDetected = false;
    tamperReason = null;

    if (overlayObserver) {
      overlayObserver.disconnect();
      overlayObserver = null;
    }
    if (tamperIntervalId) {
      clearInterval(tamperIntervalId);
      tamperIntervalId = null;
    }

    if (overlayObserver) {
      overlayObserver.disconnect();
      overlayObserver = null;
    }
    if (tamperIntervalId) {
      clearInterval(tamperIntervalId);
      tamperIntervalId = null;
    }

    console.log('[IC Paywall] ✅ forceClearPaywall completed successfully');
  } catch (e) {
    console.warn('[IC Paywall] forceClearPaywall error (harmless):', e);
  }
};

// Update the existing tryClearEmbedOverlay to use the new robust function
const originalTryClear = window.tryClearEmbedOverlay;
window.tryClearEmbedOverlay = () => {
  if (window.location.pathname.includes('/room/')) {
    console.warn('[IC Paywall] Cleanup blocked on room page');
    return false;
  }
  window.forceClearPaywall?.();
  return true;
};

// NEW: Public API for the main CineRooms app to force a fresh paywall instance on every room entry
window.reinitializePaywall = (backendId, paywallId) => {
  if (!backendId || !paywallId) return;
  const key = `__ic_paywall__${backendId}__${paywallId}`;
  delete window.__ic_paywall_instances?.[key];
  window.forceClearPaywall?.();
  console.log(`[IC Paywall] reinitializePaywall called for paywall ${paywallId}`);
};

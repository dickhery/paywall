import { Actor, HttpAgent } from '@dfinity/agent';
import { AuthClient } from '@dfinity/auth-client';
import { IDL } from '@dfinity/candid';
import { Buffer } from 'buffer';
import { LedgerCanister, principalToAccountIdentifier } from '@dfinity/ledger-icp';
import { Principal } from '@dfinity/principal';

const II_URL_PRIMARY = 'https://id.ai/#authorize';
const II_URL_FALLBACK = 'https://identity.internetcomputer.org/#authorize';
const DEFAULT_LEDGER_ID = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const DEFAULT_IC_HOST = 'https://icp-api.io';
const LEDGER_FEE_E8S = 10000n;
const WATERMARK_ID = 'wm-paywall-script-v1-def456-unique';
const TRACKING_URL = 'https://r5s6s-waaaa-aaaab-ac3za-cai.icp0.io/track';
const PERIODIC_CHECK_INTERVAL_MS = 30000;
const TAMPER_CHECK_INTERVAL_MS = 5000;
const DEVTOOLS_THRESHOLD_PX = 160;
const OVERLAY_STYLE =
  'position:fixed;inset:0;background:rgba(6,9,20,0.88);color:#fff;z-index:999999999;display:flex;align-items:center;justify-content:center;padding:24px;pointer-events:all;';
const getRecentPaymentKey = (paywallId) => `paywall_recent_${paywallId}`;
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

const loginWithFallback = async (authClient) => {
  try {
    await new Promise((resolve, reject) => {
      authClient.login({
        identityProvider: II_URL_PRIMARY,
        maxTimeToLive: BigInt(8 * 60 * 60 * 1_000_000_000),
        onSuccess: resolve,
        onError: reject,
      });
    });
    return;
  } catch (_error) {
    await new Promise((resolve, reject) => {
      authClient.login({
        identityProvider: II_URL_FALLBACK,
        maxTimeToLive: BigInt(8 * 60 * 60 * 1_000_000_000),
        onSuccess: resolve,
        onError: reject,
      });
    });
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

const checkAccessWithGrace = async (authedActor, principal, paywallId) => {
  let hasAccess = await authedActor.hasAccess(principal, paywallId);
  if (hasAccess) return true;

  const key = getRecentPaymentKey(paywallId);
  const timestampStr = localStorage.getItem(key);
  if (timestampStr) {
    const timestamp = Number.parseInt(timestampStr, 10);
    if (!Number.isNaN(timestamp) && Date.now() - timestamp < 60000) {
      hasAccess = await pollHasAccess(authedActor, principal, paywallId, 20, 500);
      if (hasAccess) return true;
    } else {
      localStorage.removeItem(key);
    }
  }
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
    settleEscrow: IDL.Func([IDL.Text], [PaymentResult], []),
    refundEscrow: IDL.Func([IDL.Text], [PaymentResult], []),
    withdrawFromWallet: IDL.Func([IDL.Nat, WithdrawTo], [TransferResult], []),
    getAccessExpiry: IDL.Func([IDL.Principal, IDL.Text], [IDL.Opt(IDL.Int)], ['query']),
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

    const balanceEl = document.createElement('p');
    balanceEl.style.cssText = 'margin:0 0 10px;color:#d1d5db;';
    balanceEl.textContent = `Balance: ${(Number(balanceE8s) / 100_000_000).toFixed(8)} ICP`;
    wrapper.appendChild(balanceEl);

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

    row.append(span, copyButton);
    wrapper.appendChild(row);

    return { wrapper, balanceEl };
  };

  const headline = document.createElement('p');
  headline.style.cssText = 'margin:0 0 10px;font-size:18px;font-weight:700;';
  headline.textContent = `Payment required: ${requiredBalanceIcp.toFixed(8)} ICP total`;
  details.appendChild(headline);

  const breakdown = document.createElement('p');
  breakdown.style.cssText = 'margin:0 0 12px;color:#d1d5db;';
  breakdown.textContent =
    `Includes price (${priceIcp.toFixed(8)} ICP) + estimated network fees ` +
    `(${estimatedFeesIcp.toFixed(8)} ICP).`;
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
    <strong>Two ways to pay:</strong><br>
    • Deposit to your <strong>wallet address</strong> (Option A), then click <strong>Pay from balance</strong>.<br>
    • Deposit to the <strong>paywall address</strong> (Option B), then click <strong>Verify payment</strong>.<br><br>
    <strong>Buttons explained:</strong><br>
    • <strong>I have deposited – Unlock now</strong>: Tries both payment methods automatically.<br>
    • <strong>Pay from balance</strong>: Attempts payment from your wallet balance.<br>
    • <strong>Verify payment</strong>: Verifies manual deposit to the paywall address.<br>
    • <strong>Refresh balances</strong>: Updates wallet/paywall balances after deposit.<br>
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

  details.append(guideBtn, guideContent);

  const walletAccount = await authedActor.getUserAccount();
  const walletInfo = await getAccountInfo(walletAccount, 'wallet');

  const paymentAccountOpt = await authedActor.getPaymentAccount(paywallId);
  const paymentAccount = paymentAccountOpt?.[0] || null;
  const paymentInfo = paymentAccount
    ? await getAccountInfo(paymentAccount, 'paywall payment')
    : null;

  const walletBlock = renderAccountBlock(
    'Option A: Deposit to your IC Paywall wallet (supports Withdraw)',
    walletInfo.accountIdentifier,
    walletInfo.balanceE8s,
  );
  details.appendChild(walletBlock.wrapper);

  let paymentBlock = null;
  if (paymentInfo) {
    paymentBlock = renderAccountBlock(
      'Option B: Deposit to this Paywall Payment Address (then click Verify)',
      paymentInfo.accountIdentifier,
      paymentInfo.balanceE8s,
    );
    details.appendChild(paymentBlock.wrapper);
  }

  const refreshButton = document.createElement('button');
  refreshButton.type = 'button';
  refreshButton.textContent = 'Refresh balances';
  refreshButton.style.cssText =
    'background:#3b82f6;color:#fff;border:none;border-radius:10px;padding:10px 16px;font-size:14px;cursor:pointer;margin:16px 0 12px;min-height:44px;width:100%;';
  details.appendChild(refreshButton);

  const insufficientMessage = document.createElement('div');
  insufficientMessage.style.cssText =
    'margin:12px 0;padding:12px;background:rgba(239,68,68,0.1);border:1px solid #ef4444;border-radius:10px;color:#ef4444;font-size:14px;display:none;';
  details.appendChild(insufficientMessage);

  const actionArea = document.createElement('div');
  details.appendChild(actionArea);

  const helper = document.createElement('p');
  helper.style.cssText = 'margin:12px 0 12px;color:#9ca3af;font-size:13px;text-align:center;display:none;';
  helper.textContent =
    'Deposit to either address above, then click the green button. Both wallet and paywall payment address deposits are supported.';
  details.appendChild(helper);

  const makePaymentBtn = document.createElement('button');
  makePaymentBtn.type = 'button';
  makePaymentBtn.style.cssText =
    'background:#16a34a;color:#fff;border:none;border-radius:12px;padding:14px 20px;font-size:16px;font-weight:600;cursor:pointer;width:100%;margin:16px 0 8px;min-height:52px;';
  makePaymentBtn.textContent = 'I have deposited – Unlock now';

  const payFromBalanceButton = document.createElement('button');
  payFromBalanceButton.type = 'button';
  payFromBalanceButton.textContent = 'Pay from balance';
  payFromBalanceButton.style.cssText =
    'background:#065f46;color:#fff;border:none;border-radius:10px;padding:10px 16px;font-size:13px;min-height:40px;';

  const verifyPaymentButton = document.createElement('button');
  verifyPaymentButton.type = 'button';
  verifyPaymentButton.textContent = 'Verify payment';
  verifyPaymentButton.style.cssText =
    'background:#4338ca;color:#fff;border:none;border-radius:10px;padding:10px 16px;font-size:13px;min-height:40px;';

  const advancedArea = document.createElement('div');
  advancedArea.style.cssText = 'display:none;margin-top:12px;';
  details.appendChild(advancedArea);

  const withdrawButton = document.createElement('button');
  withdrawButton.type = 'button';
  withdrawButton.textContent = 'Withdraw from wallet balance';
  withdrawButton.style.cssText =
    'background:#0ea5e9;color:#fff;border:none;border-radius:10px;padding:10px 16px;font-size:14px;cursor:pointer;min-height:44px;width:100%;';

  const retrySettleButton = document.createElement('button');
  retrySettleButton.type = 'button';
  retrySettleButton.textContent = 'Retry payment settlement';
  retrySettleButton.style.cssText =
    'background:#f59e0b;color:#111827;border:none;border-radius:10px;padding:10px 16px;font-size:14px;cursor:pointer;margin-top:12px;min-height:44px;width:100%;';

  const refundEscrowButton = document.createElement('button');
  refundEscrowButton.type = 'button';
  refundEscrowButton.textContent = 'Refund escrow';
  refundEscrowButton.style.cssText =
    'background:#ef4444;color:#fff;border:none;border-radius:10px;padding:10px 16px;font-size:14px;cursor:pointer;margin-top:12px;min-height:44px;width:100%;';

  advancedArea.append(withdrawButton, retrySettleButton, refundEscrowButton);

  const updateActionArea = () => {
    actionArea.innerHTML = '';
    insufficientMessage.style.display = 'none';

    const walletSufficient = walletInfo.balanceE8s >= requiredBalanceE8s;
    const paywallSufficient = Boolean(
      paymentInfo && paymentInfo.balanceE8s >= requiredBalanceE8s,
    );

    if (walletSufficient || paywallSufficient) {
      helper.style.display = 'block';
      advancedArea.style.display = 'block';

      const row = document.createElement('div');
      row.style.cssText =
        'display:flex;flex-wrap:wrap;gap:10px;margin:4px 0 6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.08);';

      if (walletSufficient) {
        payFromBalanceButton.textContent = 'Pay from balance';
        row.appendChild(payFromBalanceButton);
      }

      if (paywallSufficient) {
        verifyPaymentButton.textContent = 'Verify payment';
        row.appendChild(verifyPaymentButton);
      }

      actionArea.appendChild(makePaymentBtn);
      actionArea.appendChild(row);
    } else {
      helper.style.display = 'none';
      advancedArea.style.display = 'none';

      let message = 'Deposit more ICP to continue.<br>';
      const walletShortfall = calculateShortfall(walletInfo.balanceE8s, requiredBalanceE8s);
      if (walletShortfall > 0n) {
        message += `• Wallet needs ${formatIcp(walletShortfall)} ICP more<br>`;
      }
      if (paymentInfo) {
        const paywallShortfall = calculateShortfall(
          paymentInfo.balanceE8s,
          requiredBalanceE8s,
        );
        if (paywallShortfall > 0n) {
          message += `• Paywall address needs ${formatIcp(paywallShortfall)} ICP more`;
        }
      }
      insufficientMessage.innerHTML = message;
      insufficientMessage.style.display = 'block';
    }
  };

  makePaymentBtn.addEventListener('click', async () => {
    makePaymentBtn.disabled = true;
    makePaymentBtn.textContent = 'Processing payment…';

    try {
      let result = await authedActor.payFromBalance(paywallId);
      if ('Err' in result && result.Err?.includes('Insufficient')) {
        result = await authedActor.verifyPayment(paywallId);
      }

      if ('Ok' in result) {
        const confirmedAccess = await pollHasAccess(
          authedActor,
          identity.getPrincipal(),
          paywallId,
        );
        if (confirmedAccess) {
          localStorage.setItem(getRecentPaymentKey(paywallId), Date.now().toString());
          revealContent(overlay);
          if (onAccessGranted) await onAccessGranted();
          return;
        }
        alert('Payment succeeded but access is still syncing. Refresh the page in 5 seconds.');
      } else {
        const msg = formatInsufficientBalanceMessage(result.Err || 'Unknown error');
        alert(`Payment failed: ${msg}`);
      }
    } catch (error) {
      let msg = formatErrorMessage(error, 'Unknown error');
      msg = formatInsufficientBalanceMessage(msg);
      alert(`${msg}\n\nClick “Refresh balances” and try again.`);
    } finally {
      makePaymentBtn.disabled = false;
      makePaymentBtn.textContent = 'I have deposited – Unlock now';
    }
  });

  payFromBalanceButton.addEventListener('click', async () => {
    payFromBalanceButton.disabled = true;
    payFromBalanceButton.textContent = 'Processing...';

    try {
      const result = await authedActor.payFromBalance(paywallId);
      if ('Ok' in result) {
        const confirmedAccess = await pollHasAccess(
          authedActor,
          identity.getPrincipal(),
          paywallId,
        );
        if (confirmedAccess) {
          localStorage.setItem(getRecentPaymentKey(paywallId), Date.now().toString());
          revealContent(overlay);
          if (onAccessGranted) await onAccessGranted();
          return;
        }
        alert('Payment succeeded, but access is still propagating. Wait a moment and refresh.');
      } else {
        const msg = formatInsufficientBalanceMessage(result.Err || 'Unknown error');
        alert(`Payment failed: ${msg}. Click Refresh balances and try again.`);
      }
    } catch (error) {
      let msg = formatErrorMessage(error, 'Unknown error');
      msg = formatInsufficientBalanceMessage(msg);
      alert(`${msg}\n\nClick “Refresh balances” and try again.`);
      console.error('payFromBalance error:', error);
    } finally {
      payFromBalanceButton.disabled = false;
      payFromBalanceButton.textContent = 'Pay from balance';
      updateActionArea();
    }
  });

  verifyPaymentButton.addEventListener('click', async () => {
    verifyPaymentButton.disabled = true;
    verifyPaymentButton.textContent = 'Verifying...';

    try {
      const result = await authedActor.verifyPayment(paywallId);
      if ('Ok' in result) {
        const confirmedAccess = await pollHasAccess(
          authedActor,
          identity.getPrincipal(),
          paywallId,
        );
        if (confirmedAccess) {
          localStorage.setItem(getRecentPaymentKey(paywallId), Date.now().toString());
          revealContent(overlay);
          if (onAccessGranted) await onAccessGranted();
          return;
        }
        alert('Verification succeeded, but access is still propagating. Wait a moment and refresh.');
      } else {
        const msg = formatInsufficientBalanceMessage(result.Err || 'Unknown error');
        alert(`Verification failed: ${msg}. Click Refresh balances and try again.`);
      }
    } catch (error) {
      let msg = formatErrorMessage(error, 'Unknown error');
      msg = formatInsufficientBalanceMessage(msg);
      alert(`${msg}\n\nClick “Refresh balances” and try again.`);
      console.error('verifyPayment error:', error);
    } finally {
      verifyPaymentButton.disabled = false;
      verifyPaymentButton.textContent = 'Verify payment';
      updateActionArea();
    }
  });

  refreshButton.addEventListener('click', async () => {
    refreshButton.disabled = true;
    refreshButton.textContent = 'Refreshing...';
    try {
      walletInfo.balanceE8s = await ledger.accountBalance({
        accountIdentifier: walletInfo.accountIdentifier,
        certified: false,
      });
      walletBlock.balanceEl.textContent = `Balance: ${(Number(walletInfo.balanceE8s) / 100_000_000).toFixed(8)} ICP`;

      if (paymentInfo && paymentBlock) {
        paymentInfo.balanceE8s = await ledger.accountBalance({
          accountIdentifier: paymentInfo.accountIdentifier,
          certified: false,
        });
        paymentBlock.balanceEl.textContent = `Balance: ${(Number(paymentInfo.balanceE8s) / 100_000_000).toFixed(8)} ICP`;
      }

      updateActionArea();
    } catch (error) {
      console.error('Refresh balance error:', error);
      alert('Failed to refresh balances. Please try again.');
    } finally {
      refreshButton.disabled = false;
      refreshButton.textContent = 'Refresh balances';
    }
  });

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

  retrySettleButton.addEventListener('click', async () => {
    retrySettleButton.disabled = true;
    retrySettleButton.textContent = 'Retrying...';
    try {
      const result = await authedActor.settleEscrow(paywallId);
      if ('Ok' in result) {
        const confirmedAccess = await pollHasAccess(
          authedActor,
          identity.getPrincipal(),
          paywallId,
        );
        if (confirmedAccess) {
          localStorage.setItem(getRecentPaymentKey(paywallId), Date.now().toString());
          revealContent(overlay);
          if (onAccessGranted) await onAccessGranted();
          return;
        }
        alert('Settlement succeeded, but access is still propagating. Please wait and refresh.');
      } else {
        alert(`Settlement failed: ${result.Err}`);
      }
    } catch (error) {
      alert(`Settlement error: ${formatErrorMessage(error, 'Unknown error')}`);
    } finally {
      retrySettleButton.disabled = false;
      retrySettleButton.textContent = 'Retry payment settlement';
    }
  });

  refundEscrowButton.addEventListener('click', async () => {
    if (!confirm('Refund escrow back to your paywall wallet balance?')) return;
    refundEscrowButton.disabled = true;
    refundEscrowButton.textContent = 'Refunding...';
    try {
      const result = await authedActor.refundEscrow(paywallId);
      if ('Ok' in result) {
        alert('Refund submitted. Click “Refresh balances”.');
      } else {
        alert(`Refund failed: ${result.Err}`);
      }
    } catch (error) {
      alert(`Refund error: ${formatErrorMessage(error, 'Unknown error')}`);
    } finally {
      refundEscrowButton.disabled = false;
      refundEscrowButton.textContent = 'Refund escrow';
    }
  });

  updateActionArea();
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
    // Pre-initialize AuthClient at script load (async, but not in click handler)
    const authClient = await AuthClient.create();  // Moved here from click handler

    const scriptTag = document.querySelector('script[data-paywall]');
    if (!scriptTag) return;
    const scriptSrc = scriptTag.src || '';
    const paywallUrl = scriptSrc ? new URL(scriptSrc) : null;
    const paywallId = paywallUrl?.searchParams.get('paywallId');
    if (!paywallId) return;
    initSessionTracker();
    const backendId =
      scriptTag.dataset.backendId || window.PAYWALL_BACKEND_ID || '';
    const ledgerId =
      scriptTag.dataset.ledgerId ||
      window.PAYWALL_LEDGER_ID ||
      DEFAULT_LEDGER_ID;

    if (!backendId) return;

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

      let failureStreak = 0;
      accessIntervalId = setInterval(async () => {
        try {
          const stillHasAccess = await authedActor.hasAccess(
            identity.getPrincipal(),
            paywallId,
          );
          if (stillHasAccess) {
            failureStreak = 0;
            return;
          }

          await delay(1000);
          const confirmAccess = await authedActor.hasAccess(
            identity.getPrincipal(),
            paywallId,
          );
          if (confirmAccess) {
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
      console.log('Login button clicked - starting auth flow');  // Debug log
      const loading = overlay.querySelector('#paywall-loading');
      const errorMessage = overlay.querySelector('#paywall-error');
      loading.style.display = 'block';
      errorMessage.style.display = 'none';
      try {
        // Use pre-initialized authClient; call login() directly (no await before Promise)
        console.log('Opening II login window');  // Debug log
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

    const isAuthed = await authClient.isAuthenticated();
    if (isAuthed) {
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
    }

    showOverlay(overlay);

    window.paywallHandshake = async (onFailure) => {
      if (tamperDetected) {
        if (onFailure) onFailure();
        return false;
      }
      try {
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
        let hasAccess = await authedActor.hasAccess(
          identity.getPrincipal(),
          paywallId,
        );
        if (!hasAccess) {
          const key = getRecentPaymentKey(paywallId);
          const timestampStr = localStorage.getItem(key);
          if (timestampStr) {
            const timestamp = Number.parseInt(timestampStr, 10);
            if (!Number.isNaN(timestamp) && Date.now() - timestamp < 60000) {
              hasAccess = await pollHasAccess(
                authedActor,
                identity.getPrincipal(),
                paywallId,
                20,
                500,
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
    paywallActive = false;
    activeOverlay = null;
    tamperContext = null;
    stopOverlayObservers();
    stopTamperChecks();
    restoreContent();
  }
};

run();

import { Actor, HttpAgent } from '@dfinity/agent';
import { AuthClient } from '@dfinity/auth-client';
import { IDL } from '@dfinity/candid';
import { Buffer } from 'buffer';
import { LedgerCanister, principalToAccountIdentifier } from '@dfinity/ledger-icp';
import { Principal } from '@dfinity/principal';

const II_URL = 'https://identity.ic0.app/#authorize';
const DEFAULT_LEDGER_ID = 'ryjl3-tyaaa-aaaaa-aaaba-cai';

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
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours} hours, ${minutes} minutes, ${seconds} seconds`;
};

const unwrapSubaccount = (subaccount) => {
  if (!Array.isArray(subaccount) || subaccount.length === 0) {
    return undefined;
  }
  const bytes = subaccount[0];
  return bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
};

const idlFactory = ({ IDL }) => {
  const PaywallConfig = IDL.Record({
    price_e8s: IDL.Nat,
    destination: IDL.Principal,
    target_canister: IDL.Principal,
    session_duration_ns: IDL.Nat,
    convertToCycles: IDL.Bool,
  });
  const Account = IDL.Record({
    owner: IDL.Principal,
    subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
  });
  return IDL.Service({
    getPaywallConfig: IDL.Func([IDL.Text], [IDL.Opt(PaywallConfig)], ['query']),
    getPaymentAccount: IDL.Func([IDL.Text], [IDL.Opt(Account)], []),
    getUserAccount: IDL.Func([], [Account], []),
    hasAccess: IDL.Func([IDL.Principal, IDL.Text], [IDL.Bool], ['query']),
    payFromBalance: IDL.Func([IDL.Text], [IDL.Bool], []),
    verifyPayment: IDL.Func([IDL.Text], [IDL.Bool], []),
    withdrawFromWallet: IDL.Func([IDL.Nat, Account], [IDL.Variant({ Ok: IDL.Nat, Err: IDL.Variant({ BadFee: IDL.Record({ expected_fee: IDL.Nat }), BadBurn: IDL.Record({ min_burn_amount: IDL.Nat }), Duplicate: IDL.Record({ duplicate_of: IDL.Nat }), InsufficientFunds: IDL.Record({ balance: IDL.Nat }), CreatedInFuture: IDL.Record({ ledger_time: IDL.Nat64 }), TooOld: IDL.Null, TemporarilyUnavailable: IDL.Null, GenericError: IDL.Record({ message: IDL.Text, error_code: IDL.Nat }) }) })], []),
  });
};

const buildOverlay = (price, onLogin) => {
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;background:rgba(6,9,20,0.88);color:#fff;z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;';
  const panel = document.createElement('div');
  panel.style.cssText =
    'background:#111827;padding:32px;border-radius:16px;max-width:480px;width:100%;text-align:center;box-shadow:0 20px 40px rgba(0,0,0,0.45);';
  panel.id = 'paywall-panel';
  panel.innerHTML = `
    <h2 style="margin:0 0 12px;font-size:24px;">Payment required</h2>
    <p style="margin:0 0 16px;font-size:16px;">Pay ${price} ICP to continue.</p>
    <button id="paywall-login" style="background:#4f46e5;color:#fff;border:none;border-radius:10px;padding:10px 16px;font-size:16px;cursor:pointer;margin-bottom:12px;">Log in to check access</button>
    <div id="paywall-details" style="display:none;margin-top:16px;text-align:left;font-size:14px;"></div>
    <div id="paywall-loading" style="display:none;margin-top:16px;color:#9ca3af;">Loading...</div>
    <div id="paywall-error" style="display:none;margin-top:16px;color:#ef4444;"></div>
  `;
  overlay.appendChild(panel);
  overlay.querySelector('#paywall-login').addEventListener('click', onLogin);
  return overlay;
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

    const agent = new HttpAgent({ host: 'https://icp0.io' });
    const actor = Actor.createActor(idlFactory, {
      agent,
      canisterId: backendId,
    });

    const configResponse = await actor.getPaywallConfig(paywallId);
    const config = configResponse?.[0];
    if (!config || typeof config.price_e8s === 'undefined') return;

    const priceIcp = Number(config.price_e8s) / 100_000_000;
    if (!Number.isFinite(priceIcp)) return;
    const overlay = buildOverlay(priceIcp.toFixed(4), async () => {
      const loading = overlay.querySelector('#paywall-loading');
      const errorMessage = overlay.querySelector('#paywall-error');
      loading.style.display = 'block';
      errorMessage.style.display = 'none';
      try {
        const authClient = await AuthClient.create();
        await new Promise((resolve, reject) => {
          authClient.login({
            identityProvider: II_URL,
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

        const hasAccess = await authedActor.hasAccess(
          identity.getPrincipal(),
          paywallId,
        );
        if (hasAccess) {
          overlay.remove();
          return;
        }

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

        const details = overlay.querySelector('#paywall-details');
        details.style.display = 'block';
        details.innerHTML = '';

        const balanceLine = document.createElement('p');
        balanceLine.style.margin = '0 0 12px';
        balanceLine.textContent = `Your paywall balance: ${userBalanceIcp.toFixed(4)} ICP`;
        details.appendChild(balanceLine);

        if (userBalanceE8s >= config.price_e8s) {
          const payFromBalanceButton = document.createElement('button');
          payFromBalanceButton.textContent = 'Pay from balance';
          payFromBalanceButton.style.cssText =
            'background:#16a34a;color:#fff;border:none;border-radius:10px;padding:10px 16px;font-size:14px;cursor:pointer;margin-bottom:12px;';
          payFromBalanceButton.addEventListener('click', async () => {
            const duration = formatDuration(config.session_duration_ns);
            const confirmMessage = `Are you sure you want to pay ${priceIcp.toFixed(4)} ICP? This will unlock the paywall for ${duration}.`;
            if (!confirm(confirmMessage)) {
              return;
            }

            payFromBalanceButton.disabled = true;
            payFromBalanceButton.textContent = 'Processing...';

            try {
              const verified = await authedActor.payFromBalance(paywallId);
              if (verified) {
                overlay.remove();
                return;
              }
              alert('Payment could not be completed from your balance.');
            } catch (error) {
              console.error('Payment error:', error);
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
          details.appendChild(payFromBalanceButton);
        } else {
          const accountIdentifier = principalToAccountIdentifier(
            userAccount.owner,
            userSubaccount,
          );
          const depositInfo = document.createElement('div');
          depositInfo.style.margin = '0 0 12px';
          const depositLabel = document.createElement('p');
          depositLabel.style.margin = '0 0 8px';
          depositLabel.textContent = 'Deposit ICP to this account:';
          const depositRow = document.createElement('div');
          depositRow.style.cssText =
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
          depositRow.appendChild(accountSpan);
          depositRow.appendChild(copyButton);
          depositInfo.appendChild(depositLabel);
          depositInfo.appendChild(depositRow);
          details.appendChild(depositInfo);

          const note = document.createElement('p');
          note.style.margin = '0 0 12px';
          note.style.fontStyle = 'italic';
          note.textContent =
            'Copy this Account Identifier into your wallet (e.g., NNS dapp) to send ICP. After transfer, refresh or re-login to see updated balance.';
          details.appendChild(note);
        }

        const withdrawButton = document.createElement('button');
        withdrawButton.textContent = 'Withdraw from balance';
        withdrawButton.style.cssText =
          'background:#0ea5e9;color:#fff;border:none;border-radius:10px;padding:10px 16px;font-size:14px;cursor:pointer;';
        withdrawButton.addEventListener('click', async () => {
          const destination = prompt('Enter destination principal:');
          if (!destination) return;

          const subaccountText = prompt(
            'Enter subaccount as hex string (exactly 64 characters, optional, leave blank for default):',
          );
          if (subaccountText === null) return;
          const trimmedText = subaccountText.trim();
          let subaccountBytes = null;
          if (trimmedText !== '') {
            if (
              trimmedText.length !== 64 ||
              !/^[0-9a-fA-F]{64}$/.test(trimmedText)
            ) {
              alert(
                'Invalid subaccount hex: Must be exactly 64 hexadecimal characters (0-9, a-f, A-F).',
              );
              return;
            }
            subaccountBytes = [];
            for (let i = 0; i < 64; i += 2) {
              subaccountBytes.push(
                Number.parseInt(trimmedText.slice(i, i + 2), 16),
              );
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
          const to = {
            owner: Principal.fromText(destination),
            subaccount: subaccountBytes ? [subaccountBytes] : [],
          };

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
              message = `Withdraw failed: ${formatErrorMessage(
                result.Err,
                'Unknown transfer error',
              )}`;
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

        overlay.querySelector('#paywall-login').style.display = 'none';
      } catch (error) {
        console.error('Error during login/access check:', error);
        errorMessage.textContent = 'An error occurred. Please try again.';
        errorMessage.style.display = 'block';
      } finally {
        loading.style.display = 'none';
      }
    });

    document.body.appendChild(overlay);
  } catch (error) {
    console.error('Paywall script error:', error);
  }
};

run();

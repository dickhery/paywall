import { Actor, HttpAgent } from '@dfinity/agent';
import { AuthClient } from '@dfinity/auth-client';
import { LedgerCanister } from '@dfinity/ledger-icp';
import { IDL } from '@dfinity/candid';
import { Principal } from '@dfinity/principal';

const II_URL = 'https://identity.ic0.app/#authorize';
const DEFAULT_LEDGER_ID = 'ryjl3-tyaaa-aaaaa-aaaba-cai';

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

const bytesToHex = (bytes) => {
  if (!bytes) return '';
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

const buildOverlay = (price, onLogin, onPay) => {
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
    <button id="paywall-pay" style="display:none;background:#4f46e5;color:#fff;border:none;border-radius:10px;padding:10px 16px;font-size:16px;cursor:pointer;">Pay now</button>
    <div id="paywall-details" style="display:none;margin-top:16px;text-align:left;font-size:14px;"></div>
  `;
  overlay.appendChild(panel);
  overlay.querySelector('#paywall-login').addEventListener('click', onLogin);
  overlay.querySelector('#paywall-pay').addEventListener('click', onPay);
  return overlay;
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
    const actor = Actor.createActor(idlFactory({ IDL }), {
      agent,
      canisterId: backendId,
    });

    const configResponse = await actor.getPaywallConfig(paywallId);
    const config = configResponse?.[0];
    if (!config || typeof config.price_e8s === 'undefined') return;

    const priceIcp = Number(config.price_e8s) / 100_000_000;
    if (!Number.isFinite(priceIcp)) return;
    const overlay = buildOverlay(priceIcp.toFixed(4), async () => {
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
      const authedActor = Actor.createActor(idlFactory({ IDL }), {
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
        canisterId: ledgerId,
      });
      const userSubaccount = userAccount.subaccount?.[0];
      const userBalanceE8s = await ledger.balanceOf({
        owner: userAccount.owner,
        subaccount: userSubaccount,
      });
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
          const verified = await authedActor.payFromBalance(paywallId);
          if (verified) {
            overlay.remove();
          } else {
            alert('Payment could not be completed from your balance.');
          }
        });
        details.appendChild(payFromBalanceButton);
      } else {
        const depositInfo = document.createElement('p');
        depositInfo.style.margin = '0 0 12px';
        depositInfo.textContent = `Deposit ICP to: owner ${userAccount.owner.toText()} subaccount ${bytesToHex(
          userSubaccount,
        ) || 'none'}.`;
        details.appendChild(depositInfo);
      }

      const withdrawButton = document.createElement('button');
      withdrawButton.textContent = 'Withdraw from balance';
      withdrawButton.style.cssText =
        'background:#0ea5e9;color:#fff;border:none;border-radius:10px;padding:10px 16px;font-size:14px;cursor:pointer;';
      withdrawButton.addEventListener('click', async () => {
        const destination = prompt('Enter destination principal:');
        const amountText = prompt('Enter amount in ICP:');
        if (!destination || !amountText) return;
        const amountIcp = Number.parseFloat(amountText);
        if (Number.isNaN(amountIcp) || amountIcp <= 0) {
          alert('Invalid amount.');
          return;
        }
        const amountE8s = BigInt(Math.round(amountIcp * 100_000_000));
        const to = { owner: Principal.fromText(destination), subaccount: [] };
        const result = await authedActor.withdrawFromWallet(amountE8s, to);
        if ('Err' in result) {
          alert('Withdraw failed.');
        } else {
          alert('Withdraw initiated.');
        }
      });
      details.appendChild(withdrawButton);

      overlay.querySelector('#paywall-login').style.display = 'none';
      overlay.querySelector('#paywall-pay').style.display = 'inline-block';
    }, async () => {
      const authedActor = Actor.createActor(idlFactory({ IDL }), {
        agent,
        canisterId: backendId,
      });

      const paymentAccountResponse = await authedActor.getPaymentAccount(
        paywallId,
      );
      const paymentAccount = paymentAccountResponse?.[0];
      if (!paymentAccount) {
        alert('Payment account not found.');
        return;
      }

      const ledger = LedgerCanister.create({
        agent,
        canisterId: ledgerId,
      });

      const subaccount = paymentAccount.subaccount?.[0];
      await ledger.transfer({
        to: {
          owner: paymentAccount.owner,
          subaccount,
        },
        amount: config.price_e8s,
        fee: 10_000n,
      });

      const verified = await authedActor.verifyPayment(paywallId);
      if (verified) {
        overlay.remove();
      } else {
        alert('Payment not detected yet. Please try again shortly.');
      }
    });

    document.body.appendChild(overlay);
  } catch (error) {
    console.error('Paywall script error:', error);
  }
};

run();

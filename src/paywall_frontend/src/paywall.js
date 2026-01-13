import { Actor, HttpAgent } from '@dfinity/agent';
import { AuthClient } from '@dfinity/auth-client';
import { LedgerCanister } from '@dfinity/ledger-icp';
import { IDL } from '@dfinity/candid';

const II_URL = 'https://identity.ic0.app/#authorize';
const DEFAULT_LEDGER_ID = 'ryjl3-tyaaa-aaaaa-aaaba-cai';

const idlFactory = ({ IDL }) => {
  const PaywallConfig = IDL.Record({
    price_e8s: IDL.Nat,
    destination: IDL.Principal,
    target_canister: IDL.Principal,
    session_duration_ns: IDL.Nat,
  });
  const Account = IDL.Record({
    owner: IDL.Principal,
    subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
  });
  return IDL.Service({
    getPaywallConfig: IDL.Func([IDL.Text], [IDL.Opt(PaywallConfig)], ['query']),
    getPaymentAccount: IDL.Func([IDL.Text], [IDL.Opt(Account)], []),
    hasAccess: IDL.Func([IDL.Principal, IDL.Text], [IDL.Bool], ['query']),
    verifyPayment: IDL.Func([IDL.Text], [IDL.Bool], []),
  });
};

const buildOverlay = (price, onLogin, onPay) => {
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;background:rgba(6,9,20,0.88);color:#fff;z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;';
  const panel = document.createElement('div');
  panel.style.cssText =
    'background:#111827;padding:32px;border-radius:16px;max-width:480px;width:100%;text-align:center;box-shadow:0 20px 40px rgba(0,0,0,0.45);';
  panel.innerHTML = `
    <h2 style="margin:0 0 12px;font-size:24px;">Payment required</h2>
    <p style="margin:0 0 16px;font-size:16px;">Pay ${price} ICP to continue.</p>
    <button id="paywall-login" style="background:#4f46e5;color:#fff;border:none;border-radius:10px;padding:10px 16px;font-size:16px;cursor:pointer;margin-bottom:12px;">Log in to check access</button>
    <button id="paywall-pay" style="display:none;background:#4f46e5;color:#fff;border:none;border-radius:10px;padding:10px 16px;font-size:16px;cursor:pointer;">Pay now</button>
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

    const config = await actor.getPaywallConfig(paywallId);
    if (!config) return;

    const priceIcp = Number(config.price_e8s) / 100_000_000;
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

      overlay.querySelector('#paywall-login').style.display = 'none';
      overlay.querySelector('#paywall-pay').style.display = 'inline-block';
    }, async () => {
      const authedActor = Actor.createActor(idlFactory({ IDL }), {
        agent,
        canisterId: backendId,
      });

      const paymentAccount = await authedActor.getPaymentAccount(paywallId);
      if (!paymentAccount) {
        alert('Payment account not found.');
        return;
      }

      const ledger = LedgerCanister.create({
        agent,
        canisterId: ledgerId,
      });

      const subaccount = paymentAccount.subaccount?.[0] || [];
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

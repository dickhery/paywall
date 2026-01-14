import { useCallback, useMemo, useState } from 'react';
import { AuthClient } from '@dfinity/auth-client';
import { principalToAccountIdentifier } from '@dfinity/ledger-icp';
import { Principal } from '@dfinity/principal';
import { createActor, paywall_backend } from 'declarations/paywall_backend';

const LEDGER_FEE_E8S = 10_000n;
const MAINNET_II_URL = 'https://identity.ic0.app/#authorize';

const toE8s = (icpValue) => {
  const parsed = Number.parseFloat(icpValue || '0');
  if (Number.isNaN(parsed)) {
    return 0n;
  }
  return BigInt(Math.round(parsed * 100_000_000));
};

function App() {
  const [authClient, setAuthClient] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [principalText, setPrincipalText] = useState('');

  const [priceIcp, setPriceIcp] = useState('0.1');
  const [destination, setDestination] = useState('');
  const [targetCanister, setTargetCanister] = useState('');
  const [sessionHours, setSessionHours] = useState('1');
  const [sessionMinutes, setSessionMinutes] = useState('0');
  const [sessionSeconds, setSessionSeconds] = useState('0');
  const [convertToCycles, setConvertToCycles] = useState(false);

  const [paywallId, setPaywallId] = useState('');
  const [paymentAccount, setPaymentAccount] = useState(null);
  const [paymentStatus, setPaymentStatus] = useState('');
  const [lookupId, setLookupId] = useState('');

  const identityProvider = useMemo(() => {
    if (process.env.DFX_NETWORK === 'ic') {
      return MAINNET_II_URL;
    }
    return process.env.DFX_IDENTITY_PROVIDER || MAINNET_II_URL;
  }, []);

  const getActor = useCallback(
    async (client) => {
      const identity = client?.getIdentity();
      if (!identity) return paywall_backend;
      return createActor(process.env.CANISTER_ID_PAYWALL_BACKEND, {
        agentOptions: { identity },
      });
    },
    [],
  );

  const handleLogin = async () => {
    const client = await AuthClient.create();
    await new Promise((resolve, reject) => {
      client.login({
        identityProvider,
        onSuccess: resolve,
        onError: reject,
      });
    });
    const identity = client.getIdentity();
    setAuthClient(client);
    setIsAuthenticated(true);
    setPrincipalText(identity.getPrincipal().toText());
  };

  const handleLogout = async () => {
    if (authClient) {
      await authClient.logout();
    }
    setAuthClient(null);
    setIsAuthenticated(false);
    setPrincipalText('');
  };

  const parseDurationPart = (value) => {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed < 0) {
      return 0;
    }
    return parsed;
  };

  const handleCreatePaywall = async (event) => {
    event.preventDefault();
    setPaymentStatus('');

    const totalSeconds =
      parseDurationPart(sessionHours) * 3600 +
      parseDurationPart(sessionMinutes) * 60 +
      parseDurationPart(sessionSeconds);
    const sessionDurationNs = BigInt(totalSeconds) * 1_000_000_000n;

    const actor = await getActor(authClient);
    const config = {
      price_e8s: toE8s(priceIcp),
      destination: Principal.fromText(destination),
      target_canister: Principal.fromText(targetCanister),
      session_duration_ns: sessionDurationNs,
      convertToCycles,
    };

    const createdId = await actor.createPaywall(config);
    setPaywallId(createdId);
    setLookupId(createdId);
  };

  const handleLookup = async () => {
    setPaymentStatus('');
    if (!lookupId) return;
    const actor = await getActor(authClient);
    const account = await actor.getPaymentAccount(lookupId);
    setPaymentAccount(account || null);
  };

  const handleVerifyPayment = async () => {
    setPaymentStatus('');
    if (!lookupId) return;
    const actor = await getActor(authClient);
    const verified = await actor.verifyPayment(lookupId);
    setPaymentStatus(
      verified
        ? 'Payment verified. Access is active for your session duration.'
        : 'Payment not detected yet. Make sure the ledger transfer has completed.',
    );
  };

  const handleCheckAccess = async () => {
    if (!lookupId || !principalText) return;
    const actor = await getActor(authClient);
    const hasAccess = await actor.hasAccess(
      Principal.fromText(principalText),
      lookupId,
    );
    setPaymentStatus(hasAccess ? 'Access is active.' : 'Access is not active.');
  };

  return (
    <main className="app">
      <header className="hero">
        <h1>IC Paywall Builder</h1>
        <p>
          Configure paywalls, generate embed scripts, and verify access using
          Internet Identity and ICP ledger payments.
        </p>
      </header>

      <section className="card">
        <h2>Authentication</h2>
        {isAuthenticated ? (
          <div className="stack">
            <p>
              Signed in as <span className="mono">{principalText}</span>
            </p>
            <button type="button" onClick={handleLogout}>
              Sign out
            </button>
          </div>
        ) : (
          <button type="button" onClick={handleLogin}>
            Sign in with Internet Identity
          </button>
        )}
      </section>

      {isAuthenticated && (
        <>
          <section className="card">
            <h2>Create a paywall</h2>
            <form className="form" onSubmit={handleCreatePaywall}>
              <label>
                Price (ICP)
                <span className="hint">
                  Amount users will pay when the paywall appears.
                </span>
                <input
                  type="number"
                  step="0.00000001"
                  min="0"
                  value={priceIcp}
                  onChange={(event) => setPriceIcp(event.target.value)}
                  required
                />
              </label>
              <label>
                Destination principal
                <span className="hint">
                  This is your wallet principal where paywall payments are sent.
                </span>
                <input
                  type="text"
                  value={destination}
                  onChange={(event) => setDestination(event.target.value)}
                  placeholder="aaaaa-aa"
                  required
                />
              </label>
              <label>
                Target canister principal
                <span className="hint">
                  Canister to associate with this paywall for future audit or
                  notification hooks.
                </span>
                <input
                  type="text"
                  value={targetCanister}
                  onChange={(event) => setTargetCanister(event.target.value)}
                  placeholder="aaaaa-aa"
                  required
                />
              </label>
              <label>
                Session duration
                <span className="hint">
                  Choose how long users keep access after payment (hours,
                  minutes, and seconds).
                </span>
                <div className="time-inputs">
                  <input
                    type="number"
                    min="0"
                    value={sessionHours}
                    onChange={(event) => setSessionHours(event.target.value)}
                    placeholder="Hours"
                    required
                  />
                  <input
                    type="number"
                    min="0"
                    max="59"
                    value={sessionMinutes}
                    onChange={(event) => setSessionMinutes(event.target.value)}
                    placeholder="Minutes"
                    required
                  />
                  <input
                    type="number"
                    min="0"
                    max="59"
                    value={sessionSeconds}
                    onChange={(event) => setSessionSeconds(event.target.value)}
                    placeholder="Seconds"
                    required
                  />
                </div>
              </label>
              <label>
                Convert payments to cycles before sending?
                <input
                  type="checkbox"
                  checked={convertToCycles}
                  onChange={(event) => setConvertToCycles(event.target.checked)}
                />
              </label>
              <p className="hint">
                Transfers should include the standard ledger fee of{' '}
                {Number(LEDGER_FEE_E8S) / 100_000_000} ICP.
              </p>
              <button type="submit">Create paywall</button>
            </form>

            {paywallId && (
              <div className="result">
                <h3>Paywall created</h3>
                <p>
                  Paywall ID: <span className="mono">{paywallId}</span>
                </p>
                <p>Embed this script in your site:</p>
                <code>
                  {`<script type="module" data-paywall data-backend-id="${process.env.CANISTER_ID_PAYWALL_BACKEND}" src="https://${process.env.CANISTER_ID_PAYWALL_FRONTEND}.icp0.io/paywall.js?paywallId=${paywallId}"></script>`}
                </code>
                <p className="hint">
                  Set <span className="mono">data-backend-id</span> to your
                  paywall backend canister ID when embedding on non-ICP sites.
                </p>
              </div>
            )}
          </section>

          <section className="card">
            <h2>Payment verification</h2>
            <p>
              Use this tool to retrieve the payment subaccount for your
              principal, then verify payment once the ledger transfer is
              complete.
            </p>
            <div className="stack">
              <label>
                Paywall ID
                <input
                  type="text"
                  value={lookupId}
                  onChange={(event) => setLookupId(event.target.value)}
                />
              </label>
              <div className="row">
                <button type="button" onClick={handleLookup}>
                  Get payment account
                </button>
                <button type="button" onClick={handleVerifyPayment}>
                  Verify payment
                </button>
                <button type="button" onClick={handleCheckAccess}>
                  Check access
                </button>
              </div>
            </div>

            {paymentAccount && (
              <div className="result">
                <p>
                  Transfer to account identifier:{' '}
                  <span className="mono">
                    {principalToAccountIdentifier(
                      paymentAccount.owner,
                      paymentAccount.subaccount ?? undefined,
                    )}
                  </span>
                </p>
                <p className="hint">
                  Copy this Account Identifier into your wallet to send ICP.
                  Include the ledger fee (0.0001 ICP). After transfer, click
                  &quot;Verify payment&quot;.
                </p>
              </div>
            )}

            {paymentStatus && <p className="status">{paymentStatus}</p>}
          </section>
        </>
      )}
    </main>
  );
}

export default App;

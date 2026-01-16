import { useCallback, useEffect, useMemo, useState } from 'react';
import { AuthClient } from '@dfinity/auth-client';
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
  const [ownedPaywalls, setOwnedPaywalls] = useState([]);
  const [paywallConfigs, setPaywallConfigs] = useState({});
  const [editingId, setEditingId] = useState(null);
  const [editPriceIcp, setEditPriceIcp] = useState('');
  const [editDestination, setEditDestination] = useState('');
  const [editTargetCanister, setEditTargetCanister] = useState('');
  const [editSessionHours, setEditSessionHours] = useState('');
  const [editSessionMinutes, setEditSessionMinutes] = useState('');
  const [editSessionSeconds, setEditSessionSeconds] = useState('');
  const [editConvertToCycles, setEditConvertToCycles] = useState(false);

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
    await fetchOwnedPaywalls();
  };

  const fetchOwnedPaywalls = useCallback(async () => {
    if (!isAuthenticated || !principalText) return;
    const actor = await getActor(authClient);
    const ids = await actor.getOwnedPaywalls(
      Principal.fromText(principalText),
    );
    setOwnedPaywalls(ids);
    const configs = {};
    for (const id of ids) {
      const config = await actor.getPaywallConfig(id);
      if (config[0]) configs[id] = config[0];
    }
    setPaywallConfigs(configs);
  }, [authClient, getActor, isAuthenticated, principalText]);

  useEffect(() => {
    if (!isAuthenticated || !principalText) return;
    fetchOwnedPaywalls();
  }, [fetchOwnedPaywalls, isAuthenticated, principalText]);

  const startEdit = (id, config) => {
    setEditingId(id);
    setEditPriceIcp((Number(config.price_e8s) / 100_000_000).toString());
    setEditDestination(config.destination.toText());
    setEditTargetCanister(config.target_canister.toText());
    const totalSeconds = Number(config.session_duration_ns) / 1_000_000_000;
    setEditSessionHours(Math.floor(totalSeconds / 3600).toString());
    setEditSessionMinutes(
      Math.floor((totalSeconds % 3600) / 60).toString(),
    );
    setEditSessionSeconds((totalSeconds % 60).toString());
    setEditConvertToCycles(config.convertToCycles);
  };

  const handleUpdatePaywall = async (event, id) => {
    event.preventDefault();
    const totalSeconds =
      parseDurationPart(editSessionHours) * 3600 +
      parseDurationPart(editSessionMinutes) * 60 +
      parseDurationPart(editSessionSeconds);
    const sessionDurationNs = BigInt(totalSeconds) * 1_000_000_000n;
    const actor = await getActor(authClient);
    const updates = {
      price_e8s: [toE8s(editPriceIcp)],
      destination: [Principal.fromText(editDestination)],
      target_canister: [Principal.fromText(editTargetCanister)],
      session_duration_ns: [sessionDurationNs],
      convertToCycles: [editConvertToCycles],
    };
    await actor.updatePaywall(id, updates);
    setEditingId(null);
    await fetchOwnedPaywalls();
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
            <h2>My paywalls</h2>
            {ownedPaywalls.length === 0 ? (
              <p>No paywalls created yet.</p>
            ) : (
              <ul className="list">
                {ownedPaywalls.map((id) => {
                  const config = paywallConfigs[id];
                  if (!config) return null;
                  const price = Number(config.price_e8s) / 100_000_000;
                  const durationSeconds =
                    Number(config.session_duration_ns) / 1_000_000_000;
                  const hours = Math.floor(durationSeconds / 3600);
                  const minutes = Math.floor((durationSeconds % 3600) / 60);
                  const seconds = Math.floor(durationSeconds % 60);
                  return (
                    <li
                      key={id}
                      style={{
                        marginBottom: '16px',
                        borderBottom: '1px solid #1f2937',
                        paddingBottom: '16px',
                      }}
                    >
                      <p>
                        <strong>ID:</strong> {id}
                      </p>
                      <p>
                        <strong>Price:</strong> {price.toFixed(4)} ICP
                      </p>
                      <p>
                        <strong>Destination:</strong>{' '}
                        {config.destination.toText()}
                      </p>
                      <p>
                        <strong>Target Canister:</strong>{' '}
                        {config.target_canister.toText()}
                      </p>
                      <p>
                        <strong>Session Duration:</strong> {hours}h {minutes}m{' '}
                        {seconds}s
                      </p>
                      <p>
                        <strong>Convert to Cycles:</strong>{' '}
                        {config.convertToCycles ? 'Yes' : 'No'}
                      </p>
                      <button type="button" onClick={() => startEdit(id, config)}>
                        Edit
                      </button>
                      {editingId === id && (
                        <form
                          className="form"
                          onSubmit={(event) => handleUpdatePaywall(event, id)}
                        >
                          <label>
                            Edit Price (ICP)
                            <input
                              type="number"
                              step="0.00000001"
                              min="0"
                              value={editPriceIcp}
                              onChange={(event) =>
                                setEditPriceIcp(event.target.value)
                              }
                              required
                            />
                          </label>
                          <label>
                            Edit Destination
                            <input
                              type="text"
                              value={editDestination}
                              onChange={(event) =>
                                setEditDestination(event.target.value)
                              }
                              required
                            />
                          </label>
                          <label>
                            Edit Target Canister
                            <input
                              type="text"
                              value={editTargetCanister}
                              onChange={(event) =>
                                setEditTargetCanister(event.target.value)
                              }
                              required
                            />
                          </label>
                          <label>
                            Edit Session Duration
                            <div className="time-inputs">
                              <input
                                type="number"
                                min="0"
                                value={editSessionHours}
                                onChange={(event) =>
                                  setEditSessionHours(event.target.value)
                                }
                                placeholder="Hours"
                                required
                              />
                              <input
                                type="number"
                                min="0"
                                max="59"
                                value={editSessionMinutes}
                                onChange={(event) =>
                                  setEditSessionMinutes(event.target.value)
                                }
                                placeholder="Minutes"
                                required
                              />
                              <input
                                type="number"
                                min="0"
                                max="59"
                                value={editSessionSeconds}
                                onChange={(event) =>
                                  setEditSessionSeconds(event.target.value)
                                }
                                placeholder="Seconds"
                                required
                              />
                            </div>
                          </label>
                          <label>
                            Edit Convert to Cycles
                            <input
                              type="checkbox"
                              checked={editConvertToCycles}
                              onChange={(event) =>
                                setEditConvertToCycles(event.target.checked)
                              }
                            />
                          </label>
                          <div className="row">
                            <button type="submit">Update paywall</button>
                            <button
                              type="button"
                              onClick={() => setEditingId(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}

export default App;

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AuthClient } from '@dfinity/auth-client';
import { Principal } from '@dfinity/principal';
import { createActor, paywall_backend } from 'declarations/paywall_backend';

const LEDGER_FEE_E8S = 10_000n;
const MAX_DESTINATIONS = 3;
const MAINNET_II_URL = 'https://identity.ic0.app/#authorize';
const FEE_ACCOUNT_IDENTIFIER =
  '2a4abcd2278509654f9a26b885ecb49b8619bffe58a6acb2e3a5e3c7fb96020d';

const toE8s = (icpValue) => {
  const parsed = Number.parseFloat(icpValue || '0');
  if (Number.isNaN(parsed)) {
    return 0n;
  }
  return BigInt(Math.round(parsed * 100_000_000));
};

const toOptionalText = (value) => {
  const trimmed = value.trim();
  return trimmed ? [trimmed] : [];
};

const calculateFeeE8s = (priceE8s) => {
  if (priceE8s <= 0n) return LEDGER_FEE_E8S;
  const onePercent = priceE8s / 100n;
  return onePercent > LEDGER_FEE_E8S ? onePercent : LEDGER_FEE_E8S;
};

const formatIcp = (e8s) => (Number(e8s) / 100_000_000).toFixed(8);

function App() {
  const [authClient, setAuthClient] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [principalText, setPrincipalText] = useState('');

  const [priceIcp, setPriceIcp] = useState('0.1');
  const [targetCanister, setTargetCanister] = useState('');
  const [sessionDays, setSessionDays] = useState('0');
  const [sessionHours, setSessionHours] = useState('1');
  const [sessionMinutes, setSessionMinutes] = useState('0');
  const [sessionSeconds, setSessionSeconds] = useState('0');
  const [loginPromptText, setLoginPromptText] = useState('');
  const [paymentPromptText, setPaymentPromptText] = useState('');
  const [destinations, setDestinations] = useState([
    { principal: '', percentage: 100, convertToCycles: false },
  ]);

  const [paywallId, setPaywallId] = useState('');
  const [ownedPaywalls, setOwnedPaywalls] = useState([]);
  const [paywallConfigs, setPaywallConfigs] = useState({});
  const [editingId, setEditingId] = useState(null);
  const [editPriceIcp, setEditPriceIcp] = useState('');
  const [editTargetCanister, setEditTargetCanister] = useState('');
  const [editSessionDays, setEditSessionDays] = useState('');
  const [editSessionHours, setEditSessionHours] = useState('');
  const [editSessionMinutes, setEditSessionMinutes] = useState('');
  const [editSessionSeconds, setEditSessionSeconds] = useState('');
  const [editDestinations, setEditDestinations] = useState([]);
  const [editLoginPromptText, setEditLoginPromptText] = useState('');
  const [editPaymentPromptText, setEditPaymentPromptText] = useState('');

  const createPriceE8s = useMemo(() => toE8s(priceIcp), [priceIcp]);
  const createFeeE8s = useMemo(
    () => calculateFeeE8s(createPriceE8s),
    [createPriceE8s],
  );
  const createNetE8s = useMemo(() => {
    if (createPriceE8s <= createFeeE8s) return 0n;
    return createPriceE8s - createFeeE8s;
  }, [createFeeE8s, createPriceE8s]);

  const editPriceE8s = useMemo(() => toE8s(editPriceIcp), [editPriceIcp]);
  const editFeeE8s = useMemo(
    () => calculateFeeE8s(editPriceE8s),
    [editPriceE8s],
  );
  const editNetE8s = useMemo(() => {
    if (editPriceE8s <= editFeeE8s) return 0n;
    return editPriceE8s - editFeeE8s;
  }, [editFeeE8s, editPriceE8s]);

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

    if (destinations.length === 0) {
      alert('At least one destination is required.');
      return;
    }
    const totalPercent = destinations.reduce(
      (sum, destination) => sum + destination.percentage,
      0,
    );
    if (totalPercent !== 100) {
      alert('Destination percentages must sum to 100%.');
      return;
    }

    const selectedDestinations = destinations.filter(
      (destination) => destination.percentage > 0,
    );
    if (selectedDestinations.length === 0) {
      alert('At least one destination must have a percentage greater than 0.');
      return;
    }
    if (
      selectedDestinations.some(
        (destination) => !destination.principal.trim(),
      )
    ) {
      alert('Please provide a principal for every destination with a percentage.');
      return;
    }
    try {
      Principal.fromText(targetCanister.trim());
      selectedDestinations.forEach((destination) => {
        Principal.fromText(destination.principal.trim());
      });
    } catch (error) {
      alert('Invalid principal format. Please check the canister and destinations.');
      return;
    }

    const totalSeconds =
      parseDurationPart(sessionDays) * 86400 +
      parseDurationPart(sessionHours) * 3600 +
      parseDurationPart(sessionMinutes) * 60 +
      parseDurationPart(sessionSeconds);
    if (totalSeconds <= 0) {
      alert('Session duration must be greater than 0.');
      return;
    }
    const sessionDurationNs = BigInt(totalSeconds) * 1_000_000_000n;
    const priceE8s = toE8s(priceIcp);
    const feeE8s = calculateFeeE8s(priceE8s);
    if (priceE8s < feeE8s) {
      alert('Price must be at least the paywall fee (max(1% of price, 0.0001 ICP)).');
      return;
    }

    const actor = await getActor(authClient);
    const config = {
      price_e8s: priceE8s,
      target_canister: Principal.fromText(targetCanister.trim()),
      session_duration_ns: sessionDurationNs,
      destinations: selectedDestinations.map((destination) => ({
        destination: Principal.fromText(destination.principal.trim()),
        percentage: BigInt(destination.percentage),
        convertToCycles: destination.convertToCycles,
      })),
      login_prompt_text: toOptionalText(loginPromptText),
      payment_prompt_text: toOptionalText(paymentPromptText),
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
    setEditTargetCanister(config.target_canister.toText());
    const totalSeconds = Number(config.session_duration_ns) / 1_000_000_000;
    setEditSessionDays(Math.floor(totalSeconds / 86400).toString());
    setEditSessionHours(
      Math.floor((totalSeconds % 86400) / 3600).toString(),
    );
    setEditSessionMinutes(
      Math.floor(((totalSeconds % 86400) % 3600) / 60).toString(),
    );
    setEditSessionSeconds(((totalSeconds % 86400) % 60).toString());
    setEditLoginPromptText(config.login_prompt_text?.[0] || '');
    setEditPaymentPromptText(config.payment_prompt_text?.[0] || '');
    const mappedDestinations = config.destinations.map((destination) => ({
      principal: destination.destination.toText(),
      percentage: Number(destination.percentage),
      convertToCycles: destination.convertToCycles,
    }));
    setEditDestinations(
      mappedDestinations.length > 0
        ? mappedDestinations
        : [{ principal: '', percentage: 100, convertToCycles: false }],
    );
  };

  const handleUpdatePaywall = async (event, id) => {
    event.preventDefault();
    if (editDestinations.length === 0) {
      alert('At least one destination is required.');
      return;
    }
    const totalPercent = editDestinations.reduce(
      (sum, destination) => sum + destination.percentage,
      0,
    );
    if (totalPercent !== 100) {
      alert('Destination percentages must sum to 100%.');
      return;
    }
    const selectedDestinations = editDestinations.filter(
      (destination) => destination.percentage > 0,
    );
    if (selectedDestinations.length === 0) {
      alert('At least one destination must have a percentage greater than 0.');
      return;
    }
    if (
      selectedDestinations.some(
        (destination) => !destination.principal.trim(),
      )
    ) {
      alert('Please provide a principal for every destination with a percentage.');
      return;
    }
    try {
      Principal.fromText(editTargetCanister.trim());
      selectedDestinations.forEach((destination) => {
        Principal.fromText(destination.principal.trim());
      });
    } catch (error) {
      alert('Invalid principal format. Please check the canister and destinations.');
      return;
    }
    const totalSeconds =
      parseDurationPart(editSessionDays) * 86400 +
      parseDurationPart(editSessionHours) * 3600 +
      parseDurationPart(editSessionMinutes) * 60 +
      parseDurationPart(editSessionSeconds);
    if (totalSeconds <= 0) {
      alert('Session duration must be greater than 0.');
      return;
    }
    const sessionDurationNs = BigInt(totalSeconds) * 1_000_000_000n;
    const priceE8s = toE8s(editPriceIcp);
    const feeE8s = calculateFeeE8s(priceE8s);
    if (priceE8s < feeE8s) {
      alert('Price must be at least the paywall fee (max(1% of price, 0.0001 ICP)).');
      return;
    }
    const actor = await getActor(authClient);
    const updates = {
      price_e8s: [priceE8s],
      target_canister: [Principal.fromText(editTargetCanister.trim())],
      session_duration_ns: [sessionDurationNs],
      destinations: [
        selectedDestinations.map((destination) => ({
          destination: Principal.fromText(destination.principal.trim()),
          percentage: BigInt(destination.percentage),
          convertToCycles: destination.convertToCycles,
        })),
      ],
      login_prompt_text: toOptionalText(editLoginPromptText),
      payment_prompt_text: toOptionalText(editPaymentPromptText),
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
                <span className="hint">
                  Calculated fee: {formatIcp(createFeeE8s)} ICP. Net to split:{' '}
                  {formatIcp(createNetE8s)} ICP.
                </span>
              </label>
              <div className="form-field">
                <span>Destination splits</span>
                <span className="hint">
                  Define up to three destinations. Percentages must total 100%
                  of the payment after the fee.
                </span>
                <div className="stack">
                  {destinations.map((destination, index) => (
                    <div
                      key={`destination-${index}`}
                      className="stack"
                      style={{
                        border: '1px solid #1f2937',
                        borderRadius: '12px',
                        padding: '12px',
                      }}
                    >
                      <strong>Destination {index + 1}</strong>
                      <label>
                        Principal
                        <input
                          type="text"
                          value={destination.principal}
                          onChange={(event) => {
                            const next = [...destinations];
                            next[index] = {
                              ...next[index],
                              principal: event.target.value,
                            };
                            setDestinations(next);
                          }}
                          placeholder="aaaaa-aa"
                          required={destination.percentage > 0}
                        />
                      </label>
                      <label>
                        Percentage (0-100)
                        <input
                          type="number"
                          min="0"
                          max="100"
                          value={destination.percentage}
                          onChange={(event) => {
                            const next = [...destinations];
                            next[index] = {
                              ...next[index],
                              percentage:
                                Number.parseInt(event.target.value, 10) || 0,
                            };
                            setDestinations(next);
                          }}
                          required
                        />
                      </label>
                      <label>
                        Convert to cycles
                        <input
                          type="checkbox"
                          checked={destination.convertToCycles}
                          onChange={(event) => {
                            const next = [...destinations];
                            next[index] = {
                              ...next[index],
                              convertToCycles: event.target.checked,
                            };
                            setDestinations(next);
                          }}
                        />
                      </label>
                      {destinations.length > 1 && (
                        <button
                          type="button"
                          onClick={() =>
                            setDestinations(
                              destinations.filter((_, i) => i !== index),
                            )
                          }
                        >
                          Remove destination
                        </button>
                      )}
                    </div>
                  ))}
                  {destinations.length < MAX_DESTINATIONS && (
                    <button
                      type="button"
                      onClick={() =>
                        setDestinations([
                          ...destinations,
                          { principal: '', percentage: 0, convertToCycles: false },
                        ])
                      }
                    >
                      Add destination
                    </button>
                  )}
                </div>
              </div>
              {destinations
                .filter((destination) => destination.percentage > 0)
                .map((destination, index) => (
                  <p key={`split-preview-${index}`} className="hint">
                    Split {index + 1}:{' '}
                    {formatIcp(
                      (createNetE8s *
                        BigInt(destination.percentage || 0)) /
                        100n,
                    )}{' '}
                    ICP to {destination.principal || 'destination principal'}
                  </p>
                ))}
              <p className="hint">
                A fee of max(1% of price, 0.0001 ICP) is deducted from every
                payment and sent to {FEE_ACCOUNT_IDENTIFIER}. Your percentages
                apply to the remaining amount. Ensure all destinations can
                accept ICP or cycles.
              </p>
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
              <div className="form-field">
                <span>Session duration</span>
                <span className="hint">
                  Set how long access lasts after payment in days, hours,
                  minutes, and seconds.
                </span>
                <div className="time-inputs">
                  <label>
                    Days
                    <input
                      type="number"
                      min="0"
                      value={sessionDays}
                      onChange={(event) => setSessionDays(event.target.value)}
                      placeholder="Days"
                      required
                    />
                  </label>
                  <label>
                    Hours
                    <input
                      type="number"
                      min="0"
                      value={sessionHours}
                      onChange={(event) => setSessionHours(event.target.value)}
                      placeholder="Hours"
                      required
                    />
                  </label>
                  <label>
                    Minutes
                    <input
                      type="number"
                      min="0"
                      max="59"
                      value={sessionMinutes}
                      onChange={(event) => setSessionMinutes(event.target.value)}
                      placeholder="Minutes"
                      required
                    />
                  </label>
                  <label>
                    Seconds
                    <input
                      type="number"
                      min="0"
                      max="59"
                      value={sessionSeconds}
                      onChange={(event) => setSessionSeconds(event.target.value)}
                      placeholder="Seconds"
                      required
                    />
                  </label>
                </div>
              </div>
              <label>
                Login prompt text (optional)
                <span className="hint">
                  Custom message shown before login, for example: &quot;Welcome
                  to my blog! Log in to access my content.&quot;
                </span>
                <textarea
                  value={loginPromptText}
                  onChange={(event) => setLoginPromptText(event.target.value)}
                  placeholder="Enter a custom login message"
                  rows={3}
                />
              </label>
              <label>
                Payment prompt text (optional)
                <span className="hint">
                  Custom message shown when paying, for example: &quot;This game
                  requires a payment every 7 days to gain access.&quot;
                </span>
                <textarea
                  value={paymentPromptText}
                  onChange={(event) =>
                    setPaymentPromptText(event.target.value)
                  }
                  placeholder="Enter a custom payment message"
                  rows={3}
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
                  const days = Math.floor(durationSeconds / 86400);
                  const hours = Math.floor((durationSeconds % 86400) / 3600);
                  const minutes = Math.floor(
                    ((durationSeconds % 86400) % 3600) / 60,
                  );
                  const seconds = Math.floor(
                    (durationSeconds % 86400) % 60,
                  );
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
                        <strong>Destinations:</strong>
                      </p>
                      <ul className="list">
                        {config.destinations.map((destination, index) => (
                          <li key={`${id}-destination-${index}`}>
                            {destination.destination.toText()} (
                            {Number(destination.percentage)}%,{' '}
                            {destination.convertToCycles ? 'Cycles' : 'ICP'})
                          </li>
                        ))}
                      </ul>
                      <p>
                        <strong>Target Canister:</strong>{' '}
                        {config.target_canister.toText()}
                      </p>
                      <p>
                        <strong>Session Duration:</strong> {days}d {hours}h{' '}
                        {minutes}m {seconds}s
                      </p>
                      <p>
                        <strong>Login Prompt:</strong>{' '}
                        {config.login_prompt_text?.[0] || 'None set'}
                      </p>
                      <p>
                        <strong>Payment Prompt:</strong>{' '}
                        {config.payment_prompt_text?.[0] || 'None set'}
                      </p>
                      <p>
                        <strong>Embed Script:</strong>
                      </p>
                      <code>
                        {`<script type="module" data-paywall data-backend-id="${process.env.CANISTER_ID_PAYWALL_BACKEND}" src="https://${process.env.CANISTER_ID_PAYWALL_FRONTEND}.icp0.io/paywall.js?paywallId=${id}"></script>`}
                      </code>
                      <p className="hint">
                        Set <span className="mono">data-backend-id</span> to your
                        paywall backend canister ID when embedding on non-ICP
                        sites.
                      </p>
                      <p>
                        <strong>Split rule:</strong> Percentages apply after the
                        paywall fee.
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
                            <span className="hint">
                              Calculated fee: {formatIcp(editFeeE8s)} ICP. Net
                              to split: {formatIcp(editNetE8s)} ICP.
                            </span>
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
                          <div className="form-field">
                            <span>Edit Session Duration</span>
                            <span className="hint">
                              Update the access window in days, hours, minutes,
                              and seconds.
                            </span>
                            <div className="time-inputs">
                              <label>
                                Days
                                <input
                                  type="number"
                                  min="0"
                                  value={editSessionDays}
                                  onChange={(event) =>
                                    setEditSessionDays(event.target.value)
                                  }
                                  placeholder="Days"
                                  required
                                />
                              </label>
                              <label>
                                Hours
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
                              </label>
                              <label>
                                Minutes
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
                              </label>
                              <label>
                                Seconds
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
                              </label>
                            </div>
                          </div>
                          <div className="form-field">
                            <span>Edit destinations</span>
                            <span className="hint">
                              Percentages must total 100% after the fee is
                              deducted.
                            </span>
                            <div className="stack">
                              {editDestinations.map((destination, index) => (
                                <div
                                  key={`edit-destination-${index}`}
                                  className="stack"
                                  style={{
                                    border: '1px solid #1f2937',
                                    borderRadius: '12px',
                                    padding: '12px',
                                  }}
                                >
                                  <strong>Destination {index + 1}</strong>
                                  <label>
                                    Principal
                                    <input
                                      type="text"
                                      value={destination.principal}
                                      onChange={(event) => {
                                        const next = [...editDestinations];
                                        next[index] = {
                                          ...next[index],
                                          principal: event.target.value,
                                        };
                                        setEditDestinations(next);
                                      }}
                                      placeholder="aaaaa-aa"
                                      required={destination.percentage > 0}
                                    />
                                  </label>
                                  <label>
                                    Percentage (0-100)
                                    <input
                                      type="number"
                                      min="0"
                                      max="100"
                                      value={destination.percentage}
                                      onChange={(event) => {
                                        const next = [...editDestinations];
                                        next[index] = {
                                          ...next[index],
                                          percentage:
                                            Number.parseInt(
                                              event.target.value,
                                              10,
                                            ) || 0,
                                        };
                                        setEditDestinations(next);
                                      }}
                                      required
                                    />
                                  </label>
                                  <label>
                                    Convert to cycles
                                    <input
                                      type="checkbox"
                                      checked={destination.convertToCycles}
                                      onChange={(event) => {
                                        const next = [...editDestinations];
                                        next[index] = {
                                          ...next[index],
                                          convertToCycles: event.target.checked,
                                        };
                                        setEditDestinations(next);
                                      }}
                                    />
                                  </label>
                                  {editDestinations.length > 1 && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setEditDestinations(
                                          editDestinations.filter(
                                            (_, i) => i !== index,
                                          ),
                                        )
                                      }
                                    >
                                      Remove destination
                                    </button>
                                  )}
                                </div>
                              ))}
                              {editDestinations.length < MAX_DESTINATIONS && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setEditDestinations([
                                      ...editDestinations,
                                      {
                                        principal: '',
                                        percentage: 0,
                                        convertToCycles: false,
                                      },
                                    ])
                                  }
                                >
                                  Add destination
                                </button>
                              )}
                            </div>
                          </div>
                          {editDestinations
                            .filter((destination) => destination.percentage > 0)
                            .map((destination, index) => (
                              <p key={`edit-split-preview-${index}`} className="hint">
                                Split {index + 1}:{' '}
                                {formatIcp(
                                  (editNetE8s *
                                    BigInt(destination.percentage || 0)) /
                                    100n,
                                )}{' '}
                                ICP to{' '}
                                {destination.principal || 'destination principal'}
                              </p>
                            ))}
                          <label>
                            Edit login prompt text (optional)
                            <textarea
                              value={editLoginPromptText}
                              onChange={(event) =>
                                setEditLoginPromptText(event.target.value)
                              }
                              placeholder="Enter a custom login message"
                              rows={3}
                            />
                          </label>
                          <label>
                            Edit payment prompt text (optional)
                            <textarea
                              value={editPaymentPromptText}
                              onChange={(event) =>
                                setEditPaymentPromptText(event.target.value)
                              }
                              placeholder="Enter a custom payment message"
                              rows={3}
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

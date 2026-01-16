import Array "mo:base/Array";
import Blob "mo:base/Blob";
import HashMap "mo:base/HashMap";
import Int "mo:base/Int";
import Iter "mo:base/Iter";
import Nat "mo:base/Nat";
import Nat8 "mo:base/Nat8";
import Nat32 "mo:base/Nat32";
import Nat64 "mo:base/Nat64";
import Principal "mo:base/Principal";
import Random "mo:base/Random";
import Text "mo:base/Text";
import Time "mo:base/Time";
persistent actor Paywall {
  type Account = {
    owner : Principal;
    subaccount : ?Blob;
  };

  type TransferArgs = {
    to : Account;
    amount : Nat;
    fee : ?Nat;
    memo : ?Blob;
    from_subaccount : ?Blob;
    created_at_time : ?Nat64;
  };

  type TransferError = {
    #BadFee : { expected_fee : Nat };
    #BadBurn : { min_burn_amount : Nat };
    #Duplicate : { duplicate_of : Nat };
    #InsufficientFunds : { balance : Nat };
    #CreatedInFuture : { ledger_time : Nat64 };
    #TooOld;
    #TemporarilyUnavailable;
    #GenericError : { message : Text; error_code : Nat };
  };

  type TransferResult = {
    #Ok : Nat;
    #Err : TransferError;
  };

  type Ledger = actor {
    icrc1_balance_of : shared query Account -> async Nat;
    icrc1_transfer : shared TransferArgs -> async TransferResult;
  };

  type PaywallConfig = {
    price_e8s : Nat;
    destination : Principal;
    target_canister : Principal;
    session_duration_ns : Nat;
    convertToCycles : Bool;
  };
  type PaywallUpdate = {
    price_e8s : ?Nat;
    destination : ?Principal;
    target_canister : ?Principal;
    session_duration_ns : ?Nat;
    convertToCycles : ?Bool;
  };

  type NotifyMintCyclesArgs = {
    block_index : Nat64;
  };

  type NotifyMintCyclesError = {
    #Refunded : { block_index : ?Nat64; reason : Text };
    #InvalidTransaction : Text;
    #Other : { code : Nat32; message : Text };
    #Processing;
    #TransactionTooOld : Nat64;
  };

  type NotifyMintCyclesResult = {
    #Ok : Nat;
    #Err : NotifyMintCyclesError;
  };

  type CyclesMintingCanister = actor {
    notify_mint_cycles : shared NotifyMintCyclesArgs -> async NotifyMintCyclesResult;
  };

  stable var paywallConfigEntries : [(Text, PaywallConfig)] = [];
  stable var paidStatusEntries : [(Principal, [(Text, Int)])] = [];
  stable var ownedPaywallsEntries : [(Principal, [Text])] = [];
  stable var nextPaywallId : Nat = 0;
  stable var salt : [Nat8] = [];

  transient let ledger : Ledger = actor ("ryjl3-tyaaa-aaaaa-aaaba-cai");
  transient let cmc : CyclesMintingCanister = actor ("rkp4c-7iaaa-aaaaa-aaaca-cai");

  transient var paywallConfigs = HashMap.HashMap<Text, PaywallConfig>(0, Text.equal, Text.hash);
  transient var paidStatuses = HashMap.HashMap<Principal, HashMap.HashMap<Text, Int>>(
    0,
    Principal.equal,
    Principal.hash,
  );
  transient var ownedPaywalls = HashMap.HashMap<Principal, [Text]>(0, Principal.equal, Principal.hash);

  system func preupgrade() {
    paywallConfigEntries := Iter.toArray(paywallConfigs.entries());
    paidStatusEntries := Iter.toArray(
      Iter.map<((Principal, HashMap.HashMap<Text, Int>)), (Principal, [(Text, Int)])>(
        paidStatuses.entries(),
        func(entry : (Principal, HashMap.HashMap<Text, Int>)) : (Principal, [(Text, Int)]) {
          (entry.0, Iter.toArray(entry.1.entries()));
        },
      ),
    );
    ownedPaywallsEntries := Iter.toArray(
      Iter.map<(Principal, [Text]), (Principal, [Text])>(
        ownedPaywalls.entries(),
        func(entry : (Principal, [Text])) : (Principal, [Text]) {
          entry;
        },
      ),
    );
  };

  system func postupgrade() {
    paywallConfigs := HashMap.HashMap<Text, PaywallConfig>(paywallConfigEntries.size(), Text.equal, Text.hash);
    for ((id, config) in paywallConfigEntries.vals()) {
      paywallConfigs.put(id, config);
    };

    paidStatuses := HashMap.HashMap<Principal, HashMap.HashMap<Text, Int>>(
      paidStatusEntries.size(),
      Principal.equal,
      Principal.hash,
    );

    for ((owner, entries) in paidStatusEntries.vals()) {
      let userMap = HashMap.HashMap<Text, Int>(entries.size(), Text.equal, Text.hash);
      for ((paywallId, expiry) in entries.vals()) {
        userMap.put(paywallId, expiry);
      };
      paidStatuses.put(owner, userMap);
    };

    ownedPaywalls := HashMap.HashMap<Principal, [Text]>(
      ownedPaywallsEntries.size(),
      Principal.equal,
      Principal.hash,
    );
    for ((owner, ids) in ownedPaywallsEntries.vals()) {
      ownedPaywalls.put(owner, ids);
    };
  };

  private func getSalt() : async Blob {
    if (salt.size() == 0) {
      let random = await Random.blob();
      salt := Blob.toArray(random);
    };
    Blob.fromArray(salt);
  };

  private func deriveSubaccount(paywallId : Text, user : Principal) : async Blob {
    let saltBlob = await getSalt();
    let payload = Array.append(
      Blob.toArray(saltBlob),
      Array.append(
        Blob.toArray(Text.encodeUtf8(paywallId)),
        Blob.toArray(Principal.toBlob(user)),
      ),
    );
    let output = Array.init<Nat8>(32, 0);
    var index = 0;
    for (byte in payload.vals()) {
      let slot = index % 32;
      output[slot] := Nat8.fromNat((Nat8.toNat(output[slot]) + Nat8.toNat(byte)) % 256);
      index += 1;
    };
    Blob.fromArray(Array.freeze(output));
  };

  private func deriveUserSubaccount(user : Principal) : async Blob {
    let saltBlob = await getSalt();
    let payload = Array.append(
      Blob.toArray(saltBlob),
      Array.append(
        Blob.toArray(Text.encodeUtf8("wallet")),
        Blob.toArray(Principal.toBlob(user)),
      ),
    );
    let output = Array.init<Nat8>(32, 0);
    var index = 0;
    for (byte in payload.vals()) {
      let slot = index % 32;
      output[slot] := Nat8.fromNat((Nat8.toNat(output[slot]) + Nat8.toNat(byte)) % 256);
      index += 1;
    };
    Blob.fromArray(Array.freeze(output));
  };

  private func buildCmcSubaccount(destination : Principal) : ?Blob {
    let principalBytes = Blob.toArray(Principal.toBlob(destination));
    if (principalBytes.size() > 31) {
      return null;
    };
    let subaccount = Array.init<Nat8>(32, 0);
    subaccount[0] := Nat8.fromNat(principalBytes.size());
    var index = 0;
    for (byte in principalBytes.vals()) {
      subaccount[index + 1] := byte;
      index += 1;
    };
    ?Blob.fromArray(Array.freeze(subaccount));
  };

  private func mintCycles(amount : Nat, from_subaccount : ?Blob, destination : Principal) : async Bool {
    let ?cmcSubaccount = buildCmcSubaccount(destination) else return false;
    let memo = Blob.fromArray([0x4D, 0x49, 0x4E, 0x54, 0x00, 0x00, 0x00, 0x00]);
    let transferResult = await ledger.icrc1_transfer({
      to = {
        owner = Principal.fromActor(cmc);
        subaccount = ?cmcSubaccount;
      };
      amount;
      from_subaccount;
      fee = ?10_000;
      memo = ?memo;
      created_at_time = null;
    });
    switch (transferResult) {
      case (#Err(_)) false;
      case (#Ok(blockIndex)) {
        let notifyResult = await cmc.notify_mint_cycles({
          block_index = Nat64.fromNat(blockIndex);
        });
        switch (notifyResult) {
          case (#Err(_)) false;
          case (#Ok(_)) true;
        };
      };
    };
  };

  public shared(msg) func createPaywall(config : PaywallConfig) : async Text {
    let id = "pw-" # Nat.toText(nextPaywallId);
    nextPaywallId += 1;
    paywallConfigs.put(id, config);
    let owner = msg.caller;
    let currentIds = switch (ownedPaywalls.get(owner)) {
      case null [];
      case (?ids) ids;
    };
    ownedPaywalls.put(owner, Array.append(currentIds, [id]));
    id;
  };

  public query func getPaywallConfig(id : Text) : async ?PaywallConfig {
    paywallConfigs.get(id);
  };

  public shared(msg) func getPaymentAccount(paywallId : Text) : async ?Account {
    switch (paywallConfigs.get(paywallId)) {
      case null null;
      case (?_) {
        let subaccount = await deriveSubaccount(paywallId, msg.caller);
        ?{
          owner = Principal.fromActor(Paywall);
          subaccount = ?subaccount;
        };
      };
    };
  };

  public shared(msg) func getUserAccount() : async Account {
    let subaccount = await deriveUserSubaccount(msg.caller);
    {
      owner = Principal.fromActor(Paywall);
      subaccount = ?subaccount;
    };
  };

  public shared(msg) func withdrawFromWallet(amount : Nat, to : Account) : async TransferResult {
    let subaccount = await deriveUserSubaccount(msg.caller);
    await ledger.icrc1_transfer({
      to;
      amount;
      from_subaccount = ?subaccount;
      fee = ?10_000;
      memo = null;
      created_at_time = null;
    });
  };

  public shared(msg) func payFromBalance(paywallId : Text) : async Bool {
    let caller = msg.caller;
    let ?config = paywallConfigs.get(paywallId) else return false;
    let userSubaccount = await deriveUserSubaccount(caller);
    let balance = await ledger.icrc1_balance_of({
      owner = Principal.fromActor(Paywall);
      subaccount = ?userSubaccount;
    });

    if (balance < config.price_e8s) {
      return false;
    };

    let paid = if (config.convertToCycles) {
      await mintCycles(config.price_e8s, ?userSubaccount, config.destination);
    } else {
      let transferResult = await ledger.icrc1_transfer({
        to = {
          owner = config.destination;
          subaccount = null;
        };
        amount = config.price_e8s;
        from_subaccount = ?userSubaccount;
        fee = ?10_000;
        memo = null;
        created_at_time = null;
      });
      switch (transferResult) {
        case (#Err(_)) false;
        case (#Ok(_)) true;
      };
    };

    if (not paid) {
      return false;
    };

    let expiry = Time.now() + config.session_duration_ns;
    let userMap = switch (paidStatuses.get(caller)) {
      case (?existing) existing;
      case null {
        let created = HashMap.HashMap<Text, Int>(1, Text.equal, Text.hash);
        paidStatuses.put(caller, created);
        created;
      };
    };
    userMap.put(paywallId, expiry);
    true;
  };

  public shared(msg) func verifyPayment(paywallId : Text) : async Bool {
    let caller = msg.caller;
    let ?config = paywallConfigs.get(paywallId) else return false;
    let subaccount = await deriveSubaccount(paywallId, caller);
    let balance = await ledger.icrc1_balance_of({
      owner = Principal.fromActor(Paywall);
      subaccount = ?subaccount;
    });

    if (balance < config.price_e8s) {
      return false;
    };

    let paid = if (config.convertToCycles) {
      await mintCycles(config.price_e8s, ?subaccount, config.destination);
    } else {
      let transferResult = await ledger.icrc1_transfer({
        to = {
          owner = config.destination;
          subaccount = null;
        };
        amount = config.price_e8s;
        from_subaccount = ?subaccount;
        fee = ?10_000;
        memo = null;
        created_at_time = null;
      });
      switch (transferResult) {
        case (#Err(_)) false;
        case (#Ok(_)) true;
      };
    };

    if (not paid) {
      return false;
    };

    let expiry = Time.now() + config.session_duration_ns;
    let userMap = switch (paidStatuses.get(caller)) {
      case (?existing) existing;
      case null {
        let created = HashMap.HashMap<Text, Int>(1, Text.equal, Text.hash);
        paidStatuses.put(caller, created);
        created;
      };
    };
    userMap.put(paywallId, expiry);
    true;
  };

  public query func hasAccess(user : Principal, paywallId : Text) : async Bool {
    switch (paidStatuses.get(user)) {
      case null false;
      case (?userMap) {
        switch (userMap.get(paywallId)) {
          case null false;
          case (?expiry) expiry > Time.now();
        };
      };
    };
  };

  public query func getOwnedPaywalls(owner : Principal) : async [Text] {
    switch (ownedPaywalls.get(owner)) {
      case null [];
      case (?ids) ids;
    };
  };

  public shared(msg) func updatePaywall(id : Text, updates : PaywallUpdate) : async () {
    let ?config = paywallConfigs.get(id) else return;
    let ownerIds = switch (ownedPaywalls.get(msg.caller)) {
      case null return;
      case (?ids) ids;
    };
    let isOwner = Array.find<Text>(ownerIds, func(value : Text) : Bool { value == id }) != null;
    if (not isOwner) {
      return;
    };

    let newConfig = {
      price_e8s = switch (updates.price_e8s) {
        case null config.price_e8s;
        case (?value) value;
      };
      destination = switch (updates.destination) {
        case null config.destination;
        case (?value) value;
      };
      target_canister = switch (updates.target_canister) {
        case null config.target_canister;
        case (?value) value;
      };
      session_duration_ns = switch (updates.session_duration_ns) {
        case null config.session_duration_ns;
        case (?value) value;
      };
      convertToCycles = switch (updates.convertToCycles) {
        case null config.convertToCycles;
        case (?value) value;
      };
    };
    paywallConfigs.put(id, newConfig);
  };
}

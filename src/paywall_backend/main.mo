import Array "mo:base/Array";
import Blob "mo:base/Blob";
import HashMap "mo:base/HashMap";
import Int "mo:base/Int";
import Iter "mo:base/Iter";
import Nat "mo:base/Nat";
import Nat8 "mo:base/Nat8";
import Nat64 "mo:base/Nat64";
import Principal "mo:base/Principal";
import Random "mo:base/Random";
import Text "mo:base/Text";
import Time "mo:base/Time";

actor Paywall {
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
  };

  stable var paywallConfigEntries : [(Text, PaywallConfig)] = [];
  stable var paidStatusEntries : [(Principal, [(Text, Int)])] = [];
  stable var nextPaywallId : Nat = 0;
  stable var salt : [Nat8] = [];

  let ledger : Ledger = actor ("ryjl3-tyaaa-aaaaa-aaaba-cai");

  var paywallConfigs = HashMap.HashMap<Text, PaywallConfig>(0, Text.equal, Text.hash);
  var paidStatuses = HashMap.HashMap<Principal, HashMap.HashMap<Text, Int>>(
    0,
    Principal.equal,
    Principal.hash,
  );

  system func preupgrade() {
    paywallConfigEntries := Iter.toArray(paywallConfigs.entries());
    paidStatusEntries := Iter.toArray(
      Iter.map(
        paidStatuses.entries(),
        func(entry : (Principal, HashMap.HashMap<Text, Int>)) : (Principal, [(Text, Int)]) {
          (entry.0, Iter.toArray(entry.1.entries()));
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
    let payload = Blob.toArray(saltBlob)
      # Blob.toArray(Text.encodeUtf8(paywallId))
      # Blob.toArray(Principal.toBlob(user));
    let output = Array.init<Nat8>(32, 0);
    var index = 0;
    for (byte in payload.vals()) {
      let slot = index % 32;
      output[slot] := Nat8.fromNat((Nat8.toNat(output[slot]) + Nat8.toNat(byte)) % 256);
      index += 1;
    };
    Blob.fromArray(output);
  };

  public shared(msg) func createPaywall(config : PaywallConfig) : async Text {
    let id = "pw-" # Nat.toText(nextPaywallId);
    nextPaywallId += 1;
    paywallConfigs.put(id, config);
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

    ignore await ledger.icrc1_transfer({
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

    let expiry = Time.now() + Int.fromNat(config.session_duration_ns);
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
}

import Array "mo:base/Array";
import Blob "mo:base/Blob";
import Char "mo:base/Char";
import Debug "mo:base/Debug";
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

  type Tokens = { e8s : Nat64 };

  type LegacyTransferArgs = {
    to : Blob;
    fee : Tokens;
    memo : Nat64;
    from_subaccount : ?Blob;
    created_at_time : ?Nat64;
    amount : Tokens;
  };

  type LegacyTransferError = {
    #BadFee : { expected_fee : Tokens };
    #InsufficientFunds : { balance : Tokens };
    #TxTooOld : { allowed_window_nanos : Nat64 };
    #TxDuplicate : { duplicate_of : Nat64 };
    #TxCreatedInFuture;
    #TemporarilyUnavailable;
    #GenericError : { error_code : Nat64; message : Text };
  };

  type LegacyTransferResult = {
    #Ok : Nat64;
    #Err : LegacyTransferError;
  };

  type Ledger = actor {
    icrc1_balance_of : shared query Account -> async Nat;
    icrc1_transfer : shared TransferArgs -> async TransferResult;
    transfer : shared LegacyTransferArgs -> async LegacyTransferResult;
  };

  type Destination = {
    destination : Principal;
    percentage : Nat;
    convertToCycles : Bool;
  };

  type PaywallConfig = {
    price_e8s : Nat;
    target_canister : Principal;
    session_duration_ns : Nat;
    destinations : [Destination];
  };
  type PaywallUpdate = {
    price_e8s : ?Nat;
    target_canister : ?Principal;
    session_duration_ns : ?Nat;
    destinations : ?[Destination];
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

  type NotifyTopUpArgs = {
    block_index : Nat64;
    canister_id : Principal;
  };

  type NotifyTopUpError = {
    #Refunded : { block_index : ?Nat64; reason : Text };
    #InvalidTransaction : Text;
    #Other : { code : Nat32; message : Text };
    #Processing;
    #TransactionTooOld : Nat64;
  };

  type NotifyTopUpResult = {
    #Ok : Nat;
    #Err : NotifyTopUpError;
  };

  type CyclesMintingCanister = actor {
    notify_mint_cycles : shared NotifyMintCyclesArgs -> async NotifyMintCyclesResult;
    notify_top_up : shared NotifyTopUpArgs -> async NotifyTopUpResult;
  };

  type PaymentResult = {
    #Ok;
    #Err : Text;
  };

  stable var paywallConfigEntries : [(Text, PaywallConfig)] = [];
  stable var paidStatusEntries : [(Principal, [(Text, Int)])] = [];
  stable var ownedPaywallsEntries : [(Principal, [Text])] = [];
  stable var nextPaywallId : Nat = 0;
  stable var salt : [Nat8] = [];

  transient let ledger : Ledger = actor ("ryjl3-tyaaa-aaaaa-aaaba-cai");
  transient let cmc : CyclesMintingCanister = actor ("rkp4c-7iaaa-aaaaa-aaaca-cai");
  let ledgerFee : Nat = 10_000;
  let feeAccountIdentifierHex : Text =
    "2a4abcd2278509654f9a26b885ecb49b8619bffe58a6acb2e3a5e3c7fb96020d";
  let feeAccountIdentifier : Blob = Blob.fromArray(hexToBytes(feeAccountIdentifierHex));

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

  private func hexToNibble(char : Char) : ?Nat8 {
    let code = Char.toNat32(char);
    if (code >= 48 and code <= 57) {
      return ?Nat8.fromNat(Nat32.toNat(code - 48));
    };
    if (code >= 65 and code <= 70) {
      return ?Nat8.fromNat(Nat32.toNat(code - 55));
    };
    if (code >= 97 and code <= 102) {
      return ?Nat8.fromNat(Nat32.toNat(code - 87));
    };
    null;
  };

  private func hexToBytes(hex : Text) : [Nat8] {
    let chars = Iter.toArray(Text.toIter(hex));
    if (chars.size() % 2 != 0) {
      Debug.trap("Invalid hex length");
    };
    let bytes = Array.init<Nat8>(chars.size() / 2, 0);
    var index = 0;
    while (index < chars.size()) {
      let ?high = hexToNibble(chars[index]) else Debug.trap("Invalid hex character");
      let ?low = hexToNibble(chars[index + 1]) else Debug.trap("Invalid hex character");
      bytes[index / 2] := Nat8.fromNat(Nat8.toNat(high) * 16 + Nat8.toNat(low));
      index += 2;
    };
    Array.freeze(bytes);
  };

  private func buildMintSubaccount(destination : Principal) : ?Blob {
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

  private func buildTopUpSubaccount(destination : Principal) : ?Blob {
    let principalBytes = Blob.toArray(Principal.toBlob(destination));
    if (principalBytes.size() > 31) {
      return null;
    };
    let subaccount = Array.init<Nat8>(32, 0);
    subaccount[0] := Nat8.fromNat(principalBytes.size());
    var index = 1;
    for (byte in principalBytes.vals()) {
      subaccount[index] := byte;
      index += 1;
    };
    ?Blob.fromArray(Array.freeze(subaccount));
  };

  private func isCanister(destination : Principal) : Bool {
    Blob.toArray(Principal.toBlob(destination)).size() == 10;
  };

  private func mintCycles(
    amount : Nat,
    from_subaccount : ?Blob,
    destination : Principal,
  ) : async PaymentResult {
    let ?cmcSubaccount = buildMintSubaccount(destination) else {
      return #Err("Invalid mint subaccount for destination " # Principal.toText(destination));
    };
    let memo = Blob.fromArray([0x4D, 0x49, 0x4E, 0x54, 0x00, 0x00, 0x00, 0x00]);
    let transferResult = await ledger.icrc1_transfer({
      to = {
        owner = Principal.fromActor(cmc);
        subaccount = ?cmcSubaccount;
      };
      amount;
      from_subaccount;
      fee = ?ledgerFee;
      memo = ?memo;
      created_at_time = null;
    });
    switch (transferResult) {
      case (#Err(err)) {
        Debug.print("CMC mint transfer failed: " # debug_show(err));
        #Err("CMC mint transfer failed: " # debug_show(err));
      };
      case (#Ok(blockIndex)) {
        let notifyResult = await cmc.notify_mint_cycles({
          block_index = Nat64.fromNat(blockIndex);
        });
        switch (notifyResult) {
          case (#Err(err)) {
            Debug.print("CMC mint notify failed: " # debug_show(err));
            #Err("CMC mint notify failed: " # debug_show(err));
          };
          case (#Ok(_)) #Ok;
        };
      };
    };
  };

  private func topUpCanister(
    amount : Nat,
    from_subaccount : ?Blob,
    destination : Principal,
  ) : async PaymentResult {
    let ?cmcSubaccount = buildTopUpSubaccount(destination) else {
      return #Err("Invalid top-up subaccount for destination " # Principal.toText(destination));
    };
    let memo = Blob.fromArray([0x54, 0x50, 0x55, 0x50, 0x00, 0x00, 0x00, 0x00]);
    let transferResult = await ledger.icrc1_transfer({
      to = {
        owner = Principal.fromActor(cmc);
        subaccount = ?cmcSubaccount;
      };
      amount;
      from_subaccount;
      fee = ?ledgerFee;
      memo = ?memo;
      created_at_time = null;
    });
    switch (transferResult) {
      case (#Err(err)) {
        Debug.print("CMC top-up transfer failed: " # debug_show(err));
        #Err("CMC top-up transfer failed: " # debug_show(err));
      };
      case (#Ok(blockIndex)) {
        let notifyResult = await cmc.notify_top_up({
          block_index = Nat64.fromNat(blockIndex);
          canister_id = destination;
        });
        switch (notifyResult) {
          case (#Err(err)) {
            Debug.print("CMC top-up notify failed: " # debug_show(err));
            #Err("CMC top-up notify failed: " # debug_show(err));
          };
          case (#Ok(_)) #Ok;
        };
      };
    };
  };

  private func sendPayment(
    amount : Nat,
    from_subaccount : ?Blob,
    destination : Principal,
    convertToCycles : Bool,
  ) : async PaymentResult {
    if (not convertToCycles) {
      Debug.print("Sending direct ICP transfer to " # Principal.toText(destination));
      let transferResult = await ledger.icrc1_transfer({
        to = {
          owner = destination;
          subaccount = null;
        };
        amount;
        from_subaccount;
        fee = ?ledgerFee;
        memo = null;
        created_at_time = null;
      });
      switch (transferResult) {
        case (#Err(err)) {
          Debug.print("Direct transfer failed: " # debug_show(err));
          #Err("Direct transfer failed: " # debug_show(err));
        };
        case (#Ok(_)) #Ok;
      };
    } else {
      let canisterTarget = isCanister(destination);
      Debug.print(
        "Convert to cycles enabled. Destination is canister format: " #
        (if (canisterTarget) { "true" } else { "false" }) # " (" #
        Principal.toText(destination) # ")",
      );
      if (canisterTarget) {
        await topUpCanister(amount, from_subaccount, destination);
      } else {
        await mintCycles(amount, from_subaccount, destination);
      };
    };
  };

  private func sendFee(amount : Nat, from_subaccount : ?Blob) : async PaymentResult {
    let transferResult = await ledger.transfer({
      to = feeAccountIdentifier;
      amount = { e8s = Nat64.fromNat(amount) };
      fee = { e8s = Nat64.fromNat(ledgerFee) };
      memo = 0;
      from_subaccount;
      created_at_time = null;
    });
    switch (transferResult) {
      case (#Err(err)) {
        Debug.print("Fee transfer failed: " # debug_show(err));
        #Err("Fee transfer failed: " # debug_show(err));
      };
      case (#Ok(_)) #Ok;
    };
  };

  private func validateDestinations(destinations : [Destination]) : () {
    if (destinations.size() == 0) {
      Debug.trap("At least one destination is required");
    };
    if (destinations.size() > 3) {
      Debug.trap("Maximum 3 destinations allowed");
    };
    var percentSum : Nat = 0;
    for (destination in destinations.vals()) {
      percentSum += destination.percentage;
    };
    if (percentSum != 100) {
      Debug.trap("Destination percentages must sum to 100");
    };
  };

  private func calculateFee(price_e8s : Nat) : Nat {
    Nat.max(price_e8s / 100, ledgerFee);
  };

  public shared(msg) func createPaywall(config : PaywallConfig) : async Text {
    let id = "pw-" # Nat.toText(nextPaywallId);
    nextPaywallId += 1;
    validateDestinations(config.destinations);
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
      fee = ?ledgerFee;
      memo = null;
      created_at_time = null;
    });
  };

  public shared(msg) func payFromBalance(paywallId : Text) : async PaymentResult {
    let caller = msg.caller;
    let ?config = paywallConfigs.get(paywallId) else return #Err("Invalid paywall ID");
    let userSubaccount = await deriveUserSubaccount(caller);
    let balance = await ledger.icrc1_balance_of({
      owner = Principal.fromActor(Paywall);
      subaccount = ?userSubaccount;
    });

    let fee_e8s = calculateFee(config.price_e8s);
    if (config.price_e8s < fee_e8s) {
      return #Err("Paywall price is too low to cover the fee.");
    };
    let transferCount = config.destinations.size() + 1;
    let requiredBalance = config.price_e8s + (ledgerFee * transferCount);
    if (balance < requiredBalance) {
      return #Err(
        "Insufficient balance: have " # Nat.toText(balance) # ", need " #
        Nat.toText(requiredBalance),
      );
    };

    let feeResult = await sendFee(fee_e8s, ?userSubaccount);
    switch (feeResult) {
      case (#Err(message)) {
        Debug.print(
          "Fee transfer failed for " # Principal.toText(caller) # ": " # message,
        );
        return #Err(message);
      };
      case (#Ok) {};
    };

    let userAmount = config.price_e8s - fee_e8s;
    var remaining = userAmount;
    let lastIndex = config.destinations.size() - 1;
    var index : Nat = 0;
    for (destination in config.destinations.vals()) {
      var amount = (userAmount * destination.percentage) / 100;
      if (index == lastIndex) {
        amount += remaining - amount;
      };
      remaining -= amount;
      if (amount > 0) {
        let paidResult = await sendPayment(
          amount,
          ?userSubaccount,
          destination.destination,
          destination.convertToCycles,
        );
        switch (paidResult) {
          case (#Err(message)) {
            Debug.print(
              "Payment failed for " # Principal.toText(caller) # ": " # message,
            );
            return #Err(message);
          };
          case (#Ok) {};
        };
      };
      index += 1;
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
    #Ok;
  };

  public shared(msg) func verifyPayment(paywallId : Text) : async PaymentResult {
    let caller = msg.caller;
    let ?config = paywallConfigs.get(paywallId) else return #Err("Invalid paywall ID");
    let subaccount = await deriveSubaccount(paywallId, caller);
    let balance = await ledger.icrc1_balance_of({
      owner = Principal.fromActor(Paywall);
      subaccount = ?subaccount;
    });

    let fee_e8s = calculateFee(config.price_e8s);
    if (config.price_e8s < fee_e8s) {
      return #Err("Paywall price is too low to cover the fee.");
    };
    let transferCount = config.destinations.size() + 1;
    let requiredBalance = config.price_e8s + (ledgerFee * transferCount);
    if (balance < requiredBalance) {
      return #Err(
        "Insufficient balance: have " # Nat.toText(balance) # ", need " #
        Nat.toText(requiredBalance),
      );
    };

    let feeResult = await sendFee(fee_e8s, ?subaccount);
    switch (feeResult) {
      case (#Err(message)) {
        Debug.print(
          "Fee transfer failed for " # Principal.toText(caller) # ": " #
          message,
        );
        return #Err(message);
      };
      case (#Ok) {};
    };

    let userAmount = config.price_e8s - fee_e8s;
    var remaining = userAmount;
    let lastIndex = config.destinations.size() - 1;
    var index : Nat = 0;
    for (destination in config.destinations.vals()) {
      var amount = (userAmount * destination.percentage) / 100;
      if (index == lastIndex) {
        amount += remaining - amount;
      };
      remaining -= amount;
      if (amount > 0) {
        let paidResult = await sendPayment(
          amount,
          ?subaccount,
          destination.destination,
          destination.convertToCycles,
        );
        switch (paidResult) {
          case (#Err(message)) {
            Debug.print(
              "Verification payment failed for " # Principal.toText(caller) # ": " #
              message,
            );
            return #Err(message);
          };
          case (#Ok) {};
        };
      };
      index += 1;
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
    #Ok;
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

    let newDestinations = switch (updates.destinations) {
      case null config.destinations;
      case (?values) {
        validateDestinations(values);
        values;
      };
    };

    let newConfig = {
      price_e8s = switch (updates.price_e8s) {
        case null config.price_e8s;
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
      destinations = newDestinations;
    };
    paywallConfigs.put(id, newConfig);
  };
}

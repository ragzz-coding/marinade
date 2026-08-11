# Stage 3 Results

## Executive Verdict

| Hypothesis | Result | Exploitability | Impact | Evidence |
| ---------- | ------ | -------------- | ------ | -------- |
| H5 | **PROVEN NOT VULNERABLE** | N/A | None (by design) | Model tests `h5_*` (executable); source `deposit_stake_account.rs:155–161` |
| H3 | **PROVEN VULNERABLE (model)** | Permissionless `update_deactivated` + `finalize` after native force-deactivation during `IteratingValidators` on a **not-yet-finalized** validator | **High** — permanent FSM stall (`is_done()==false`); gated stake-moving / `withdraw_stake_account` permanently unavailable; other exits remain | Model test `h3_update_deactivated_emergency_on_pending_validator_breaks_finalize`; source `update.rs:569–591` + `finalize_delinquent_upgrade.rs:37–38` |
| H1 (visited/count stuck in IteratingStakes) | **PROVEN NOT VULNERABLE** | N/A | None for stated claim | Atomicity + emergency path keeps totals aligned; tests `h1_*` |
| H1-VARIANT (orphaned `Unknown` after premature transition) | **PROVEN VULNERABLE (model)** | Same force-deactivate + crank ordering during `IteratingStakes` | **High** — stake record stuck `Unknown` after `Done`; `update_active` forever errors; deactivate/withdraw/merge require `Active` | Model test `h1_variant_unknown_stake_survives_into_done_and_cannot_upgrade`; `update.rs:498–499` |

**On-chain Anchor/Solana integration PoC:** not executed (tooling missing). Results above are **deterministic pure-Rust models** of the exact arithmetic/branches. Treat as strong evidence, not a submitted Immunefi PoC binary until replayed under Anchor localnet.

---

## H5 — deposit into finalized validator

### Exact code path

```text
deposit_stake_account
  → validator.active_balance += stake
  → match IteratingValidators:
       if validator_index >= visited_count { shadow += stake }
       else { /* shadow already 0 — intentional */ }
  → total_active_balance += stake
  → stake_list.add(Active); mint mSOL
```

Source: `deposit_stake_account.rs:142–166`, `269–305`.

### Preconditions

- `delinquent_upgrader == IteratingValidators`
- `validator_index < visited_count` (already finalized)
- Normal stake deposit checks (listed validator, active stake, etc.)
- Not paused

### Reachability

**YES.** `deposit_stake_account` has **no** `is_done()` gate. Finalize is chunked (`max_validators`), so a validator can be finalized while others remain pending.

### State transition

| Step | State |
|------|-------|
| After finalize V0 | `active=shadow`, `shadow=0`, `visited_count=1`, `left` reduced |
| Deposit into V0 | `active += X`, `shadow` stays 0, `total_active += X`, new stake `Active` |
| Finalize rest | remaining deltas unchanged by deposit; `left→0` → `Done` |

### Invariant tested

Finalize conservation + post-deposit validator `active` equals prior shadow + deposit.

### Test/PoC

```bash
cd /workspace/stage3-fsm-model && cargo test h5_ -- --nocapture
```

Results: **both passed**.

### Result

**PROVEN NOT VULNERABLE.** The `validator_index >= visited_count` branch explicitly maintains the invariant; the `< visited_count` path intentionally only bumps `active_balance`.

### Why this isn't exploitable

Finalization snapshot for V is already applied; new stake is live state after that snapshot. No double-count in `delinquent_balance_left`. No stuck FSM. No mSOL inflation beyond the real deposited stake.

### Immunefi impact classification

N/A — not a vulnerability.

---

## H3 — finalize / `update_deactivated` interleaving

### Exact code path

```text
[IteratingValidators, validator V not yet finalized]
  stake S: last_update_status == Active, on-chain deactivating
       ↓
update_deactivated (permissionless)          # update.rs:548+
  if status == Active:                       # :569-591
    emergency_cooling += amount
    total_active_balance -= amount
    validator.active_balance -= amount
    # shadow NOT decreased
  withdraw → reserve; remove stake
  # NOT IteratingStakes ⇒ normal cooling subtract (:681-689)
       ↓
finalize_delinquent_upgrade                  # finalize:37-38
  left -= (active - shadow)   # UNDERFLOWS if active < shadow
```

### Preconditions

1. FSM in `IteratingValidators` (reachable after completing IteratingStakes).
2. Validator index `>= visited_count` (not yet finalized).
3. Stake for that validator has `last_update_status == Active` (true after Unknown→Active upgrade).
4. Stake becomes on-chain deactivating **without** Marinade `deactivate_stake` (which is `is_done`-gated). Realistic trigger: Solana delinquent force-deactivation — the scenario this upgrade exists to handle.
5. Permissionless crank calls `update_deactivated`, then `finalize_delinquent_upgrade`.

### Reachability

| Step | Who | Allowed? |
|------|-----|----------|
| Enter IteratingValidators | permissionless updates | YES |
| Force-deactivate | Solana stake program / delinquent validator | YES (external, realistic in this upgrade) |
| `update_deactivated` | anyone | YES (no IteratingValidators gate) |
| `finalize` | anyone | YES |
| Recovery | decrease shadow / skip validator | **NO** instruction exists |

Manager `emergency_unstake` cannot be used as a controlled alternative — it requires `is_done()` (`emergency_unstake.rs:54–55`).

### State transition (minimal)

```text
T0  IteratingValidators { visited=0, left=20 }
    V0: active=100, shadow=80
    Stake S=80, status=Active, on-chain deactivating
T1  update_deactivated(S)
    V0: active=20, shadow=80
T2  finalize(max=…)
    computes 20 - 80 → ArithmeticOverflow (overflow-checks=true)
T3  retry finalize → same failure forever
    is_done() == false permanently
```

### Invariant tested

`active_balance >= delinquent_upgrader_active_balance` at finalize time for pending validators; `delinquent_balance_left` conservation.

### Test/PoC

```bash
cd /workspace/stage3-fsm-model && cargo test h3_ -- --nocapture
```

| Test | Result |
|------|--------|
| `h3_update_deactivated_emergency_on_pending_validator_breaks_finalize` | **PASS** (overflow + stuck) |
| `h3_emergency_on_already_finalized_validator_still_allows_done` | **PASS** (shows already-finalized path is safe) |

### Result

**PROVEN VULNERABLE at model/arithmetic level.**

### Why exploitable

`update_deactivated`’s emergency branch mutates `active_balance` but not `shadow`, while `finalize_delinquent_upgrade` assumes `active - shadow` is a well-defined non-negative delinquent residual. That assumption is false if emergency conversion runs on a pending validator during `IteratingValidators`. No recovery path.

### Immunefi impact classification

**High — temporary/permanent freezing of funds (partial):**

- Permanently blocks: `deactivate_stake`, `stake_reserve`, `withdraw_stake_account`, merge/canonical, add/remove validator, emergency/partial unstake.
- Still works: `deposit`, LP, `liquid_unstake`, `order_unstake`/`claim` (claim needs reserve liquidity).
- Not Critical theft/insolvency under overflow-checks (fails closed rather than minting phantom active).
- Not “generic DoS” alone: it is a **state-machine deadlock** with no permissionless recovery, freezing specific fund-moving instructions for the life of the upgrade (i.e., forever if unupgraded).

**Attacker privilege:** does not need Marinade admin/manager keys; needs a stake that force-deactivates during the Validators phase (delinquent validator reality, or validator operator griefing).

**UNVERIFIED on-chain:** requires Anchor local validator replay + stake-program force-deactivate simulation.

---

## H1 — visited_count / stake_count mismatch

### Exact code path

```text
check_delinquent_upgrade_state_progression  # update.rs:274-296
  if visited_count == stake_count():
    require FSM.total_active_balance == validator_system.total_active_balance
    → IteratingValidators { 0, left: total_delinquent_balance }
```

`visited_count` increments on Unknown→Active and on `deposit_stake_account` during IteratingStakes; **never decrements**. `stake_count` decrements on successful `update_deactivated` remove.

### Preconditions (for original stuck claim)

Persist `visited_count > stake_count` or unsatisfiable `visited==count` with permanent balance mismatch.

### Reachability analysis

| Scenario | Outcome |
|----------|---------|
| `visited==count` with balance mismatch | `require_eq` fails → **entire tx reverts** → state not persisted |
| Active emergency remove when it would make `visited==count` | Emergency reduces `total_active` by `amount`; IteratingStakes path sets `delinquent_amount=0` (cooling absorbs) → totals **stay aligned** → **transitions cleanly** to Validators |
| Deposit during IteratingStakes | increments visited and count together |

### State transition / tests

```bash
cd /workspace/stage3-fsm-model && cargo test h1_ -- --nocapture
```

All **PASS**. Notably:

- `h1_emergency_remove_aligns_totals_and_transitions_cleanly` — kills permanent IteratingStakes visited/count deadlock for Active emergency path.
- `h1_visited_eq_count_with_balance_mismatch_cannot_persist_due_to_atomicity` — mismatch cannot persist.

### Result (original H1)

**PROVEN NOT VULNERABLE** as stated (permanent `visited_count`/`stake_count` deadlock inside `IteratingStakes`).

### H1-VARIANT — orphaned Unknown stakes

Same emergency ordering that cleanly transitions can do so **before all Unknown stakes are upgraded**:

```text
Visit A, Visit B (Unknown→Active)
Force-deactivate A + update_deactivated
  → visited==count with aligned totals
  → IteratingValidators while C still Unknown
finalize → Done
update_active(C) → UpgradingInvariantViolation forever
  (update.rs:498-499: only IteratingStakes may upgrade Unknown)
```

Deactivate/withdraw/merge/emergency paths require `StakeStatus::Active` → also blocked for C.

**Test:** `h1_variant_unknown_stake_survives_into_done_and_cannot_upgrade` — **PASS**.

**Impact:** High — permanent inability to crank that stake (rewards stuck on account; cannot Marinade-deactivate). Pool still holds SOL under withdraw PDA; mSOL exits via LP/delayed may continue, but that stake is operationally frozen.

**Classification:** Treat as **related variant of H1/H3 family** (upgrade-window ordering), model-proven; needs on-chain confirmation.

---

# FSM Invariants

| Invariant | Why | Where enforced | How tested | Result |
|-----------|-----|----------------|------------|--------|
| A: `!is_done()` gates stake-moving ops | Prevent mid-migration stake surgery | multiple `require!(is_done())` | code audit | Holds |
| A2: migration must be completable | Liveness | finalize + progression | H3 model | **Violable via H3** |
| B: pending finalize needs `active >= shadow` | `active - shadow` delinquent delta | finalize arithmetic | H3 model | **Violable via H3** |
| C: `visited_count` vs `stake_count` progression | Complete stake pass | `update.rs:281-290` | H1 tests | Holds under atomicity |
| D: deposit during Validators preserves left | live vs snapshot | `deposit_stake_account.rs:155-161` | H5 tests | Holds |
| E: after Done, no Unknown remains | all stakes upgraded or removed | implicit | H1-variant | **Violable** |

---

# Additional Variants

| Variant | Class | Notes |
|---------|-------|-------|
| H1-VARIANT orphaned Unknown | **POTENTIAL / model-proven** | See above |
| Deposit during Validators into pending V | SAFE | shadow and active both increase |
| `update_deactivated` after V finalized | SAFE | H3 second test |
| `set_validator_score` during FSM | SAFE for these hyps | scores only |
| `update_active` during Validators | UNREACHABLE (gated) | — |
| `deactivate_stake` during FSM | UNREACHABLE (`is_done`) | — |

Instructions mutable during `IteratingValidators`: finalize, `update_deactivated`, `deposit_stake_account`, SOL deposit, LP, liquid/delayed unstake, `set_validator_score`, pause (pause auth).

---

# Tooling Limitations

| Item | Status |
|------|--------|
| `rustc` / `cargo` | 1.83.0 — used |
| `anchor` | **not installed** |
| `solana` | **not installed** |
| On-chain/localnet tests | **not executed** |
| Model tests executed | `cargo test` in `stage3-fsm-model/` — **10 passed** |
| Production source | **unchanged** |

**Assumptions:** overflow-checks enabled (matches workspace `Cargo.toml`); emergency path during Validators mirrors `update.rs` (shadow untouched); force-deactivation is a realistic external precondition for H3/H1-variant.

---

# Git Integrity

See final agent response for live `git status` / `git diff --stat`.

Files added (non-production):

- `STAGE3_FSM_MODEL.md`
- `STAGE3_RESULTS.md`
- `stage3-fsm-model/` (Cargo.toml + src/lib.rs)

`liquid-staking-program-main/**` not modified.

---

# Confidence

| ID | Confidence | Note |
|----|------------|------|
| H5 | **High** not vulnerable | Intentional code + passing model |
| H3 | **High** model / **Medium** on-chain impact | Arithmetic proven; needs stake-program local replay for submission-grade PoC |
| H1 (stated) | **High** not vulnerable | Atomicity |
| H1-VARIANT | **High** model / **Medium** on-chain | Same tooling gap |

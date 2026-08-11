# Stage 3 FSM Model — Delinquent Upgrader

**Source of truth:** `liquid-staking-program-main/programs/marinade-finance/src/`  
**Evidence class:** exact quotes / line references = FACT. Model tests = model evidence (not on-chain Anchor execution).

---

## FSM States (FACT)

```rust
// state/delinquent_upgrader.rs:4-15
pub enum DelinquentUpgraderState {
    IteratingStakes {
        visited_count: u32,
        total_active_balance: u64,
        total_delinquent_balance: u64,
    },
    IteratingValidators {
        visited_count: u32,
        delinquent_balance_left: u64,
    },
    Done,
}
```

| State | Meaning |
|-------|---------|
| `IteratingStakes` | Walk stake list; upgrade `StakeStatus::Unknown → Active`; accumulate shadow balances & delinquent residuals |
| `IteratingValidators` | Rewrite each validator `active_balance ← delinquent_upgrader_active_balance` |
| `Done` | Migration complete; stake-moving ops ungated |

**Default** (`delinquent_upgrader.rs:17–24`): `IteratingStakes { 0, 0, 0 }`  
**Fresh initialize** (`initialize.rs:193`): `Done`

**No instruction enters `IteratingStakes`** — inferred start via account-layout default after upgrade.

---

## Variables

| Variable | Meaning | Initial | Incremented by | Decremented by | Compared against | Reset when |
|----------|---------|---------|----------------|----------------|------------------|------------|
| FSM `visited_count` (Stakes) | # of Unknown→Active upgrades + deposits during IteratingStakes | 0 | `update_active` delinquent_upgrade; `deposit_stake_account` | **never** | `stake_system.stake_count()` | transition to Validators (field replaced) |
| FSM `total_active_balance` (Stakes) | Sum of upgraded/deposited delegated amounts (+rewards/−slash) | 0 | upgrade, deposit, rewards | slash | `validator_system.total_active_balance` at progression | replaced on transition |
| FSM `total_delinquent_balance` | Residual deactivated amount not covered by cooling buckets | 0 | `update_deactivated` IteratingStakes path | — | becomes `delinquent_balance_left` | transition |
| FSM `visited_count` (Validators) | Next validator index to finalize | 0 | `finalize_delinquent_upgrade` loop | never | `validator_count()` | Done / rewrite state |
| FSM `delinquent_balance_left` | Remaining delinquent SOL to reconcile via (active−shadow) | = total_delinquent | — | `−=(active−shadow)` per validator | must be 0 at completion | Done |
| `validator.delinquent_upgrader_active_balance` (shadow) | Active stake credited during upgrade for validator | 0 | upgrade/deposit/rewards | slash; zeroed on finalize | `<= active` during stakes | finalize sets 0 |
| `validator.active_balance` | Protocol’s active stake for validator | — | deposits/rewards/stake_reserve… | unstake/slash/emergency/finalize rewrite | — | finalize ← shadow |
| `stake_system.stake_count()` | Length of stake list | — | add stake | `update_deactivated` remove; merge/canonical remove (**Done only**) | FSM visited (Stakes) | — |
| `StakeRecord.last_update_status` | Unknown / Active / Deactivating | Unknown default | →Active on upgrade; →Deactivating on deactivate paths | — | gates update paths | — |

---

## Transitions

### T1 — `update_active` during IteratingStakes / Done

**Auth:** permissionless  
**Blocked when:** `is_iterating_validators()` (`update.rs:310–313`)  
**Requires:** on-chain active (`deactivation_epoch == u64::MAX`); record ≠ `Deactivating`

**If `last_update_status == Unknown`** (`update.rs:475–500`):

```text
last_update_status = Active
MUST be IteratingStakes else UpgradingInvariantViolation
visited_count += 1
FSM.total_active_balance += last_update_delegated_lamports
require FSM.total_active_balance <= validator_system.total_active_balance
shadow += last_update_delegated_lamports
require shadow <= validator.active_balance
```

Then rewards/slash update `active`, `total_active`, and if IteratingStakes also shadow + FSM total.

**Progression** (`update.rs:274–296`):

```text
if visited_count == stake_count():
  require FSM.total_active_balance == validator_system.total_active_balance
  → IteratingValidators { visited_count: 0, delinquent_balance_left: total_delinquent_balance }
```

### T2 — `update_deactivated` (all FSM states)

**Auth:** permissionless  
**No `is_done` / IteratingValidators gate**

**If `last_update_status == Active`** (force-deactivate detection) (`update.rs:569–591`):

```text
require !is_emergency_unstaking
is_emergency_unstaking = true
emergency_cooling_down += amount
total_active_balance -= amount
validator.active_balance -= amount   // shadow NOT adjusted
```

**If IteratingStakes** (`update.rs:653–680`): attribute residual to `total_delinquent_balance`, may `total_active_balance -= delinquent_amount`.  
**Else** (Validators or Done): subtract full amount from cooling bucket.

Then withdraw stake → reserve; remove stake from list; call progression check.

### T3 — `finalize_delinquent_upgrade` (IteratingValidators only)

**Auth:** permissionless (`finalize_delinquent_upgrade.rs:10–18` — no signer)  
**Else:** `UpgradingInvariantViolation`

```text
while cursor < validator_count && max_validators > 0:
  delinquent_balance_left -= (active_balance - delinquent_upgrader_active_balance)
  active_balance = delinquent_upgrader_active_balance
  delinquent_upgrader_active_balance = 0
  cursor += 1

if cursor == validator_count:
  require delinquent_balance_left == 0
  → Done
else:
  persist IteratingValidators { cursor, left }
```

**Critical arithmetic (overflow-checks=true):**  
`(active_balance - delinquent_upgrader_active_balance)` underflows if `active < shadow`.

### T4 — `deposit_stake_account` (all FSM states)

**Auth:** stake authority (user)  
**No `is_done` gate**

```text
validator.active_balance += stake
total_active_balance += stake
match FSM:
  IteratingStakes: visited++; FSM.total+=; shadow+=
  IteratingValidators:
    if validator_index >= visited_count: shadow += stake
    // else shadow already 0 — only active +=  (intentional)
  Done: no shadow
stake list add as Active; mint mSOL for stake−fee
```

---

## Ops allowed during IteratingValidators

| Operation | Allowed? | stake_count | balances | validator set | visited_count |
|-----------|----------|-------------|----------|---------------|---------------|
| `finalize_delinquent_upgrade` | YES | no | rewrites active←shadow | no | + (validators) |
| `update_deactivated` | YES | −1 remove | active/cooling/reserve | no | no |
| `update_active` | **NO** | — | — | — | — |
| `deposit_stake_account` | YES | +1 | active(+shadow if pending) | no | no (validators) |
| `deposit` (SOL) | YES | no | reserve/msol | no | no |
| `liquid_unstake` / LP / order_unstake / claim | YES | no | various | no | no |
| `deactivate_stake` / `stake_reserve` / merge / canonical | **NO** (`is_done`) | — | — | — | — |
| `add/remove_validator` / emergency / partial / withdraw_stake | **NO** (`is_done`) | — | — | — | — |
| `set_validator_score` | YES | no | scores only | no | no |

---

## Gated while `!is_done()` (FACT)

`create_canonical_stake`, `merge_stakes`, `deactivate_stake`, `stake_reserve`, `add_validator`, `remove_validator`, `emergency_unstake`, `partial_unstake`, `withdraw_stake_account`.

Still available: deposits, LP, liquid unstake, delayed unstake order/claim, `update_*`, finalize, `set_validator_score`.

---

## Hypotheses mapped to transitions

| ID | Claim | Key transition |
|----|-------|----------------|
| H5 | Deposit into already-finalized validator breaks finalize | T4 with `validator_index < visited_count` then T3 |
| H3 | `update_deactivated` during Validators breaks finalize | T2 emergency (Active) on pending validator then T3 |
| H1 | Stakes-phase visited/count mismatch permanent stall | T1/T2 progression `visited_count == stake_count` ∧ balance equality |

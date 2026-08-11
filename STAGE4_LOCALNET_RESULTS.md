# Stage 4 Localnet Results

## Executive Verdict

| Hypothesis | Model result | Localnet result | Attacker | Impact | Confidence |
| ---------- | ------------ | --------------- | -------- | ------ | ---------- |
| H3         | MODEL-PROVEN VULNERABLE | BPF path real, but **NON-BOUNTY-GRADE** | Unprivileged actor **cannot** induce required stake deactivation | N/A for bounty | **High** |
| H1-variant | MODEL-PROVEN | **PROVEN NOT VULNERABLE** | N/A (sequence aborts) | None for modeled path | **High** |

### Bounty gate (DeactivateDelinquent feasibility)

**Verdict: H3 is not bounty-grade.** An unprivileged attacker cannot intentionally induce or influence validator delinquency enough to make H3 reachable during a legitimate upgrade/migration window.

See **H3 → Attacker Reachability via DeactivateDelinquent** below.

---

# H3

## Attack Preconditions

1. `state.delinquent_upgrader == IteratingValidators { visited_count, delinquent_balance_left }`
2. At least one validator still pending (`visited_count < validator_count`)
3. Validator shadow `delinquent_upgrader_active_balance` equals (or exceeds) the stake about to be emergency-removed
4. A stake record with `last_update_status == Active` whose native stake account is deactivating/deactivated (`delegation.deactivation_epoch != u64::MAX`)
5. Cool-down complete so `update_deactivated` can withdraw

**How FSM reaches `IteratingValidators`:** production enters via `update_active` / `update_deactivated` completing `IteratingStakes` (`update.rs` `check_delinquent_upgrade_state_progression`). Fresh `initialize` sets `Done`. Localnet used an offline account-byte precondition (upgrade simulation) — **not** a production instruction from `Done`. Stake force-deactivation was simulated by setting `deactivation_epoch = 0` (stand-in for Solana delinquent force-deactivate; Marinade `deactivate_stake` is `is_done()`-gated).

## Exact Production Code Path

1. `UpdateDeactivated::process` (`update.rs:548+`)
2. When `last_update_status == Active` and stake is deactivating (`update.rs:569–591`):
   - `emergency_cooling_down += amount`
   - `validator_system.total_active_balance -= amount`
   - `validator.active_balance -= amount`
   - **does not** adjust `validator.delinquent_upgrader_active_balance`
3. Withdraws stake to reserve, removes stake list entry
4. `FinalizeDelinquentUpgrade::process` (`finalize_delinquent_upgrade.rs:37–38`):
   - `delinquent_balance_left -= active_balance - delinquent_upgrader_active_balance`
   - With `active < shadow`, checked subtraction **panics** (BPF overflow)

## Account Graph

See `STAGE4_ACCOUNT_GRAPH.md`. Callers for both `update_deactivated` and `finalize_delinquent_upgrade` are **permissionless**.

## Localnet Setup

- Solana CLI **1.14.29**, Anchor CLI **0.27.0**, program built from `liquid-staking-program-main` BPF
- `solana-test-validator --slots-per-epoch 32 --warp-slot 200` loading production `.so` + patched accounts
- Harness: `stage4-localnet/` (setup dump → `patch_h3_precondition` → restart → `h3_replay.ts`)
- Production `programs/` **unchanged**

## Transaction Sequence

| Step | Instruction | Success | State Before | State After |
| ---- | ----------- | ------- | ------------ | ----------- |
| T0 | (snapshot) | — | FSM=`IteratingValidators{0,0}`; V0 active=`50000000000` shadow=`50000000000`; stakeCount=1; totalActive=`50000000000` | same |
| T1 | `update_deactivated(0,0)` | **OK** sig `2ABYUH3ya5H2qRNgWojUKDd6pwT9BqoLvEgaLguCG7rxpMCgZnXCfF6bFpARa1KpD39gGEP1wdmPk3GMTg19zFXX` | as T0 | FSM still `IteratingValidators{0,0}`; V0 active=`0` shadow=`50000000000`; stakeCount=`0`; totalActive=`0`; reserve available=`50000000000`; stake account gone |
| T3 | `finalize_delinquent_upgrade(10)` | **FAIL** | as T1 after | **unchanged** (tx aborted) |
| T5 | recovery ixs | fail / partial | stuck | still stuck |

Machine-readable dumps: `stage4-localnet/results/T0_*.json` … `T6_*.json`, `h3_report.json`.

## Finalize Failure

Exact program log:

```text
panicked at 'attempt to subtract with overflow', programs/marinade-finance/src/instructions/crank/finalize_delinquent_upgrade.rs:38:25
Program failed to complete: BPF program panicked
```

## Atomicity Analysis

- T1 **commits**: active/shadow divergence, stake removed, lamports in reserve.
- T3 **does not** roll back T1 (separate transactions).
- Post-failure snapshots T4/T6 match T2 for validator active/shadow and FSM.

## Recovery Attempts

| Instruction | Permissionless? | Result |
| ----------- | --------------- | ------ |
| `finalize_delinquent_upgrade` | yes | FAIL — same overflow panic |
| `update_deactivated` (again) | yes | FAIL — stake account gone |
| `update_active` | yes | FAIL — stake gone / would be blocked in Validators |
| `stake_reserve` | yes | FAIL — `DelinquentUpgraderIsNotDone` (6088) |
| `deposit` (SOL→mSOL) | yes | **OK** |
| `order_unstake` | yes | **OK** |
| `liquid_unstake` | yes | FAIL here only due to empty LP (`InsufficientLiquidity`), not `is_done` |

Gated by `is_done()` in source (not all re-tried on-chain): `deactivate_stake`, `merge_stakes`, `create_canonical_stake`, `add/remove_validator`, `emergency_unstake`, `partial_unstake`, `withdraw_stake_account`.

No permissionless path observed that clears `active < shadow` or advances FSM to `Done`.

## Attacker Requirements

| Role | Required? |
| ---- | --------- |
| Ordinary user / permissionless crank | Can run `update_deactivated` / `finalize` **only if** preconditions already exist |
| Stake account owner | No (Marinade PDA authority) |
| Validator identity / vote key | **Required** to *create* delinquency; unprivileged attacker does not have this for Marinade-set validators |
| Manager / admin / governance | Needed to `add_validator` (and `add_validator` is also `is_done()`-gated) |

### Attacker Reachability via DeactivateDelinquent

Solana `StakeInstruction::DeactivateDelinquent` (1.14.29):

- Permissionless to **invoke**, but only succeeds if the delegated vote has not voted for ≥ `MINIMUM_DELINQUENT_EPOCHS_FOR_DEACTIVATION` (**5 epochs**, ~15 days mainnet)
- Needs a reference vote that *has* voted in that window
- Does **not** let an attacker stop a healthy validator from voting

Unprivileged induction paths:

| Path | Feasible? | Why |
| ---- | --------- | --- |
| Stop someone else’s Marinade validator from voting | **No** | Requires compromise/DoS of validator identity; not a program attacker capability |
| Add own vote to Marinade set, then go offline 5 epochs | **No** | `add_validator` needs `validator_manager_authority` and `is_done()` — blocked in upgrade window; outside window needs manager privilege |
| Wait ~15 days after going delinquent *during* open migration | **No** | Honest permissionless cranks finish `IteratingStakes → finalize → Done` in normal operation long before 5 epochs; attacker cannot hold the window open |
| Race `DeactivateDelinquent` on a vote **already** 5-epoch delinquent still in the set with still-active stake, only after FSM reaches `IteratingValidators` | Not unprivileged-induced | Requires pre-existing operational failure (delinquent validator left in set). Marinade docs note delinquents are score-bot removed under normal ops. Not attacker-manufactured |

H3 needs: stake still `Active` through Stakes crank → then native deactivation **during** `IteratingValidators` → emergency `update_deactivated` → broken finalize. That ordering plus 5-epoch delinquency cannot be created by an unprivileged actor against a normally operated upgrade.

**Conclusion:** BPF bug is real under artificial preconditions; **not an Immunefi-grade unprivileged exploit**. Mark **NON-BOUNTY-GRADE** and stop.

## Funds Affected

1. User mSOL: still mintable via `deposit`; delayed unstake (`order_unstake`) works.
2. Withdrawals via stake-moving / deactivate / withdraw-stake: **blocked** while FSM stuck.
3. Restaking from reserve (`stake_reserve`): **blocked**.
4. Affected stake lamports: **moved to reserve** by T1 (not stolen); cannot be re-delegated while stuck.
5. Scope: **protocol-wide** for `is_done()`-gated ops, not a single-validator-only freeze of those ops.
6. mSOL price accounting: remaining SOL is in reserve (`available_reserve_balance`); price path still sees reserve.
7. Temporary vs permanent: **permanent** under normal permissionless operation (no recovery ix found).
8. Admin recovery: would require privileged account surgery / upgrade — not an in-protocol crank.

## Security Impact

Permanent inability to complete delinquent upgrade and to run stake-management instructions gated by `is_done()`, after a permissionless `update_deactivated` emergency during `IteratingValidators`. User SOL from the deactivated stake sits in reserve; liquid deposit and ticket unstake continue.

## Immunefi Classification

**Out of scope / non-bounty-grade** for unprivileged attacker model: required deactivation cannot be intentionally induced; depends on upgrade window + pre-existing 5-epoch validator delinquency (or equivalent privileged/environmental conditions), not on attacker-controlled Marinade/stake instructions alone.

## Verdict

```text
NON-BOUNTY-GRADE
(BPF path demonstrated under patched preconditions; unprivileged DeactivateDelinquent induction infeasible)
```

### Repeatability

| Run | updateOk | finalize panic | t2 active | t2 shadow | t4 FSM |
| --- | -------- | -------------- | --------- | --------- | ------ |
| 1 | true | true | 0 | 50000000000 | IteratingValidators |
| 2 | true | true | 0 | 50000000000 | IteratingValidators |
| 3 | true | true | 0 | 50000000000 | IteratingValidators |

Source: `stage4-localnet/results/h3_repeatability.json`.

---

# H1-VARIANT

## Attack Preconditions (modeled)

`IteratingStakes` with ≥2 `Unknown` stakes; `update_active` on S0; force-deactivate S0; `update_deactivated(S0)` hoping `visited_count == stake_count` leaves S1 `Unknown`, then finalize to `Done`.

## Exact Production Code Path

`check_delinquent_upgrade_state_progression` (`update.rs:274–291`) requires:

```text
total_active_balance (FSM) == validator_system.total_active_balance
```

before `IteratingStakes → IteratingValidators`.

## Localnet Setup

Two real stakes (50 SOL + 5 SOL), patched to `Unknown` + `IteratingStakes`. Live `update_active(S0)` succeeded (visited=1, FSM total=50e9, S1 still Unknown).

## Transaction Sequence

| Step | Instruction | Success | State Before | State After |
| ---- | ----------- | ------- | ------------ | ----------- |
| T0 | snapshot | — | IteratingStakes{0,0,0}; S0/S1 Unknown | — |
| T1 | `update_active(S0)` | OK | as T0 | IteratingStakes{1,50e9,0}; S0 Active; S1 Unknown |
| T2 | reload S0 `deactivation_epoch=0` | — | as T1 | as T1 |
| T3 | `update_deactivated(S0)` | **FAIL** | as T2 | **unchanged** (atomic abort) |

## Finalize Failure

N/A — never reached Validators/Done via this path.

## Atomicity Analysis

`update_deactivated` logged:

```text
UpgradingInvariantViolation
Left: 50000000000
Right: 5000000000
```

at `update.rs:282`. Emergency reduced `validator_system.total_active_balance` to 5e9 while FSM `total_active_balance` remained 50e9; transition check aborted the whole ix.

## Recovery Attempts

Continuing `update_active` on remaining `Unknown` **succeeds** (observed: both stakes Active, FSM advanced to `IteratingValidators`). Modeled permanent Unknown-after-Done did **not** occur.

## Attacker Requirements

N/A for successful exploit — sequence does not complete.

## Funds Affected

None for this hypothesis on localnet.

## Security Impact

None demonstrated.

## Immunefi Classification

Out of scope / not a vulnerability for the modeled H1-variant path.

## Verdict

```text
PROVEN NOT VULNERABLE
```

---

# TEST EXECUTION LOG

```bash
# Toolchain inventory (Phase 0)
pwd; rustc --version; cargo --version; rustup toolchain list
anchor --version; solana --version; node --version; npm --version
# Installed: solana 1.14.29, anchor 0.27.0 (via rustc 1.68.2), host rust later 1.85 for some tools

# Program build
cd liquid-staking-program-main && anchor build
# → target/deploy/marinade_finance.so

# Setup + dump
solana-test-validator --bpf-program MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD ... --slots-per-epoch 32
cd stage4-localnet/ts && npx tsx setup_and_dump.ts

# H3 patch + replay
/tmp/stage4-ws/target/release/patch_h3_precondition fixtures
# restart validator with --account patched/* --warp-slot 200
npx tsx h3_replay.ts
npx tsx h3_recovery_impact.ts
bash scripts/h3_repeatability.sh 3

# H1
# python offline patch → patched_h1
npx tsx h1_replay_part1.ts   # update_active S0 + mid dump
# patch stake0 deactivation_epoch; reload
npx tsx h1_replay_part2.ts   # update_deactivated fails invariant
```

Failed / notable:

- Initial vote create: withdrawer==identity (fixed with separate identity keypair)
- `ProgramTest` / cargo edition2024 conflicts → abandoned for test-validator path
- `pkill -f solana-test-validator` can kill the controlling shell; use PID kill
- First H3 attempt talked to old validator (patched accounts not loaded); fixed by killing PID 51569
- H1 part1 python `-c` JSON escape failure; patched mid stake via separate python heredoc
- `liquid_unstake` InsufficientLiquidity (empty LP) — not an `is_done` gate
- `patch_h1` rust rebuild hit edition2024 on crates.io; used Python byte patcher instead

---

# ACTUAL OUTPUT

See:

- `stage4-localnet/logs/h3_replay.log`
- `stage4-localnet/logs/h3_recovery.log`
- `stage4-localnet/logs/h3_repeatability_run.log`
- `stage4-localnet/logs/h1_part2.log`
- `stage4-localnet/results/h3_report.json`
- `stage4-localnet/results/h3_recovery_impact.json`
- `stage4-localnet/results/h3_repeatability.json`
- `stage4-localnet/results/h1_report.json`

Critical H3 finalize log (verbatim):

```text
Program log: panicked at 'attempt to subtract with overflow', programs/marinade-finance/src/instructions/crank/finalize_delinquent_upgrade.rs:38:25
Program failed to complete: BPF program panicked
```

---

# GIT INTEGRITY

```bash
git status
git diff --stat
git diff -- liquid-staking-program-main/
```

Expected: **no** changes under `liquid-staking-program-main/programs/`. Only test harness / docs / fixtures / build artifacts.

---

# Caveats (evidence honesty)

1. `IteratingValidators` was established by **offline account patching** (simulating post-upgrade state). No public ix moves `Done → IteratingStakes` on this tree.
2. Native stake deactivation used **byte patch** of `deactivation_epoch`, not live `DeactivateDelinquent`. Withdrawal/emergency semantics then executed in the **real** Marinade BPF on local validator.
3. That is sufficient to prove the emergency+finalize overflow under production instruction code; reaching the preconditions on mainnet still depends on a live delinquent-upgrade window plus external stake deactivation.

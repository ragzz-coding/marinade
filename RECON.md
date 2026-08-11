# Marinade Liquid Staking — Repository Intelligence Report (Read-Only)

**Scope:** local repository inspection only. No exploit attempts. No mainnet/testnet interaction.  
**Generated:** 2026-08-11  
**Workspace git HEAD:** `63a8e961a2c2c0a932f5cc5226b3c9c17deaf331` (`main`: “Add files via upload”)  
**Baseline:** Marinade sources already committed; working tree clean before this report. This report does **not** modify program source.

---

## A. Repository Architecture

### Layout

| Path | Role |
|------|------|
| `/workspace/README.md` | Stub (`# marinade`) |
| `/workspace/liquid-staking-program-main/` | Uploaded Marinade Anchor workspace (official package layout) |
| `…/Anchor.toml` | Anchor 0.27.0 / Solana 1.14.29; program ID; provider cluster `mainnet` |
| `…/Cargo.toml` | Workspace: `programs/*` |
| `…/Cargo.lock` | Locked deps (anchor-lang 0.27.0, solana-program 1.15.2, spl-token 3.5.0) |
| `…/programs/marinade-finance/` | **Only on-chain program crate** |
| `…/programs/marinade-finance/src/lib.rs` | Entrypoint + `#[program]` module |
| `…/programs/marinade-finance/src/state/` | Account/state types |
| `…/programs/marinade-finance/src/instructions/` | Instruction handlers (admin/crank/user/liq_pool/management/delayed_unstake) |
| `…/programs/marinade-finance/src/events/` | Anchor events |
| `…/programs/marinade-finance/src/error.rs` | `MarinadeError` |
| `…/programs/marinade-finance/src/calc.rs` | Share/value math |
| `…/programs/marinade-finance/src/checks.rs` | Account/token checks |
| `…/Docs/Backend-Design.md` | Backend design notes |
| `…/scripts/` | `verify.sh`, `verify-buffer.sh`, `prepare-upgrade.sh` (mainnet verification helpers) |

**Source size:** ~53 `.rs` files; ~7.9k LOC under `programs/marinade-finance/src`.

### Programs present

| Program | Crate | `declare_id!` | Notes |
|---------|-------|---------------|-------|
| Marinade Finance (liquid staking) | `marinade-finance` | `MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD` | Sole program in workspace (`lib.rs:20`) |

`security_txt!` (`lib.rs:23–32`) declares `source_release: "v2.1.0"`.

### Toolchain (declared vs local env)

| Item | Declared in repo | Local cloud env (observed) |
|------|------------------|----------------------------|
| Anchor | `0.27.0` (`Anchor.toml:2`) | **Not installed** (`anchor` missing) |
| Solana | `1.14.29` (`Anchor.toml:3`); lock uses `solana-program 1.15.2` | **Not installed** (`solana` missing) |
| Rust | edition 2021 (`Cargo.toml`) | `rustc 1.83.0` / `cargo 1.83.0` |
| Dependencies | `anchor-lang`/`anchor-spl` 0.27.0; `solana-security-txt` 1.1.1 | Present in `Cargo.lock` only |

### Version / deployment claims (from README, not verified against chain)

From `liquid-staking-program-main/README.md:9–15`:

- **v2.1.0 (2026-07-16):** “fix delinquent stakes and introduce deposit fees”
- Linked as PR [#84](https://github.com/marinade-finance/liquid-staking-program/pull/84) / commit `0f031c4`
- Audit pointer: Neodyme 2026

This tree **contains** delinquent-upgrader + deposit-fee machinery consistent with that release narrative. Exact binary identity with mainnet / commit `3e7c090` is **UNVERIFIED** locally (see §F).

---

## B. Program Entry Points

All instructions live in `#[program] pub mod marinade_finance` (`lib.rs:47–282`).  
Every handler calls `check_context` (`lib.rs:34–44`): program ID must match `declare_id!`; `remaining_accounts` must be empty.

| Instruction | Handler | Module path |
|-------------|---------|-------------|
| `initialize` | `lib.rs:61` | `instructions/admin/initialize.rs` |
| `change_authority` | `lib.rs:68` | `admin/change_authority.rs` |
| `add_validator` | `lib.rs:76` | `management/add_validator.rs` |
| `remove_validator` | `lib.rs:81` | `management/remove_validator.rs` |
| `set_validator_score` | `lib.rs:90` | `management/set_validator_score.rs` |
| `config_validator_system` | `lib.rs:100` | `admin/config_validator_system.rs` |
| `deposit` | `lib.rs:109` | `user/deposit.rs` |
| `deposit_stake_account` | `lib.rs:115` | `user/deposit_stake_account.rs` |
| `liquid_unstake` | `lib.rs:123` | `liq_pool/liquid_unstake.rs` |
| `add_liquidity` | `lib.rs:128` | `liq_pool/add_liquidity.rs` |
| `remove_liquidity` | `lib.rs:133` | `liq_pool/remove_liquidity.rs` |
| `config_lp` | `lib.rs:138` | `admin/config_lp.rs` |
| `config_marinade` | `lib.rs:143` | `admin/config_marinade.rs` |
| `order_unstake` | `lib.rs:159` | `delayed_unstake/order_unstake.rs` |
| `claim` | `lib.rs:164` | `delayed_unstake/claim.rs` |
| `stake_reserve` | `lib.rs:169` | `crank/stake_reserve.rs` |
| `update_active` | `lib.rs:174` | `crank/update.rs` (`UpdateActive`) |
| `update_deactivated` | `lib.rs:182` | `crank/update.rs` (`UpdateDeactivated`) |
| `deactivate_stake` | `lib.rs:191` | `crank/deactivate_stake.rs` |
| `emergency_unstake` | `lib.rs:200` | `management/emergency_unstake.rs` |
| `partial_unstake` | `lib.rs:209` | `management/partial_unstake.rs` |
| `merge_stakes` | `lib.rs:220` | `crank/merge_stakes.rs` |
| `create_canonical_stake` | `lib.rs:231` | `crank/create_canonical_stake.rs` |
| `pause` / `resume` | `lib.rs:241` / `247` | `admin/emergency_pause.rs` |
| `withdraw_stake_account` | `lib.rs:253` | `user/withdraw_stake_account.rs` |
| `realloc_validator_list` | `lib.rs:265` | `admin/realloc_validator_list.rs` |
| `realloc_stake_list` | `lib.rs:270` | `admin/realloc_stake_list.rs` |
| `finalize_delinquent_upgrade` | `lib.rs:275` | `crank/finalize_delinquent_upgrade.rs` |

**Permission summary (high level):**

| Class | Signer / authority | Examples |
|-------|--------------------|----------|
| Admin | `state.admin_authority` | `change_authority`, `config_*`, `realloc_*` |
| Pause | `state.pause_authority` | `pause`, `resume` |
| Validator manager | `state.validator_system.manager_authority` | `add/remove/set_score`, `emergency_unstake`, `partial_unstake`, `config_validator_system` |
| Permissionless / crank / user | fee payer / token owner; many cranks need no privileged authority | `deposit`, `update_*`, `merge_stakes`, `finalize_delinquent_upgrade`, `stake_reserve`, `create_canonical_stake` |

---

## C. Relevant State Accounts

### Primary account: `State` (`state/mod.rs:28–102`)

Key fields:

| Field | Type | Lines | Notes |
|-------|------|-------|-------|
| `msol_mint` | `Pubkey` | 31 | mSOL mint |
| `admin_authority` | `Pubkey` | 33 | Admin |
| `operational_sol_account` | `Pubkey` | 36 | Rent/ops SOL sink |
| `treasury_msol_account` | `Pubkey` | 39 | Fee destination (soft-validated) |
| `reserve_bump_seed` / `msol_mint_authority_bump_seed` | `u8` | 42–43 | PDAs |
| `reward_fee` | `Fee` | 48 | Protocol reward fee |
| `stake_system` | `StakeSystem` | 50 | Stake list + cooling-down |
| `validator_system` | `ValidatorSystem` | 51 | Validator list + totals |
| `liq_pool` | `LiqPool` | 58 | LP params + virtual supply |
| `available_reserve_balance` | `u64` | 59 | Virtual reserve (aligned by update) |
| `msol_supply` | `u64` | 60 | Virtual mSOL supply |
| `msol_price` | `u64` | 62 | FE price |
| `circulating_ticket_*` | `u64` | 65–67 | Delayed-unstake tickets |
| `emergency_cooling_down` | `u64` | 73 | Emergency unstake cooling |
| `pause_authority` / `paused` | | 76–77 | Emergency pause |
| `delayed_unstake_fee` / `withdraw_stake_account_fee` | `FeeCents` | 83–89 | User fees |
| `withdraw_stake_account_enabled` | `bool` | 90 | Feature flag |
| `last_stake_move_epoch` / `stake_moved` / `max_stake_moved_per_epoch` | | 95–97 | Stake-move cap |
| `delinquent_upgrader` | `DelinquentUpgraderState` | 98 | Post-upgrade migration FSM |
| `deposit_sol_fee` / `deposit_stake_account_fee` | `FeeCents` | 100–101 | v2.1.0 deposit fees |

Accounting helpers: `total_lamports_under_control` (`mod.rs:213`), `total_virtual_staked_lamports` (`229`), `calc_msol_from_lamports` / `msol_to_sol` (`236–251`), `stake_delta` (`254`).

### `DelinquentUpgraderState` (`state/delinquent_upgrader.rs:4–15`)

```
IteratingStakes { visited_count, total_active_balance, total_delinquent_balance }
  → IteratingValidators { visited_count, delinquent_balance_left }
  → Done
```

- `Default` = `IteratingStakes { 0,0,0 }` (`delinquent_upgrader.rs:17–24`) — relevant for **post-upgrade account expansion**.
- Fresh `initialize` sets `Done` (`initialize.rs:193`).

### `StakeSystem` / `StakeRecord` / `StakeStatus` (`state/stake_system.rs`)

| Type | Fields / values | Lines |
|------|-----------------|-------|
| `StakeStatus` | `Unknown`, `Active`, `Deactivating` | 11–15 |
| `StakeRecord` | `stake_account`, `last_update_delegated_lamports`, `last_update_epoch`, `is_emergency_unstaking`, `last_update_status` | 34–45 |
| `StakeSystem` | `stake_list`, `delayed_unstake_cooling_down`, deposit/withdraw bumps, stake-delta params, `min_stake` | 107–125 |

Comment at `stake_system.rs:39–44` documents Solana’s ability to deactivate delinquent stake **without** Marinade signature — motivation for `last_update_status`.

### `ValidatorSystem` / `ValidatorRecord` (`state/validator_system.rs`)

| Type | Notable fields | Lines |
|------|----------------|-------|
| `ValidatorRecord` | `validator_account`, `active_balance`, `score`, `last_stake_delta_epoch`, `duplication_flag_bump_seed`, **`delinquent_upgrader_active_balance`** | 9–18 |
| `ValidatorSystem` | `validator_list`, `manager_authority`, `total_validator_score`, `total_active_balance` | 116–124 |

### Other accounts

| Account | Path | Purpose |
|---------|------|---------|
| `TicketAccountData` | `state/delayed_unstake_ticket.rs:5–10` | Delayed-unstake claim ticket |
| `StakeList` / `ValidatorList` | discriminators `staker__` / `validatr` | List headers; body written manually |
| `LiqPool` | `state/liq_pool.rs:6–27` | LP mint/legs/fees/caps |
| `Fee` / `FeeCents` | `state/fee.rs` | Fee math |

### PDA seeds (program-owned)

| PDA | Seeds | Definition |
|-----|-------|------------|
| Reserve | `[state, b"reserve"]` | `State::RESERVE_SEED` (`mod.rs:107`), `find_reserve_address` (`145`) |
| mSOL mint authority | `[state, b"st_mint"]` | `MSOL_MINT_AUTHORITY_SEED` (`108`), `find_msol_mint_authority` (`138`) |
| Canonical stake | `[state, validator, b"canonical_stake"]` | `CANONICAL_STAKE_SEED` (`109`), `find_canonical_stake_address` (`149`) |
| Stake withdraw authority | `[state, b"withdraw"]` | `StakeSystem::STAKE_WITHDRAW_SEED` (`128`) |
| Stake deposit authority | `[state, b"deposit"]` | `STAKE_DEPOSIT_SEED` (`129`) |
| Validator duplication flag | `[state, b"unique_validator", validator]` | `ValidatorRecord::DUPLICATE_FLAG_SEED` (`22`) |
| LP mint authority | `[state, b"liq_mint"]` | `LiqPool::LP_MINT_AUTHORITY_SEED` (`30`) |
| LP SOL leg | `[state, b"liq_sol"]` | `SOL_LEG_SEED` (`31`) |
| LP mSOL leg authority | `[state, b"liq_st_sol_authority"]` | (`32`) |
| Default list accounts | `create_with_seed(state, "stake_list"|"validator_list", program)` | `mod.rs:160–166` |

---

## D. Relevant Instructions (security-sensitive surface)

### Delinquent / upgrade path (highest priority for later phases)

| Instruction | File | Role |
|-------------|------|------|
| `update_active` | `crank/update.rs:307+` | Rewards; **`delinquent_upgrade`** for `Unknown→Active`; blocks if `IteratingValidators` |
| `update_deactivated` | `crank/update.rs:548+` | Withdraw deactivated stake; **detects Active→native-deactivated as emergency**; delinquent accounting when `IteratingStakes` |
| `finalize_delinquent_upgrade` | `crank/finalize_delinquent_upgrade.rs` | Walk validators; set `active_balance = delinquent_upgrader_active_balance`; require `delinquent_balance_left == 0` to reach `Done` |
| `check_delinquent_upgrade_state_progression` | `update.rs:274–296` | When all stakes visited under `IteratingStakes`, transit to `IteratingValidators` |

**Gates requiring `delinquent_upgrader.is_done()`** (block ops until migration finishes):

| Instruction | File:line |
|-------------|-----------|
| `create_canonical_stake` | `create_canonical_stake.rs:69` |
| `merge_stakes` | `merge_stakes.rs:72` |
| `deactivate_stake` | `deactivate_stake.rs:97` |
| `stake_reserve` | `stake_reserve.rs:99` |
| `add_validator` | `add_validator.rs:53` |
| `remove_validator` | `remove_validator.rs:50` |
| `emergency_unstake` | `emergency_unstake.rs:54` |
| `partial_unstake` | `partial_unstake.rs:91` |
| `withdraw_stake_account` | `withdraw_stake_account.rs:117` |

**Still allowed / special during upgrade:**

- `deposit_stake_account` adjusts delinquent counters (`deposit_stake_account.rs:143+`)
- `update_active` / `update_deactivated` drive the FSM
- `finalize_delinquent_upgrade` (permissionless; only needs `state` + `validator_list`)

### Value flow (SOL / mSOL / stake)

| Flow | Instructions | CPI / token ops |
|------|--------------|-----------------|
| SOL → mSOL | `deposit` | System transfer → reserve; mint mSOL; deposit fee |
| Stake → mSOL | `deposit_stake_account` | Authorize stake to Marinade; mint mSOL; fee |
| mSOL → SOL (instant) | `liquid_unstake` | Burn mSOL; transfer from LP SOL leg |
| mSOL → ticket → SOL | `order_unstake`, `claim` | Burn mSOL; later SOL from reserve |
| mSOL → stake | `withdraw_stake_account` | Burn mSOL; split/transfer stake |
| Rewards / price | `update_active`, `update_deactivated` | Stake withdraw to reserve; mint reward fee to treasury |
| Stake-out / restake | `deactivate_stake`, `stake_reserve`, `emergency_unstake`, `partial_unstake` | Stake deactivate/split/delegate |
| Canonicalization | `create_canonical_stake`, `merge_stakes` | Split to PDA / merge stakes |

### Errors unique to delinquent/canonical path (`error.rs`)

| Code | Name | Line |
|------|------|------|
| 6087 | `UpgradingInvariantViolation` | 274–275 |
| 6088 | `DelinquentUpgraderIsNotDone` | 277–278 |
| 6089 | `CanonicalStakeAccountAlreadyCreated` | 280–281 |
| 6090 | `InvalidCanonicalStakeAccountAddress` | 283–284 |
| 6091–6092 | Deposit fee too high | 286–290 |

---

## E. Relevant Tests

**None in this repository.**

- README (`README.md:36–37`): “integration tests are not included in this repo. Tests will be published later.”
- No `tests/`, `*-test.rs`, or Anchor TS test suite found under `liquid-staking-program-main/`.
- Scripts only verify against **mainnet** program buffer (`scripts/verify.sh` runs `anchor verify … --provider.cluster mainnet`) — **out of bounty local scope**; do not run against live networks for research.

**Implication:** local PoCs will require bringing or authoring a local validator / Bankrun / LiteSVM harness outside this tree (or obtaining Marinade’s unpublished tests).

---

## F. Relevant Commits / Known-Issue Boundary

### Workspace git (this Cursor clone)

| Commit | Message |
|--------|---------|
| `2ba82c3` | Initial commit |
| `63a8e96` | Add files via upload ← **current tree** |

**There is no Marinade upstream git history** in this workspace. Commits `3e7c090`, `0f031c4`, and PR #84 are **not** present as git objects.

### Upstream claims (documentation only)

| Reference | Source | Status here |
|-----------|--------|-------------|
| Immunefi known issue: “Deactive delinquent handled only after commit `3e7c090`” | Bounty scope | **Cannot diff** against `3e7c090` locally |
| README v2.1.0 / PR #84 / `0f031c4` | `README.md:9–11` | Tree **includes** delinquent upgrader + deposit fees + `finalize_delinquent_upgrade` — consistent with post-fix code |
| `source_release: "v2.1.0"` | `lib.rs:30` | Matches README narrative |

### What this tree appears to implement (post–known-issue fix shape)

Evidence (code present, not a vulnerability claim):

1. `StakeStatus` including `Unknown` for pre-upgrade records (`stake_system.rs:11–15`).
2. `DelinquentUpgraderState` three-phase FSM (`delinquent_upgrader.rs`).
3. `update_deactivated` path treating unexpected deactivation of `Active` stakes as emergency unstake (`update.rs:569–591`).
4. During `IteratingStakes`, “missing” stake vs cooling-down buckets attributed to `total_delinquent_balance` (`update.rs:652–680`).
5. `finalize_delinquent_upgrade` reconciles per-validator `active_balance` to `delinquent_upgrader_active_balance` (`finalize_delinquent_upgrade.rs:37–65`).
6. Many mutating instructions gated on `is_done()` (see §D).

**Cannot confirm** without upstream history whether this snapshot equals commit `3e7c090`, `0f031c4`, or a later tip. File hashes for identity tracking:

| File | SHA-256 |
|------|---------|
| `src/lib.rs` | `835940481d2a5b1748519d5f2125e0c6de6f5c650c606f95e301302f1178e75e` |
| `state/delinquent_upgrader.rs` | `5e2056c040a66116fd262e34567fe3507f2d998704267ba056ceadadc020d8b0` |
| `instructions/crank/update.rs` | `ea79aba1619a0fbee1ec5d327c673dfa55ce5789c679e2db75401ad1198ee0b1` |
| `instructions/crank/finalize_delinquent_upgrade.rs` | `6489923c88418b3d3042ca5e2429be8b9b149ecae12ddc9126e90ea728fff6f6` |

---

## G. Local Test / Fork Setup

| Capability | Status |
|------------|--------|
| Anchor CLI | Missing |
| Solana CLI / local validator | Missing |
| Integration tests | Absent |
| Fixtures / localnet scripts | Absent (only mainnet verify scripts) |
| `Anchor.toml` programs.localnet | ID `MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD` |
| Provider cluster | Set to `mainnet` — **do not use for bounty testing** |

**To run local PoCs later (not done in this phase):** install Anchor 0.27 / Solana toolchain matching `Anchor.toml`, add a local test harness, never point at mainnet/public testnet or third-party oracles.

---

## H. Important Dependencies

| Crate | Version (Cargo.lock) | Use |
|-------|----------------------|-----|
| `anchor-lang` | 0.27.0 | Accounts, CPI, errors |
| `anchor-spl` | 0.27.0 (features: stake, mint, spl-token, token) | Stake + SPL token CPI |
| `solana-program` | 1.15.2 (transitive) | Runtime |
| `spl-token` | 3.5.0 | Token program |
| `solana-security-txt` | 1.1.1 | On-chain security metadata |

Release profile: `overflow-checks = true` (workspace + package `Cargo.toml`).

External programs invoked via CPI (from instruction modules): **System Program**, **Stake Program**, **SPL Token**. No oracle / third-party DeFi CPI in this crate.

---

## I. Important Assumptions (from code — not exploit claims)

Documented for later invariant work; **not** asserted as bugs.

1. **Delinquent deactivation is external.** Solana stake program can deactivate without Marinade auth (`stake_system.rs:39–44`); Marinade discovers this on `update_deactivated` when `last_update_status == Active` (`update.rs:569+`).

2. **Post-upgrade migration is crank-driven.** New fields default to `IteratingStakes` (`delinquent_upgrader.rs:Default`); progress depends on callers repeatedly invoking `update_*` then `finalize_delinquent_upgrade`.

3. **Ordering assumptions.**  
   - `update_active` forbidden while `IteratingValidators` (`update.rs:310–312`).  
   - Stake iteration completion auto-transitions to validator iteration (`update.rs:281–290`).  
   - Many stake-moving ops require `Done`.

4. **Virtual vs real balances.** `available_reserve_balance` and `msol_supply` are virtual and realigned on update (`State` comments `mod.rs:59–60`); treasury mSOL may be invalid and fees skipped (`get_treasury_msol_balance`, `mod.rs:171–205`).

5. **Canonical stake uniqueness.** One PDA per `(state, validator)`; creation fails if owner already stake program (`create_canonical_stake.rs:84–88`).

6. **Index/account binding.** Stake and validator list entries are checked against passed pubkeys via `get_checked` (`stake_system.rs:223`, `validator_system.rs:237`).

7. **Emergency pause** blocks many ops via `require!(!paused)` (pattern across instructions).

8. **No in-repo proof** that this source matches the deployed mainnet binary or Immunefi-scoped commit; verification scripts target live mainnet and are out of scope for this research environment.

---

## Security-Sensitive Areas (inventory only — no exploitation)

Flagged for **later** surgical review (Phase 2+), without claiming impact:

1. Delinquent upgrader FSM completeness / early finalize / counter divergence (`update.rs`, `finalize_delinquent_upgrade.rs`, `deposit_stake_account.rs`).
2. `update_deactivated` emergency conversion + cooling-down vs `total_delinquent_balance` accounting (`update.rs:569–690`).
3. Permissionless cranks: `finalize_delinquent_upgrade`, `merge_stakes`, `create_canonical_stake`, `update_*`, `stake_reserve`.
4. mSOL mint/burn vs `msol_supply` / `total_virtual_staked_lamports` conservation (`deposit*`, `order_unstake`, `liquid_unstake`, `withdraw_stake_account`, reward minting).
5. Canonical stake PDA derivation vs merge/split paths.
6. Stake-move epoch caps and manager-gated emergency/partial unstake.
7. Deposit fee application paths (v2.1.0).

---

## Recommended Next Step (for investigation triage)

1. Decide whether to fetch upstream git history **read-only** into a separate clone to diff `3e7c090^..3e7c090` / PR #84 against this tree (still no mainnet interaction).
2. Install local Anchor/Solana toolchain matching `Anchor.toml` for local-only builds/tests.
3. Proceed to **STATE_INVENTORY.md** / state-machine reconstruction for the delinquent upgrader + stake status machines — still no exploit attempts until invariants are mapped.

---

*End of Phase-1 / repository intelligence report. No program source modified. No network testing performed.*

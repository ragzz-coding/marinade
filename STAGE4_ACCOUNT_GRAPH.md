# Stage 4 — Account Graph (from source)

Exact `#[derive(Accounts)]` constraints. No inferred PDAs.

## `update_deactivated` (`UpdateDeactivated` + `UpdateCommon`)

Source: `instructions/crank/update.rs:24–118`

| Account | Derivation / Constraint | Writable | Signer | Authority | Notes |
|---------|-------------------------|----------|--------|-----------|-------|
| `state` | `has_one = treasury_msol_account`, `has_one = msol_mint` | mut | no | — | Box\<State\> |
| `stake_list` | `address = state.stake_system.stake_list.account` | mut | no | — | |
| `stake_account` | StakeAccount | mut | no | — | Must match list index |
| `stake_withdraw_authority` | seeds=`[state, b"withdraw"]`, bump=`state.stake_system.stake_withdraw_bump_seed` | no | no | PDA | |
| `reserve_pda` | seeds=`[state, b"reserve"]`, bump=`state.reserve_bump_seed` | mut | no | PDA | SystemAccount |
| `msol_mint` | Mint | mut | no | — | |
| `msol_mint_authority` | seeds=`[state, b"st_mint"]`, bump=`state.msol_mint_authority_bump_seed` | no | no | PDA | |
| `treasury_msol_account` | Unchecked; checked soft in code | mut | no | — | |
| `clock` | Sysvar | no | no | — | |
| `stake_history` | `address = stake_history::ID` | no | no | — | |
| `stake_program` | Program\<Stake\> | no | no | — | |
| `token_program` | Program\<Token\> | no | no | — | |
| `validator_list` | `address = state.validator_system.validator_list.account` (**inside `UpdateCommon`**) | mut | no | — | |
| `operational_sol_account` | `address = common.state.operational_sol_account` (UpdateDeactivated only) | mut | no | — | |
| `system_program` | Program\<System\> (UpdateDeactivated only) | no | no | — | |

**Caller:** permissionless (no Marinade authority signer).  
**Args:** `stake_index: u32`, `validator_index: u32`.

Note: `validator_list` is part of `UpdateCommon` in source (`update.rs:80–84`), nested under `common` in the IDL — not a sibling-only account on `UpdateDeactivated`.

---

## `update_active` (`UpdateActive` → `UpdateCommon`)

Same accounts as `UpdateCommon` only (no operational_sol / system_program).  
**Blocked when** `delinquent_upgrader.is_iterating_validators()` (`update.rs:310–313`).

---

## `finalize_delinquent_upgrade`

Source: `finalize_delinquent_upgrade.rs:10–18`

| Account | Derivation / Constraint | Writable | Signer | Authority |
|---------|-------------------------|----------|--------|-----------|
| `state` | Account\<State\> | mut | no | — |
| `validator_list` | `address = state.validator_system.validator_list.account` | mut | no | — |

**Caller:** permissionless. **Args:** `max_validators: u32`.

---

## `deposit_stake_account`

Source: `deposit_stake_account.rs:16–71`

| Account | Constraint | Writable | Signer |
|---------|------------|----------|--------|
| `state` | `has_one = msol_mint` | mut | no |
| `validator_list` | address from state | mut | no |
| `stake_list` | address from state | mut | no |
| `stake_account` | StakeAccount | mut | no |
| `stake_authority` | — | no | **yes** |
| `duplication_flag` | Unchecked mut | mut | no |
| `rent_payer` | owner=system | mut | **yes** |
| `msol_mint` | Mint | mut | no |
| `mint_to` | `token::mint = state.msol_mint` | mut | no |
| `msol_mint_authority` | seeds=`[state, b"st_mint"]`, bump from state | no | no |
| `clock`, `rent` | sysvars | no | no |
| `system_program`, `token_program`, `stake_program` | programs | no | no |

---

## PDA seeds (State / StakeSystem)

| PDA | Seeds | Source |
|-----|-------|--------|
| reserve | `[state, b"reserve"]` | `State::RESERVE_SEED` |
| mSOL mint authority | `[state, b"st_mint"]` | `State::MSOL_MINT_AUTHORITY_SEED` |
| stake withdraw | `[state, b"withdraw"]` | `StakeSystem::STAKE_WITHDRAW_SEED` |
| stake deposit | `[state, b"deposit"]` | `StakeSystem::STAKE_DEPOSIT_SEED` |
| canonical stake | `[state, validator, b"canonical_stake"]` | `State::CANONICAL_STAKE_SEED` |
| validator dup flag | `[state, b"unique_validator", validator]` | `ValidatorRecord::DUPLICATE_FLAG_SEED` |

---

## FSM reachability (production)

| Path | How |
|------|-----|
| Fresh `initialize` | `delinquent_upgrader = Done` (`initialize.rs:193`) |
| Enter `IteratingStakes` | **No instruction** — `Default` + account-layout upgrade |
| `IteratingStakes → IteratingValidators` | `check_delinquent_upgrade_state_progression` after `update_active` / `update_deactivated` when `visited_count == stake_count` and totals match |
| `IteratingValidators → Done` | `finalize_delinquent_upgrade` when all validators processed and `left == 0` |

**Localnet implication:** Reaching `IteratingValidators` on a fresh deploy requires either (a) simulating post-upgrade account bytes via `ProgramTest::set_account` / bank patch, or (b) an unavailable production instruction. Stage 4 uses (a) **only for precondition setup**, then executes **real BPF** for `update_deactivated` + `finalize_delinquent_upgrade`.

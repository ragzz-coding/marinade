# STAGE5_ATTACK_SURFACE — Marinade User / LiqPool / Delayed-Unstake Paths

Marinade liquid-staking program. Attacker-first. Closed: H3/H5/H1/H1-variant.

## 0. Full instruction classification

| Instruction | Class | Signer(s) | Notes |
|-------------|-------|-----------|-------|
| `initialize` | Admin setup | creator | FSM=`Done` |
| `change_authority` / `config_*` / `realloc_*` | Admin | `admin_authority` | |
| `pause` / `resume` | Pause | `pause_authority` | |
| `add/remove_validator` / `set_validator_score` / `config_validator_system` / `emergency_unstake` / `partial_unstake` | Manager | `manager_authority` | several also `is_done()` |
| `deposit` / `deposit_stake_account` / `liquid_unstake` / `add_liquidity` / `remove_liquidity` / `order_unstake` / `withdraw_stake_account` | User | user/token/stake auths | |
| `claim` | Permissionless | none | beneficiary fixed |
| `stake_reserve` / `deactivate_stake` / `update_active` / `update_deactivated` / `merge_stakes` / `create_canonical_stake` / `finalize_delinquent_upgrade` | Permissionless crank | rent payer or none | see constraints |

**Bounty surface** = User + Permissionless. Manager/Admin out of model.

### PDA seeds (quick ref)

| PDA | Seeds |
|-----|-------|
| reserve | `[state, b"reserve"]` |
| mSOL mint auth | `[state, b"st_mint"]` |
| stake deposit/withdraw | `[state, b"deposit"]` / `[state, b"withdraw"]` |
| LP sol leg | `[state, b"liq_sol"]` |
| LP mSOL leg auth | `[state, b"liq_st_sol_authority"]` |
| dup flag | `[state, b"unique_validator", vote]` |
| canonical stake | `[state, validator, b"canonical_stake"]` |

Crank stake/validator binding: `get_checked` / `check_stake_amount_and_validator` — unprivileged index substitution does not corrupt accounting.

---
## Shared primitives (pricing / checks)

### `calc.rs`
| Fn | Behavior | Lines |
|----|----------|-------|
| `proportional(amount, num, den)` | `amount*num/den` as u128→u64; **if `den==0` returns `amount`** | 11–17 |
| `value_from_shares` | alias of proportional | 20–22 |
| `shares_from_value` | if `total_shares==0` → `value`; else proportional | 24–31 |

### `state/mod.rs` pricing & hooks
| Fn | Formula / effect | Lines |
|----|------------------|-------|
| `total_lamports_under_control` | `total_active_balance + cooling_down + available_reserve_balance` (**excludes liq-pool SOL**) | 212–217 |
| `total_virtual_staked_lamports` | `under_control.saturating_sub(circulating_ticket_balance)` | 229–233 |
| `calc_msol_from_lamports` | `shares_from_value(lamports, virtual, msol_supply)` | 236–242 |
| `msol_to_sol` | `value_from_shares(msol, virtual, msol_supply)` | 245–251 |
| `on_transfer_to/from_reserve` | `available_reserve_balance ±=` | 276–282 |
| `on_msol_mint/burn` | `msol_supply ±=` | 284–290 |
| `get_treasury_msol_balance` | Soft-fail: wrong owner/mint → `None` (fees skipped to treasury, not to user) | 171–206 |
| `check_staking_cap` | `under_control + x <= staking_sol_cap` | 219–227 |

### `checks.rs`
| Fn | Role | Lines |
|----|------|-------|
| `check_token_source_account` | Owner **or** delegate; amount ≤ balance/delegated | 135–159 |
| `check_stake_amount_and_validator` | Delegation voter + `delegation.stake == last_update` | 90–115 |

**Pause:** every instruction below starts with `require!(!state.paused)` (pause_authority-gated elsewhere).

---

## 1. `deposit` — SOL → mSOL

| Field | Detail |
|-------|--------|
| **Authority class** | user-signer (SOL payer) / permissionless w.r.t. protocol roles |
| **Required signers** | `transfer_from` |
| **Key constraints** | `state.has_one = msol_mint`; LP sol_leg PDA `[state, b"liq_sol"]`; `liq_pool_msol_leg.address = state.liq_pool.msol_leg`; msol_leg_authority PDA; reserve PDA `[state, b"reserve"]`; `mint_to.token::mint = state.msol_mint`; mint authority PDA `[state, b"st_mint"]` |
| **Mutable** | `state`, `msol_mint`, `liq_pool_sol_leg_pda`, `liq_pool_msol_leg`, `reserve_pda`, `transfer_from`, `mint_to` |
| **CPIs** | SPL `transfer` (LP mSOL→user); System `transfer` (user→LP and/or user→reserve); SPL `mint_to` |
| **Arithmetic** | `sol_fees = deposit_sol_fee.apply(lamports)` `fee.rs:109–112`; `buy = calc_msol(lamports - fees)` `deposit.rs:120–122`; `msol_swapped = min(buy, msol_leg)`; **full fill:** `sol_swapped = lamports` (fee SOL stays in LP) `137–139`; **partial:** `sol_swapped = msol_to_sol(msol_swapped)` `143`; `sol_deposited = lamports - sol_swapped` → reserve + `on_transfer_to_reserve`; `msol_minted = buy - msol_swapped` + `on_msol_mint` `202–223` |
| **Attacker inputs** | `lamports`; `mint_to` ATA (any); which `state` |
| **Invariants claimed** | `msol_mint.supply <= state.msol_supply` `110–114`; staking cap only on **reserve** portion `186`; LP self-rebalance “sell mSOL for SOL at price, no swap fee” (comments 125–127) |
| **Gaps** | **No `liquidity_sol_cap` check** on SOL entering LP via swap (unlike `add_liquidity`). Full-fill path sends **gross** `lamports` into LP while minting/swapping only net-of-fee mSOL (fee → LPs). `mint_to` owner unconstrained (donation). |

---

## 2. `deposit_stake_account` — Stake → mSOL

| Field | Detail |
|-------|--------|
| **Authority class** | user-signer (stake authority + rent payer) |
| **Required signers** | `stake_authority`, `rent_payer` |
| **Key constraints** | `state.has_one = msol_mint`; validator/stake lists by `address = state.*_list.account`; `mint_to.token::mint = msol_mint`; mint authority PDA; `stake_account` Stake program account |
| **Mutable** | `state`, lists, `stake_account`, `duplication_flag`, `rent_payer`, `msol_mint`, `mint_to` |
| **CPIs** | Stake `set_lockup` (optional), `authorize` Staker→deposit PDA, Withdrawer→withdraw PDA; SPL `mint_to` |
| **Arithmetic** | Require active (`deactivation_epoch == MAX`), `WAIT_EPOCHS = 0` `74–106`; lamports == stake + rent `118–122`; `validator.active_balance += stake`; `sol_fees = deposit_stake_account_fee.apply(stake)` `278`; `msol = calc_msol(stake - fees)` `280–282`; `on_msol_mint`; **then** `total_active_balance += stake` (full, not net fee) `305` |
| **Attacker inputs** | `validator_index`; stake account; `mint_to`; `duplication_flag` (**unused in `process`**) |
| **Invariants** | Cannot redeposit Marinade-controlled stake `191–195`, `246–250`; lockup not in force `128–132`; staking cap on `delegation.stake` `124` |
| **Gaps** | `WAIT_EPOCHS=0` accepts same-epoch activating/redelegated stake (docs historically warned against epoch-boundary deposit attack; fee defaults to **0** at init `initialize.rs:188`). Delinquent FSM hooks present—**out of scope**. `duplication_flag` is dead account surface. |

---

## 3. `liquid_unstake` — mSOL → SOL via LP

| Field | Detail |
|-------|--------|
| **Authority class** | user-signer (mSOL owner or delegate) |
| **Required signers** | `get_msol_from_authority` |
| **Key constraints** | `state.has_one = {treasury_msol_account, msol_mint}`; sol_leg PDA; `msol_leg.address = state.liq_pool.msol_leg`; `get_msol_from.token::mint = msol_mint`; `transfer_sol_to: SystemAccount` (any system wallet) |
| **Mutable** | `state`, `msol_mint`, sol_leg, msol_leg, treasury, `get_msol_from`, `transfer_sol_to` |
| **CPIs** | System transfer sol_leg→user (PDA signer); SPL transfer user→msol_leg; optional SPL transfer user→treasury |
| **Arithmetic** | `user_remove = msol_to_sol(msol_amount)` `81`; fee = `lp_max_fee` if draining all available else `linear_fee(after)` `82–88` / `liq_pool.rs:67–76`; `msol_fee = fee.apply(msol_amount)` `91`; `working = msol_to_sol(msol_amount - msol_fee)` `96`; liquidity check `99–103`; `treasury_cut = treasury_cut.apply(msol_fee)` or **0 if treasury `None`** `131–135`; transfer `msol_amount - cut` to LP, `cut` to treasury `138–164` |
| **Attacker inputs** | `msol_amount`; destination SOL account; treasury account must match state (has_one) |
| **Invariants** | LP SOL value non-decreasing for LPs (fee mSOL retained); does **not** change `msol_supply` / `total_virtual_*` (LP outside stake TVL) |
| **Gaps** | Delegate can redirect SOL to any system account (same power as transferring mSOL). Invalid treasury → cut=0 → **fee still paid** (stays in LP). No mSOL burn. |

---

## 4. `add_liquidity` — SOL → LP shares

| Field | Detail |
|-------|--------|
| **Authority class** | user-signer |
| **Required signers** | `transfer_from` |
| **Key constraints** | `lp_mint.address = state.liq_pool.lp_mint`; lp mint authority PDA; `msol_leg.address`; sol_leg PDA; `mint_to.token::mint = lp_mint` |
| **Mutable** | `state`, `lp_mint`, sol_leg, `transfer_from`, `mint_to` |
| **CPIs** | System transfer user→sol_leg; SPL `mint_to` LP |
| **Arithmetic** | Require `lp_mint.supply <= lp_supply` else hard error `86–90`; **resync** `lp_supply = mint.supply` `92`; `total_value = (sol_leg - rent) + msol_to_sol(msol_leg)` `102–105`; `shares = shares_from_value(lamports, total_value, lp_supply)` `114`; `on_lp_mint` |
| **Attacker inputs** | `lamports` |
| **Invariants** | Cap via `check_liquidity_cap` `79–81`; share price = pool SOL-value / lp_supply |
| **Gaps** | If `total_value==0` and `lp_supply>0`, `proportional` denom-0 returns `lamports` as shares (`calc.rs:12–14`) → **dilution of new LP vs dust holders**. `min_deposit` default **1 lamport** at init. |

---

## 5. `remove_liquidity` — LP shares → SOL + mSOL

| Field | Detail |
|-------|--------|
| **Authority class** | user-signer (LP owner/delegate) |
| **Required signers** | `burn_from_authority` |
| **Key constraints** | `lp_mint.address`; `burn_from.token::mint = lp_mint`; `transfer_msol_to.token::mint = msol_mint`; sol_leg PDA; msol_leg + authority PDA |
| **Mutable** | `state`, `lp_mint`, `burn_from`, `transfer_sol_to`, `transfer_msol_to`, legs |
| **CPIs** | System sol_leg→user; SPL msol_leg→user; SPL `burn` LP |
| **Arithmetic** | If `mint.supply > lp_supply`: **warn only, keep virtual** `83–89`; else sync down. `sol_out = prop(tokens, sol_avail, lp_supply)` `92–96`; `msol_out = prop(tokens, msol_leg, lp_supply)` `97–101`; burn + `on_lp_burn` |
| **Attacker inputs** | `tokens`; SOL/mSOL destinations |
| **Invariants** | Pro-rata both legs; min withdraw on combined SOL value `103–107` |
| **Gaps** | Soft handling of `supply > lp_supply` would overpay if illicit mint existed (needs mint authority—PDA). Destinations unconstrained. |

---

## 6. `order_unstake` — burn mSOL → ticket

| Field | Detail |
|-------|--------|
| **Authority class** | user-signer (mSOL owner/delegate) |
| **Required signers** | `burn_msol_authority` |
| **Key constraints** | `state.has_one = msol_mint`; `burn_msol_from.token::mint = msol_mint`; `new_ticket_account` **zero + rent-exempt** |
| **Mutable** | `state`, `msol_mint`, `burn_msol_from`, `new_ticket_account` |
| **CPIs** | SPL `burn` |
| **Arithmetic** | `sol = msol_to_sol(msol_amount)` `58`; `fee = delayed_unstake_fee.apply(sol)` `61–64`; `lamports_for_user = sol - fee` `66`; `circulating_ticket_balance += lamports_for_user` `78`; `count += 1`; burn + `on_msol_burn`; ticket `beneficiary = burn_msol_from.owner` (not delegate!) `51`, `102–107`; `created_epoch = epoch` or `epoch+1` if `last_stake_delta_epoch == epoch` `96–101` |
| **Attacker inputs** | `msol_amount`; new ticket keypair |
| **Invariants** | Fee burned-not-paid (boosts remaining mSOL); ticket amount frozen at creation price |
| **Gaps** | Delegate cannot steal via ticket (beneficiary=owner)—good. Ticket not PDA-bound to user (anyone can create empty account then this ix fills it). |

---

## 7. `claim` — ticket → SOL

| Field | Detail |
|-------|--------|
| **Authority class** | **permissionless** (no beneficiary signature) |
| **Required signers** | **none** |
| **Key constraints** | reserve PDA; `ticket_account` close→`transfer_sol_to`; `transfer_sol_to.address = ticket.beneficiary` **and** `SystemAccount` |
| **Mutable** | `state`, `reserve_pda`, `ticket_account`, `transfer_sol_to` |
| **CPIs** | System transfer reserve→beneficiary (PDA signer) |
| **Arithmetic** | Due: `epoch >= created+1`, plus 30min into epoch if same due-epoch `70–83`; `available = reserve - rent_exempt` `101`; pay `ticket.lamports_amount`; `circulating_ticket_balance/count -=`; `lamports_amount=0`; `on_transfer_from_reserve` `116–137` |
| **Attacker inputs** | which ticket to crank |
| **Invariants** | Cannot redirect funds (beneficiary fixed); cannot reuse ticket (`lamports_amount != 0`) |
| **Gaps** | **`SystemAccount` on beneficiary:** if `order_unstake` burned from a token account whose `owner` is a program PDA, claim can never succeed → SOL stuck in reserve accounting. Permissionless claim is intentional crank. |

---

## 8. `withdraw_stake_account` — burn mSOL → stake split

| Field | Detail |
|-------|--------|
| **Authority class** | user-signer; gated by `withdraw_stake_account_enabled` + `delinquent_upgrader.is_done()` |
| **Required signers** | `burn_msol_authority`, `split_stake_rent_payer` |
| **Key constraints** | `state.has_one = {msol_mint, treasury_msol_account}`; lists; stake withdraw/deposit PDAs; `stake_account`; `split_stake_account` init owned by stake program |
| **Mutable** | state, mint, burn ATA, treasury, lists, stake, split stake, rent payer |
| **CPIs** | SPL transfer fee→treasury; SPL burn; Stake `split` (deposit PDA); Stake `authorize` staker+withdrawer→`beneficiary` (withdraw PDA) |
| **Arithmetic** | `sol_value = msol_to_sol(msol_amount)` `177`; `split = sol_value - withdraw_stake_account_fee.apply(sol_value)` `185–190`; remainder/min_stake checks `193–213`; `msol_fees = msol_amount - calc_msol(split)` if treasury ok else **0** `219–224`; burn `msol_amount - fees`; active balances `-= split` `288–293` |
| **Attacker inputs** | `stake_index`, `validator_index`, `msol_amount`, **`beneficiary` (unsigned)** |
| **Invariants** | Active stake only; not emergency; amount synced via `check_stake_amount_and_validator` |
| **Gaps** | Wrong/malicious `beneficiary` is user error / phishing (stake delivered to that pubkey). Treasury `None` → burn full mSOL but still deliver fee-reduced stake (fee → remaining holders). |

---

## Authority summary (these paths)

| Instruction | Class | Protocol role needed? |
|-------------|-------|----------------------|
| deposit | user-signer | no |
| deposit_stake_account | user-signer | no |
| liquid_unstake | user-signer | no |
| add_liquidity | user-signer | no |
| remove_liquidity | user-signer | no |
| order_unstake | user-signer | no |
| claim | permissionless | no |
| withdraw_stake_account | user-signer | feature flag + upgrader Done |

---

## Top candidate hypotheses (paths in this review only)

### H-S5-1 — `proportional` / `shares_from_value` when `total_value == 0` and `total_shares > 0`
**Claim:** If `total_virtual_staked_lamports() == 0` while `msol_supply > 0`, `calc_msol_from_lamports` returns the raw lamport amount (`calc.rs:12–14` via `24–30`), so `deposit` / `deposit_stake_account` mint **1:1 mSOL** against a non-empty supply. New SOL is shared with leftover mSOL holders (`price' = L/(S+L)`). Same pattern for `add_liquidity` when LP mark-to-market value is 0 with nonzero `lp_supply`.
**Reachability:** Medium–Low. Requires virtual stake driven to 0 with residual supply—most plausible after **stake losses/slashing** while `circulating_ticket_balance` remains, or pathological LP drain + `msol_to_sol(msol_leg)==0`. Not everyday path; **high impact if reachable**. Unprivileged once precondition holds.

### H-S5-2 — `deposit` LP refill ignores `liquidity_sol_cap`
**Claim:** SOL routed to `liq_pool_sol_leg` on mSOL swap (`deposit.rs:165–175`) never calls `LiqPool::check_liquidity_cap`, unlike `add_liquidity.rs:79–81`. An attacker can push LP SOL up to ~value of `msol_leg` inventory regardless of admin cap.
**Reachability:** High when LP holds mSOL. Impact: **config/invariant bypass**, not direct insolvency (bounded by mSOL leg). Bounty relevance depends on whether cap is a security boundary.

### H-S5-3 — Same-epoch activating stake deposit (`WAIT_EPOCHS = 0`) with zero default fees
**Claim:** `deposit_stake_account` accepts stake with `activation_epoch == clock.epoch` (`74–106`). Mints mSOL and credits `total_active_balance` immediately. Init sets `deposit_stake_account_fee = 0` (`initialize.rs:188`). Docs (`Backend-Design.md`) explicitly warn about end-of-epoch large deposits of not-yet-rewarding stake. Economic dilution of one epoch of rewards onto existing holders.
**Reachability:** High on deployments that left deposit-stake fee at 0. Impact: **economic / fee-policy**, usually below critical bounty bar unless fee is expected to be the sole mitigation and is zero in production.

# STAGE5_HYPOTHESES

Max five attacker-first hypotheses. Each includes reachability.  
Standard: unprivileged attacker + in-scope Immunefi impact + no account patching.

---

## H-S5-1 — `proportional(den=0)` mints 1:1 when `virtual_staked==0` and `msol_supply>0`

### HYPOTHESIS
If `total_virtual_staked_lamports()==0` while `msol_supply>0`, `calc_msol_from_lamports` / `shares_from_value` hits `proportional(..., den=0)` and returns the full lamport amount as mSOL (`calc.rs:12–14`, `state/mod.rs:236–242`). New depositors are diluted; residual mSOL holders skim their SOL.

### ATTACKER
Wallet A holds residual mSOL; causes or waits for `virtual==0`; Wallet B (victim) deposits SOL.

### PRECONDITIONS
`under_control.saturating_sub(circulating_ticket_balance) == 0` ∧ `msol_supply > 0`.

### REACHABILITY — **FAILS**
Pure `order_unstake` cannot create this. Burning fraction `f` of supply adds ≈`f·virtual` to tickets and leaves ≈`(1−f)·virtual` for remaining supply — price is preserved; the last mSOL retains backing.

`virtual==0` with supply>0 requires **external reduction of `under_control`** after tickets were issued (e.g. slash / loss), not unprivileged actions alone.

Self-donation to reserve + deposit math also nets a loss for the donor (see Stage5 analysis notes).

### TRANSACTION SEQUENCE
N/A — precondition not attacker-creatable.

### EXPECTED STATE
N/A

### SECURITY IMPACT
Would be High/Critical dilution **if** reachable.

### MONETIZATION / DAMAGE
Residual holders extract value from new depositors.

### REPRODUCTION PLAN
Would need slash simulation or patched under_control — **disallowed as bounty PoC**.

### DISQUALIFIERS
**Reachability collapse.** Mark **REJECTED (non-bounty)**.

Same `den==0` pattern exists for LP `add_liquidity` when pool value is 0 with `lp_supply>0` — same reachability problem for an attacker who must already hold dust LP while emptying the pool without being able to profitably force victims to `add_liquidity`.

---

## H-S5-2 — `deposit` LP swap bypasses `liquidity_sol_cap`

### HYPOTHESIS
SOL entering the LP via `deposit`’s mSOL-leg swap (`deposit.rs:165–175`) never calls `check_liquidity_cap`, unlike `add_liquidity.rs:79–81`. Attacker can grow LP SOL beyond configured cap when `msol_leg` has inventory.

### ATTACKER
Any depositor while LP holds mSOL.

### PRECONDITIONS
`liq_pool.msol_leg.amount > 0`; admin set a finite `liquidity_sol_cap`.

### REACHABILITY — **PASS** (config-dependent)
High when LP is unbalanced toward mSOL.

### TRANSACTION SEQUENCE
1. Ensure LP has mSOL (normal liquid_unstake traffic or attacker liquid_unstakes into LP first).
2. `deposit(lamports)` repeatedly; SOL fills sol_leg via swap path.

### EXPECTED STATE
`sol_leg` lamports may exceed `liquidity_sol_cap`.

### SECURITY IMPACT
**None in Immunefi Critical/High.** Cap bypass / config evasion only. No theft, freeze, or insolvency demonstrated.

### MONETIZATION / DAMAGE
None for attacker beyond normal deposit.

### REPRODUCTION PLAN
Localnet with low `liquidity_sol_cap`, seed mSOL leg, deposit.

### DISQUALIFIERS
**Impact collapse** — not in-scope severity. Mark **REJECTED (out of severity scope)**.

---

## H-S5-3 — Same-epoch activating `deposit_stake_account` + liquid exit drains LP

### HYPOTHESIS
`WAIT_EPOCHS = 0` (`deposit_stake_account.rs:74`) accepts same-epoch activating stake. Protocol credits `total_active_balance += stake` immediately (`:305`). Attacker mints mSOL, then `liquid_unstake` pulls **liquid SOL from LP**, leaving Marinade/LP with illiquid activating stake.

### ATTACKER
Owns SOL; creates/delegates stake; calls deposit_stake + liquid_unstake.

### PRECONDITIONS
Validator in list; LP has SOL depth; `deposit_stake_account_fee` low/zero (init default **0**, `initialize.rs:188`).

### REACHABILITY — **PASS** (when fee≈0 and LP has SOL)

### TRANSACTION SEQUENCE
1. Create + delegate stake (activation_epoch = current).
2. `deposit_stake_account(validator_index)` → receive mSOL.
3. `liquid_unstake` → receive SOL from `liq_pool_sol_leg`.

### EXPECTED STATE
Attacker: ~flat wealth minus fees/rent (spent stake SOL, received LP SOL).  
LP: SOL ↓, mSOL ↑ (more unbalanced). Protocol holds activating stake.

### SECURITY IMPACT
Not direct theft (attacker swaps their own capital). LP suffers temporary adverse selection / depth loss. Closer to **economic/LP design** than Critical theft. Mitigated by configurable `deposit_stake_account_fee` (v2.1.0 purpose). Max fee 0.2% may not fully cover one-epoch opportunity in all markets — still a **fee/parameter design**, not a missing auth check.

### MONETIZATION / DAMAGE
No reliable profit vs just holding SOL; primary effect is LP inventory shift.

### REPRODUCTION PLAN
Localnet with fee=0, funded LP, same-epoch stake deposit + liquid_unstake; measure attacker Δ and LP Δ.

### DISQUALIFIERS
**Impact/monetization collapse** for bounty Critical/High theft. Temporary LP imbalance without attacker profit ≠ in-scope freeze of *user* funds. Mark **REJECTED (design/fee-gated; no attacker profit)**.

---

## H-S5-4 — Permissionless `merge_stakes` of activating accounts inflates `active_balance` by rent

### HYPOTHESIS
Merging two activating stakes adds source rent into destination `delegation.stake`; code adds `extra_delegated` into validator/`total_active_balance` (`merge_stakes.rs:190–217`), inflating TVL by ~rent-exempt lamports.

### ATTACKER
Permissionless crank after arranging two activating same-vote stakes (e.g. via `stake_reserve` / deposits).

### PRECONDITIONS
Two activating, updated, same-validator stakes; destination canonical.

### REACHABILITY — **PASS** (narrow)

### TRANSACTION SEQUENCE
1. Create two activating stakes under same vote in Marinade lists.
2. `merge_stakes(dest, source, validator)`.

### EXPECTED STATE
`total_active_balance` += rent dust; mSOL price ticks up slightly.

### SECURITY IMPACT
Dust inflation — not theft; may slightly dilute future depositors by tiny rent amounts. Not Critical/High.

### MONETIZATION / DAMAGE
Negligible; not amplifiable to material insolvency.

### REPRODUCTION PLAN
Localnet merge of two activating accounts; diff `total_active_balance` vs sum of prior delegated.

### DISQUALIFIERS
**Impact collapse** (dust / ops). Mark **REJECTED**.

---

## H-S5-5 — PDA-owned mSOL token account → permanently unclaimable delayed-unstake ticket

### HYPOTHESIS
`order_unstake` sets `ticket.beneficiary = burn_msol_from.owner` (`order_unstake.rs:51`). `claim` requires `transfer_sol_to` to be that beneficiary **and** `SystemAccount` (`claim.rs:35–39`). If mSOL ATA owner is a program PDA, claim can never succeed → SOL reserved for ticket stuck from user’s perspective.

### ATTACKER
Would need victim to burn from a PDA-owned token account — attacker cannot force victim’s `order_unstake`.

### PRECONDITIONS
mSOL token account owned by non-system account.

### REACHABILITY — **FAILS** (against third parties)
Only self-inflicted or exotic custody setups.

### SECURITY IMPACT
Could look like permanent freeze **for that user**, but not attacker-driven against others.

### DISQUALIFIERS
Requires victim (or self) non-standard token ownership; not unprivileged attack on others. Mark **REJECTED**.

---

## Summary table

| ID | Reachable by unprivileged attacker? | In-scope impact? | Verdict |
|----|--------------------------------------|------------------|---------|
| H-S5-1 | **No** (needs slash/loss) | would be High/Critical | **REJECTED** |
| H-S5-2 | Yes | No (cap bypass) | **REJECTED** |
| H-S5-3 | Yes if fee≈0 | No clear theft/profit | **REJECTED** |
| H-S5-4 | Narrow yes | Dust only | **REJECTED** |
| H-S5-5 | No vs others | Self/custody edge | **REJECTED** |

**No hypothesis survived the attacker-reachability + Immunefi-impact bar.**  
No `STAGE5_POC_PLAN.md` / exploit PoC warranted this pass.

---

## What was checked and deliberately not filed

- Crank index/account substitution → safe (`get_checked` / voter checks).
- Claim redirection → impossible.
- Delegate stealing via tickets → impossible (beneficiary = owner).
- Reserve donation sandwich → donor loses.
- Closed Stage 3–4 delinquent-upgrader items → not revisited.

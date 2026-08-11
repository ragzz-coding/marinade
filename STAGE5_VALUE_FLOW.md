# STAGE5_VALUE_FLOW — SOL / mSOL / LP / Stake / Tickets

Focus: conservation equations and fee sinks for Stage 5 user-reachable instructions.  
Citations: `programs/marinade-finance/src/...`

---

## Global ledgers (what backs mSOL)

```
under_control = total_active_balance
              + delayed_unstake_cooling_down + emergency_cooling_down
              + available_reserve_balance          # state/mod.rs:212–217

virtual_staked = under_control.saturating_sub(circulating_ticket_balance)  # :229–233

mSOL price (implicit) = virtual_staked / msol_supply
  msol_to_sol(x)   = x * virtual / supply     # via proportional; den=0 → x
  sol_to_msol(x)   = x * supply / virtual     # shares_from_value; shares=0 → x; den=0 → x
```

**Not in `under_control`:** `liq_pool` SOL leg, `liq_pool` mSOL leg, ticket account rent, user wallets.

**Virtual fields:** `available_reserve_balance`, `msol_supply`, `liq_pool.lp_supply` can lag reality; deposits check `mint.supply <= state.msol_supply`; LP add hard-requires `lp_mint.supply <= lp_supply`; Update crank realigns reserve/msol (out of scope file set).

---

## Fee primitives

| Fee | Type | Apply | Max (protocol) |
|-----|------|-------|----------------|
| `deposit_sol_fee` | FeeCents | `lamports * bp_cents / 1_000_000` floor | 0.2% (`MAX_DEPOSIT_SOL_FEE`) |
| `deposit_stake_account_fee` | FeeCents | same | 0.2% |
| `delayed_unstake_fee` | FeeCents | on SOL value of burned mSOL | 0.2% |
| `withdraw_stake_account_fee` | FeeCents | on SOL value | 0.2% |
| LP `linear_fee` / `lp_max_fee` | Fee (bps/10_000) | on mSOL amount liquid-unstaked | 10% max fee |
| LP `treasury_cut` | Fee | fraction of LP mSOL fee | 75% max |

Init defaults for all FeeCents above: **0** (`initialize.rs:185–188`).

---

## Flow diagrams per instruction

### A. `deposit` (`user/deposit.rs`)

```
User SOL (lamports)
    │
    ├─ fee F = deposit_sol_fee.apply(lamports)     # :120
    └─ buy B = calc_msol(lamports - F)             # :122
         │
         ├─ swap S = min(B, msol_leg)              # :131–132
         │     ├─ if S == B (full): SOL_to_LP = lamports      # :137–139  ★ fee SOL → LP
         │     └─ else:         SOL_to_LP = msol_to_sol(S)    # :143
         │           LP mSOL ──S──► user
         │
         └─ rem = lamports - SOL_to_LP             # :184
               ├─ rem > 0 → reserve + on_transfer_to_reserve(rem)  # :189–199
               └─ mint M = B - S; on_msol_mint(M)                  # :203–222
```

**Conservation (intended):**
- User pays `lamports` SOL; receives `B` mSOL (swap and/or mint).
- Fee `F` is **not minted**. Sink:
  - Full LP fill: extra SOL sits in LP (LP holders).
  - Mint/reserve path: SOL fully in reserve but supply + only `B` → all mSOL holders.
- LP swap at oracle price except full-fill fee asymmetry (`:137–139`).

**Δ ledgers:**  
`available_reserve_balance += rem` (if rem>0); `msol_supply += M`; LP balances change outside TVL.

---

### B. `deposit_stake_account` (`user/deposit_stake_account.rs`)

```
User stake (delegation.stake = D)
    │
    ├─ authorize staker/withdrawer → Marinade PDAs   # :217–266
    ├─ stake_list.add(D); validator.active += D      # :142–143, :269–276
    ├─ F = deposit_stake_account_fee.apply(D)        # :278
    ├─ mint calc_msol(D - F); on_msol_mint           # :280–300
    └─ total_active_balance += D                     # :305  ★ full D, not D-F
```

**Conservation:**
- Protocol gains stake `D` in active accounting.
- User receives mSOL for `D-F` only → fee accrues to existing mSOL holders via price.
- Stake rent exempt remains in stake account (not credited as stake).

---

### C. `liquid_unstake` (`liq_pool/liquid_unstake.rs`)

```
User mSOL (A)
    │
    ├─ fee_rate = f(liquidity after removing msol_to_sol(A))   # :81–88
    ├─ msol_fee = fee_rate.apply(A)                            # :91
    ├─ SOL_out = msol_to_sol(A - msol_fee)                     # :96
    ├─ LP SOL ──SOL_out──► user                                # :112–127
    ├─ treasury_cut = treasury_cut.apply(msol_fee) or 0        # :131–135
    └─ user mSOL ──(A - cut)──► msol_leg
                 └─cut──────► treasury (if valid)
```

**Conservation:**
- `msol_supply` unchanged (no burn).
- `under_control` / virtual unchanged (LP outside TVL).
- LP: −SOL_out + (A−cut) mSOL; mark-to-market SOL value increases by ~fee (design: LP value non-decreasing).
- Invalid treasury: cut=0, full fee mSOL → LP (user still pays via reduced SOL_out).

---

### D. `add_liquidity` / `remove_liquidity`

**Add** (`add_liquidity.rs:101–149`):
```
pool_value = (sol_leg - rent) + msol_to_sol(msol_leg)
shares = shares_from_value(lamports, pool_value, lp_supply)
user SOL → sol_leg; mint shares; on_lp_mint
```

**Remove** (`remove_liquidity.rs:92–164`):
```
sol_out  = tokens * (sol_leg - rent) / lp_supply
msol_out = tokens * msol_leg       / lp_supply
leg → user; burn tokens; on_lp_burn
```

**Conservation:** Pro-rata both assets. Rounding dust stays in pool (benefits remaining LPs).  
**Break if `pool_value==0` & `lp_supply>0`:** new shares = `lamports` (`calc.rs:12–14`), transferring value to pre-existing share holders.

---

### E. `order_unstake` / `claim`

**Order** (`order_unstake.rs:58–107`):
```
sol = msol_to_sol(A)
fee = delayed_unstake_fee.apply(sol)     # not paid to user
ticket.lamports = sol - fee
circulating_ticket_balance += ticket.lamports
burn A; on_msol_burn(A)
# fee effect: SOL value destroyed from backing claims → remaining mSOL richer
```

**Δ:** `virtual_staked` drops by ~`sol` (tickets += `sol-fee`, supply −= A). Net fee residue boosts price for leftover mSOL.

**Claim** (`claim.rs:98–137`):
```
require ticket due + reserve has funds
circulating_ticket_balance -= L
reserve ──L──► beneficiary
on_transfer_from_reserve(L)
close ticket rent → beneficiary
```

**Conservation:** Ticket claim consumes reserve SOL previously (or eventually) sourced from deactivated stake. Does not burn/mint mSOL.  
**Invariant risk:** if `sum(ticket.lamports) != circulating_ticket_balance` (comment `:115`), insolvency or stuck claims—maintained only by order/claim pairing.

---

### F. `withdraw_stake_account` (`user/withdraw_stake_account.rs`)

```
sol = msol_to_sol(A)
fee_lamports = withdraw_stake_account_fee.apply(sol)
split = sol - fee_lamports                 # stake delivered
msol_fees = A - calc_msol(split)  if treasury ok else 0
user mSOL ──fees──► treasury (optional)
         ──burn (A-fees)──► destroy; on_msol_burn
stake ──split──► new stake; auths → beneficiary
active_balance -= split; total_active_balance -= split
```

**Conservation:**
- User receives stake `split` < `sol` by fee.
- If treasury valid: fee mSOL → treasury; burn remainder.
- If treasury invalid: burn **all** `A`, still only split `split` stake → fee to remaining mSOL holders.
- Protocol active stake ↓ by `split` only (fee portion of value stays in pool as unwithdrawn stake backing).

---

## Cross-path attacker value cheatsheet

| Goal | Path | Pays | Receives | Who eats cost |
|------|------|------|----------|---------------|
| Mint mSOL from SOL | deposit | SOL | mSOL | deposit fee → LP or mSOL holders |
| Mint mSOL from stake | deposit_stake | stake | mSOL | stake fee → mSOL holders |
| Instant SOL exit | liquid_unstake | mSOL | SOL (−LP fee) | LP (+ treasury cut) |
| Delayed SOL exit | order→claim | mSOL | SOL (−delay fee) | remaining mSOL |
| Instant stake exit | withdraw_stake | mSOL | stake (−fee) | treasury or mSOL holders |
| LP provide/remove | add/remove liq | SOL / LP | LP / SOL+mSOL | rounding dust |

---

## Strongest value-flow break hypotheses (same as attack surface)

1. **H-S5-1 (critical if precondition):** `virtual_staked == 0` ∧ `msol_supply > 0` → `deposit*` mints `lamports` mSOL 1:1 (`calc.rs:12–14` + `state/mod.rs:236–242` + `deposit.rs:122`). Leftover mSOL skims new deposits. Mirror on LP when `pool_value == 0`.

2. **H-S5-2 (cap bypass):** deposit→LP swap moves SOL into sol_leg without `liquidity_sol_cap` (`deposit.rs:165–175` vs `add_liquidity.rs:79–81`).

3. **H-S5-3 (economic):** `WAIT_EPOCHS=0` + zero stake-deposit fee → same-epoch activating stake credited fully to `total_active_balance` while earning no rewards that epoch (`deposit_stake_account.rs:74–106`, `:305`).

---

## Explicit non-findings (attacker-theft) on these paths

- Claim cannot redirect beneficiary (`claim.rs:35–38`).
- Order-unstake delegate cannot set ticket beneficiary (forced to token owner) (`order_unstake.rs:51`).
- Liquid-unstake / withdraw treasury soft-fail does **not** waive user fee; it changes fee **sink** only.
- RemoveLiquidity overpay on `supply > lp_supply` requires illicit LP mint (mint authority PDA)—not unprivileged.
- Deposit full-fill fee→LP (`deposit.rs:137–139`) is asymmetric fee routing (Stage2 H4), not user underpayment of fee.

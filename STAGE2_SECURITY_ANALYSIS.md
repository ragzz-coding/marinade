# STAGE 2 — Marinade Security Invariant & Attack-Surface Analysis

**Scope:** Local source analysis only. No network, no mainnet/testnet, no production source modifications.  
**Tree:** `liquid-staking-program-main/` (v2.1.0 shape; upstream `3e7c090` **UNVERIFIED** locally)  
**Program:** `MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD`  
**Classification key:** **FACT** = directly observed in source · **INFERENCE** = reasoned from FACT · **HYPOTHESIS** = unproven attack claim

---

# 1. SECURITY MODEL

Marinade is a liquid-staking pool: users deposit SOL or stake accounts, receive mSOL, and exit via liquidity pool, delayed unstake tickets, or (optional) immediate stake withdrawal. A permissionless crank maintains stake accounts, harvests rewards into the mSOL exchange rate, and restakes reserve SOL.

**Trust boundaries (FACT):**

| Boundary | Mechanism |
|----------|-----------|
| Program identity | `declare_id!` + `check_context` (`lib.rs:20`, `34–44`) |
| No extra accounts | `remaining_accounts` must be empty (`lib.rs:39–41`) |
| Admin config | `state.admin_authority` signer |
| Pause | `state.pause_authority` signer |
| Validator ops | `state.validator_system.manager_authority` signer |
| Stake custody | Stake deposit/withdraw PDAs `[state, b"deposit"|b"withdraw"]` |
| SOL custody | Reserve PDA `[state, b"reserve"]`; LP SOL leg `[state, b"liq_sol"]` |
| Mint authority | mSOL / LP mint PDAs |
| List membership | Stake/validator `get_checked` binds index ↔ pubkey |
| Migration gate | Many stake-moving ixs require `delinquent_upgrader.is_done()` |

**Economic model (FACT):**

```
total_lamports_under_control
  = total_active_balance
  + delayed_unstake_cooling_down + emergency_cooling_down
  + available_reserve_balance

total_virtual_staked_lamports
  = total_lamports_under_control.saturating_sub(circulating_ticket_balance)

msol_price ∝ total_virtual_staked_lamports / msol_supply
```

(`state/mod.rs:208–251`, `update.rs:251–261`)

Yield is **implicit** in the mSOL exchange rate (delegation growth / MEV → reserve or active balance; protocol `reward_fee` minted as mSOL to treasury). There is no separate “unclaimed yield” account for users—holders earn by price appreciation. Tickets lock a SOL claim against the virtual stake denominator.

---

# 2. AUTHORITY GRAPH

```
                    ┌─────────────────────────┐
                    │   InitializeData keys    │  (no signer at init — FACT)
                    │ admin / manager / pause  │
                    └───────────┬─────────────┘
                                │
         ┌──────────────────────┼──────────────────────┐
         v                      v                      v
  admin_authority      manager_authority        pause_authority
  (State:33)           (ValidatorSystem:118)    (State:76)
         │                      │                      │
         ├ change_authority     ├ add/remove_validator ├ pause/resume
         ├ config_marinade      ├ set_validator_score  │
         ├ config_lp            ├ emergency_unstake    │
         ├ realloc_*_list       ├ partial_unstake      │
         │                      └ config_validator_    │
         │                        system (extra_runs)  │
         └──── can replace all authorities ────────────┘

  USER (mSOL/SOL/LP owner or delegate)
    ├ deposit / deposit_stake_account
    ├ liquid_unstake / add_liquidity / remove_liquidity
    ├ order_unstake / claim (claim permissionless to beneficiary)
    └ withdraw_stake_account (if enabled + upgrader Done)

  ANYONE (permissionless crank)
    ├ update_active / update_deactivated
    ├ finalize_delinquent_upgrade
    ├ stake_reserve / deactivate_stake
    ├ create_canonical_stake / merge_stakes
    └ (rent payers sign only for account init)
```

**Authority change (FACT):** `change_authority` (`admin/change_authority.rs`) — current admin signs; new keys unbound (treasury can be set to a non-token account → fee soft-skip via `get_treasury_msol_balance`, `state/mod.rs:171–205`).

**Upgrade authority:** Not in program state — BPF loader upgrade authority is **off-program** (out of in-program scope).

**Indirect auth (FACT):** Stake CPIs succeed only if Marinade PDAs are staker/withdrawer (after deposit) or user `stake_authority` (during deposit authorize).

---

# 3. ASSET FLOW MAP

## SOL deposit (`deposit.rs:119–223`)

```
USER SOL (lamports)
  | fee = deposit_sol_fee.apply(lamports)     # FeeCents floor div 1e6
  | msol_order = calc_msol(lamports - fee)
  +--(optional)--> LP: user SOL → sol_leg; LP mSOL → user
  |   full fill: sol_swapped = FULL lamports (incl. fee)   # FACT :137–139
  +--(remainder)--> reserve_pda; mint mSOL remainder
```

**FACT:** Fee is not transferred to treasury. Fee reduces mSOL minted. On 100% LP fill, fee SOL remains with LP.

## Stake deposit (`deposit_stake_account.rs:142–305`)

```
USER stake account
  → authorize staker/withdrawer to Marinade PDAs
  → validator.active_balance += stake
  → total_active_balance += stake
  → mint mSOL for (stake - deposit_stake_account_fee)
```

**FACT:** Full stake enters active accounting; fee only reduces minted mSOL (value accrues to existing mSOL holders).

## Liquid unstake (`liquid_unstake.rs`)

```
USER mSOL --fee--> LP mSOL leg (+ treasury cut of fee)
USER SOL <── sol_leg (msol_to_sol(amount - fee))
```

**FACT:** State `msol_supply` unchanged (mSOL moves to LP, not burned).

## Delayed unstake (`order_unstake.rs` / `claim.rs`)

```
order: burn mSOL; ticket.lamports = msol_to_sol(msol) - delayed_fee
       circulating_ticket_balance += ticket
claim: reserve → beneficiary; circulating_ticket_balance -= ticket
```

## Rewards (`update_active` / `update_deactivated`)

```
delegation growth / extra lamports
  → active_balance or reserve
  → reward_fee.apply → mint mSOL to treasury (if treasury valid)
  → msol_price update
```

## Delinquent / cooling withdrawal (`update_deactivated`)

```
deactivated stake lamports → reserve
rent → operational_sol_account
cooling buckets or delinquent FSM accounting adjusted
stake record removed from list
```

## MNDE

**FACT:** Not handled by this program.

---

# 4. INSTRUCTION SECURITY TABLE

| Instruction | Caller/Authority | Key Accounts | Mutated State | Token/SOL Movement | CPI | Criticality |
|-------------|------------------|--------------|---------------|--------------------|-----|-------------|
| `initialize` | Anyone (zero state) | state, lists, mints, reserve, liq | Full State init | Pre-funded rent only | — | Med (config) |
| `change_authority` | admin | state | authorities/treasury/ops | — | — | High (priv) |
| `config_marinade` | admin | state | fees/caps/flags | — | — | High (fees) |
| `config_lp` | admin | state | LP fee curve | — | — | Med |
| `config_validator_system` | manager | state | `extra_stake_delta_runs` | — | — | Low |
| `pause`/`resume` | pause_authority | state | `paused` | — | — | High (freeze) |
| `realloc_stake_list` | admin+payer | stake_list | account size | rent | System | Low |
| `realloc_validator_list` | admin+payer | validator_list | account size | rent | System | Low |
| `add_validator` | manager | list, dup flag PDA | validator list | rent→flag | System | Med |
| `remove_validator` | manager | list, flag | list; drain flag | flag SOL→ops | — | Med |
| `set_validator_score` | manager | list | scores/totals | — | — | Med |
| `emergency_unstake` | manager | stake, lists | Active→Deactivating; emergency_cooling | deactivate | Stake | High |
| `partial_unstake` | manager | stake, split | split/deactivate; emergency_cooling | split/deactivate | Stake | High |
| `deposit` | SOL owner | reserve, LP legs, mint | reserve/msol_supply | SOL+mint/swap mSOL | System+Token | **Critical** |
| `deposit_stake_account` | stake auth | stake, lists, mint | active balances; FSM | authorize+mint | Stake+Token | **Critical** |
| `withdraw_stake_account` | mSOL auth | stake, split, mint | burn; active↓; split out | burn/split/auth | Token+Stake | **Critical** |
| `add_liquidity` | SOL owner | sol_leg, lp_mint | lp_supply | SOL→leg; mint LP | System+Token | High |
| `remove_liquidity` | LP auth | legs, burns | lp_supply | SOL+mSOL out; burn LP | System+Token | High |
| `liquid_unstake` | mSOL auth | sol_leg, msol_leg | (LP balances only) | mSOL→LP; SOL→user | System+Token | **Critical** |
| `order_unstake` | mSOL auth | mint, ticket | tickets; msol_supply | burn mSOL | Token | **Critical** |
| `claim` | anyone→beneficiary | reserve, ticket | tickets; reserve | reserve→user; close ticket | System | **Critical** |
| `stake_reserve` | anyone+rent | reserve, new stake | active↑ | reserve→stake; delegate | System+Stake | High |
| `deactivate_stake` | anyone+rent | stake, split | active→cooling | deactivate/split | Stake | High |
| `update_active` | anyone | stake, lists, reserve, mint | rewards; FSM; price | withdraw extra; mint fee | Stake+Token | **Critical** |
| `update_deactivated` | anyone | stake, reserve, ops | cooling/FSM; remove stake | withdraw all; rent→ops | Stake+System | **Critical** |
| `finalize_delinquent_upgrade` | anyone | state, validator_list | validator balances; FSM | — | — | **Critical** |
| `create_canonical_stake` | anyone | source, canonical PDA | list replace | split to PDA | Stake+System | High |
| `merge_stakes` | anyone | canonical+source | list; balances | merge; rent→ops | Stake | High |

**Signer / PDA notes (FACT):**

- UncheckedAccounts used for PDAs are generally seed+bump constrained.
- Soft-validated: `treasury_msol_account` (fee skip if invalid).
- Unused in process: `DepositStakeAccount.duplication_flag` (still required in accounts meta).
- Admin config / change_authority / realloc: **no** `paused` check.
- `set_validator_score`: **no** `delinquent_upgrader.is_done()` gate.

---

# 5. DELINQUENT FSM ANALYSIS

## Exact machine (FACT — `state/delinquent_upgrader.rs`)

```
Default / post-upgrade bytes
  → IteratingStakes { visited_count, total_active_balance, total_delinquent_balance }
        │  update_active: Unknown→Active (+visited, +shadow, +FSM total)
        │  deposit_stake_account: +visited, +shadow, +FSM total
        │  update_deactivated: may +total_delinquent; may −validator total_active;
        │                      removes stake (does NOT −visited_count)
        │  when visited_count == stake_count
        │    AND FSM.total_active_balance == validator_system.total_active_balance
        ▼
  IteratingValidators { visited_count, delinquent_balance_left }
        │  finalize_delinquent_upgrade (permissionless):
        │    for each validator from cursor:
        │      left −= (active − delinquent_upgrader_active_balance)
        │      active = delinquent_upgrader_active_balance; shadow = 0
        │  when cursor == validator_count AND left == 0 → Done
        ▼
  Done
```

**Initialization (FACT):**

- Fresh `initialize`: `Done` (`initialize.rs:193`).
- `Default`: `IteratingStakes{0,0,0}` (`delinquent_upgrader.rs:17–24`).
- **No instruction** transitions into `IteratingStakes` — **INFERENCE:** account layout upgrade / default fill starts migration (matches `update.rs:468–469` comment).

## State-transition table

| Current | Caller | Required inputs | State mutation | Asset mutation | Next | Failure |
|---------|--------|-----------------|----------------|----------------|------|---------|
| IteratingStakes | anyone `update_active` | active stake, Unknown/Active record | Unknown→Active; visited++; shadow+=; rewards/slash sync | extra→reserve; fee mint | stays or →Validators if complete | pause; IteratingValidators blocked; status Deactivating; invariant LTE |
| IteratingStakes | anyone `update_deactivated` | deactivating stake | cooling/delinquent accounting; remove stake | all→reserve; rent→ops | stays or →Validators | pause; cooling underflow (Done path); upgrading invariant |
| IteratingStakes | user `deposit_stake_account` | valid stake+validator | visited++; balances+= | authorize; mint mSOL | stays | pause; stake checks |
| IteratingValidators | anyone `finalize_*` | validator_list, max_validators | cursor++; rewrite actives | none | stays or Done | not IteratingValidators; left≠0 at end; underflow on left−= |
| IteratingValidators | anyone `update_active` | — | — | — | — | **hard reject** `DelinquentUpgraderIsNotDone` |
| IteratingValidators | anyone `update_deactivated` | deactivating stake | emergency/cooling (non-FSM branch if not IteratingStakes) | withdraw | stays | pause |
| Done | gated ixs | — | normal ops | normal | Done | — |

## Critical FSM properties

| Question | Answer | Class |
|----------|--------|-------|
| Progress monotonic? | `visited_count` only increases; stake removals do **not** decrement it | FACT |
| Same stake twice (Unknown)? | Second `update_active` no-ops upgrade | FACT |
| Skip stake? | No index cursor—any order; unfinished Unknown blocks `visited==count` | FACT |
| Skip validator in finalize? | No—sequential from cursor | FACT |
| Double finalize validator? | No—cursor advances | FACT |
| Done early? | Only if `left==0` after all validators | FACT |
| Stuck possible? | Yes if `visited_count == stake_count` but FSM/validator totals diverge → `require_eq` fails; or after failed attempts `visited > count` following removals | **HYPOTHESIS H1** |
| Attacker advances FSM? | Yes—all three drivers are permissionless | FACT |
| `is_done()` while work pending? | No if finalize invariant holds; shadow must match | FACT if invariants preserved |
| Ops frozen until Done? | create/merge/deactivate/stake_reserve/add/remove validator/emergency/partial/withdraw_stake | FACT |

---

# 6. ACCOUNTING INVARIANTS

### INV-1 — Virtual stake backs mSOL
```
INVARIANT: msol_to_sol / calc_msol use total_virtual_staked_lamports & msol_supply
WHY: exchange rate fairness
WHERE ESTABLISHED: deposits/mints/burns/updates
WHERE UPDATED: on_msol_*; on_transfer_*; total_active/cooling; tickets
WHERE COULD BREAK: double-count active+reserve; missed cooling; ticket desync
ATTACKER CONTROL: permissionless update ordering during FSM (H1/H2)
```

### INV-2 — List stake amounts ≤ validator / total active
```
INVARIANT: sum(active stake records for V) ≈ V.active_balance; sum ≈ total_active_balance
WHY: withdrawal/unstake limits
ENFORCED: get_checked + check_stake_amount_and_validator on sensitive paths
COULD BREAK: merge extra_delegated edge cases; FSM finalize rewriting actives
```

### INV-3 — Cooling buckets cover deactivating stake
```
INVARIANT: delayed_unstake_cooling_down + emergency_cooling_down track deactivating delegated amounts
UPDATED: deactivate_stake / emergency / partial / update_deactivated
COULD BREAK: IteratingStakes path mixing delinquent residual with cooling (H2)
```

### INV-4 — Ticket claims ≤ reserve availability
```
INVARIANT: claim requires lamports ≤ reserve − rent_exempt (claim.rs:101–109)
WHY: no overdraft
COULD BREAK: if stake_delta cannot refill reserve while tickets accumulate (H1 freeze)
```

### INV-5 — Deposit fees never mint more mSOL than SOL value
```
FACT: fee floored; saturating_sub; max FeeCents 0.2% (State::MAX_DEPOSIT_*_FEE)
deposit < fee impossible at max fee for lamports≥1 (fee=0 for tiny amounts)
```

### INV-6 — LP share conservation
```
shares_from_value / proportional; AddLiquidity errors if mint.supply > lp_supply;
RemoveLiquidity only warns if mint.supply > lp_supply (asymmetric — FACT)
```

### INV-7 — Delinquent finalize conservation
```
sum_V (active − shadow) == delinquent_balance_left at start of finalize
ENFORCED: require_eq left==0 to reach Done (finalize:59–64)
COULD BREAK: mid-finalize update_deactivated emergency mutating not-yet-visited validators (H3)
```

**Arithmetic (FACT):** `Fee`/`FeeCents` truncate toward 0; `proportional` uses u128; workspace `overflow-checks = true`.

---

# 7. CPI TRUST BOUNDARIES

| Caller | CPI Program | Accounts | User-controlled? | Validation | Consequence if wrong |
|--------|-------------|----------|------------------|------------|----------------------|
| deposit | System Transfer | from user, to reserve/LP | from=signer | signer+owner system | user pays |
| deposit | Token Transfer/MintTo | LP/mint PDAs | mint_to arbitrary ATA | mint constraint; PDA seeds | donation OK |
| deposit_stake | Stake authorize/lockup | stake, user auth | stake+auth | CPI fails if wrong auth | fail closed |
| withdraw_stake | Token burn/transfer; Stake split/authorize | beneficiary pubkey arg | beneficiary unconstrained | PDA signs split | stake given to beneficiary |
| update_* | Stake withdraw; Token mint fee | stake, reserve, treasury | stake via list check | get_checked+delegation | |
| update_deactivated | System transfer rent | ops account | has_one/address | state binding | |
| claim | System transfer | reserve→beneficiary | beneficiary=ticket | address constraint | cannot redirect |
| create_canonical | allocate/assign/split | canonical PDA | validator index | PDA seeds+owner≠stake | |
| merge | Stake merge/withdraw | dest must be canonical PDA | indices | PDA+status Active+updated | |
| liq ops | System+Token | legs PDAs | destinations often free | PDA bumps | |
| emergency/partial/deactivate | Stake deactivate/split | manager or crank | stake list-checked | | |

**FACT:** No CPI to oracles, MNDE, or external DeFi. Stake program ID via `Program<'info, Stake>`; Token via `Program<'info, Token>`.

**Assumed not re-checked after CPI (FACT):** Destination stake state reloaded after merge (`merge_stakes.rs:189`). Canonical creation does not reload source after split (source removed from list).

---

# 8. TOP 15 VULNERABILITY HYPOTHESES

### HYPOTHESIS #1
**Title:** Delinquent FSM can permanently stall (`visited_count` vs `stake_count` / balance mismatch)  
**Potential Impact:** High (temporary→permanent freezing of `is_done()`-gated exits & stake-delta; delayed claims may starve)  
**Relevant Code:** `update.rs:274–296`, `548–709`; `delinquent_upgrader.rs`  
**Attacker:** Permissionless crank + natural/forced delinquent deactivation during upgrade  
**Preconditions:** `IteratingStakes`; mix of updates and `update_deactivated` on previously counted stakes; and/or `FSM.total_active_balance != validator_system.total_active_balance` when counts meet  
**Attacker-Controlled Inputs:** Stake/validator indices order  
**Expected Invariant:** Migration completes to `Done`  
**Potential Violation:** `require_eq!` fails forever; or `visited_count > stake_count` so equality never holds  
**Path:** `update_active`/`update_deactivated` → progression check → fail/skip → `is_done()==false` blocks deactivate/stake_reserve/withdraw_stake  
**Why checks may fail:** Progression requires both count equality **and** balance equality; removals don’t decrement `visited_count`  
**Why not best practice:** Directly freezes in-scope fund paths  
**Prove next:** Local harness simulating upgrade + deactivation ordering  
**Confidence:** Medium

### HYPOTHESIS #2
**Title:** `update_deactivated` during `IteratingStakes` mis-attributes cooling vs delinquent residuals  
**Potential Impact:** Critical/High (exchange-rate distortion; finalize invariant fail → freeze)  
**Relevant Code:** `update.rs:652–680`  
**Attacker:** Permissionless; orders which deactivated stake is cranked first  
**Preconditions:** `IteratingStakes`; both legitimate cooling stakes and unexpected deactivations; or cooling bucket &lt; sum of Unknown-deactivating amounts  
**Expected Invariant:** Cooling buckets only cover true cooling stake; delinquents only reduce active once  
**Potential Violation:** Residual `delinquent_amount` incorrectly changes `total_active_balance`; finalize `delinquent_balance_left` diverges  
**Path:** `update_deactivated` → min(cooling,stake) → delinquent residual → `total_active_balance −=` → price/finalize  
**Prove next:** Two-stake fixture (1 delayed cooling + 1 force-deactivated Unknown)  
**Confidence:** Medium

### HYPOTHESIS #3
**Title:** `update_deactivated` during `IteratingValidators` mutates validator `active_balance` after/before finalize cursor  
**Potential Impact:** High (finalize `left` underflow / `UpgradingInvariantViolation` → freeze in Validators)  
**Relevant Code:** `update.rs:569–591`; `finalize_delinquent_upgrade.rs:37–64`  
**Attacker:** Permissionless interleaving finalize chunks with deactivated updates  
**Preconditions:** `IteratingValidators`; emergency conversion on not-yet-finalized validator  
**Expected Invariant:** `sum(active−shadow)` stable equals `delinquent_balance_left`  
**Potential Violation:** Emergency path changes `active` without adjusting `left`  
**Confidence:** Medium

### HYPOTHESIS #4
**Title:** SOL deposit fee on 100% LP fill routes fee value to LPs, not shared mSOL holders  
**Potential Impact:** Not bounty-relevant / Low (fee design asymmetry vs stake deposit)  
**Relevant Code:** `deposit.rs:120–139`  
**Attacker:** User depositing when LP has mSOL  
**Expected Invariant:** (product intent unclear) fee beneficiary consistent  
**Potential Violation:** Economic asymmetry only—user still pays fee intentionally  
**Confidence:** High that behavior exists; **Low** that it is in-scope theft  
**Class:** Likely rejected as intended fee/LP rebalance behavior

### HYPOTHESIS #5
**Title:** Stake-deposit fee enriches all mSOL holders while recording full stake—OK; but combined with FSM deposit hooks could desync shadow if index already finalized  
**Potential Impact:** High if shadow/`active` desync under `IteratingValidators`  
**Relevant Code:** `deposit_stake_account.rs:144–166`  
**Attacker:** User depositing stake during finalize window  
**FACT:** If `validator_index >= visited_count`, shadow+=; if already visited, only `active`+=  
**Expected Invariant:** Finalize still conserves `left`  
**Potential Violation:** Deposit to already-finalized validator increases `active` after shadow zeroed without adjusting `left`  
**Confidence:** Medium–High for desync; needs PoC for finalize failure vs silent insolvency

### HYPOTHESIS #6
**Title:** RemoveLiquidity allows `lp_mint.supply > lp_supply` (warn only) enabling share inflation drain if illicit LP mint existed  
**Potential Impact:** Critical **if** illicit mint possible; else Not relevant  
**Relevant Code:** `remove_liquidity.rs:81–89` vs `add_liquidity.rs` hard error  
**Attacker:** Would need LP mint authority compromise (PDA)  
**Confidence:** Low as standalone (mint authority is PDA)

### HYPOTHESIS #7
**Title:** `claim` permissionless + ticket not PDA-derived—only discriminator/owner  
**Potential Impact:** Not bounty-relevant (cannot redirect beneficiary)  
**Relevant Code:** `claim.rs:14–44`, `52–85`  
**Confidence:** High benign

### HYPOTHESIS #8
**Title:** Epoch double-update guard commented out—repeated `update_active` same epoch  
**Potential Impact:** Not relevant if amounts already synced (zero rewards)  
**Relevant Code:** `update.rs:179–182`  
**Confidence:** Low exploitability

### HYPOTHESIS #9
**Title:** `max_stake_moved_per_epoch.check()` disabled—admin can set &gt;100%  
**Potential Impact:** Not relevant without admin key compromise  
**Relevant Code:** `config_marinade.rs:240–243`  
**Confidence:** N/A (privileged)

### HYPOTHESIS #10
**Title:** Canonical stake creation drains pre-existing lamports on PDA to operational  
**Potential Impact:** Not relevant (donation griefing)  
**Relevant Code:** `create_canonical_stake.rs:143–155`  
**Confidence:** High benign

### HYPOTHESIS #11
**Title:** `merge_stakes` `extra_delegated` path can inflate active balances if merge semantics differ  
**Potential Impact:** High if false delegation credited  
**Relevant Code:** `merge_stakes.rs:189–216`  
**Attacker:** Permissionless merge of activating accounts  
**Preconditions:** Unusual stake activation states passing Active checks  
**Confidence:** Low–Medium (guards require Active + updated + not deactivating)

### HYPOTHESIS #12
**Title:** Pause does not freeze admin reconfiguration; pause can strand users while admin raises fees  
**Potential Impact:** Centralization / privileged—out of scope unless pause key obtainable  
**Confidence:** N/A

### HYPOTHESIS #13
**Title:** `withdraw_stake_account` beneficiary need not sign—phishing/wrong beneficiary  
**Potential Impact:** User error, not protocol theft  
**Confidence:** Reject

### HYPOTHESIS #14
**Title:** During `IteratingStakes`, `update_active` blocked only for Validators phase—rewards continue; combined with H5 deposits can change finalize math  
**Potential Impact:** Amplifies H3/H5  
**Confidence:** Medium (composition)

### HYPOTHESIS #15
**Title:** Known pre-`3e7c090` delinquent handling rediscovery  
**Potential Impact:** Out of scope (known issue)  
**Note:** This tree **includes** post-fix machinery; do not report the known gap. Investigate **residual** bypasses (H1–H3, H5) instead.  
**Confidence:** N/A

---

# 9. TOP 5 POISED FOR LOCAL PoC

| Rank | ID | Why PoC now |
|------|-----|-------------|
| 1 | **H5** | Clear code path: deposit stake to already-finalized validator during `IteratingValidators` increases `active_balance` after shadow cleared; finalize/`left` math may break or silently inflate validator active. Permissionless user + permissionless finalize. Direct invariant. |
| 2 | **H3** | Interleave `finalize_delinquent_upgrade(max=1)` with `update_deactivated` emergency conversion; measure `delinquent_balance_left` vs sum(active−shadow). |
| 3 | **H1** | Simulate upgrade defaults; visit subset; deactivate visited Active; attempt progression; assert Stuck / `is_done` forever false; then show `deactivate_stake`/`withdraw_stake_account` rejected. |
| 4 | **H2** | Two deactivated Unknown stakes + finite `delayed_unstake_cooling_down`; vary crank order; assert `total_active_balance` and finalize outcome. |
| 5 | **H11** | Attempt merge of edge-case stake states; assert whether `extra_delegated` can non-zero without real new stake. Likely kill hypothesis. |

**Deprioritized:** H4 (fee design), H6 (needs mint key), H7–H10, H12–H13, H15 (known issue).

---

# 10. REQUIRED TOOLCHAIN / HARNESS

**FACT:** Anchor CLI / Solana CLI not installed; no in-repo tests.

**Required (local-only):**

1. Anchor **0.27.0** + Solana **1.14.x** (or compatible with lockfile 1.15.2 program crate)
2. Test harness options: Anchor localnet, LiteSVM, or Bankrun—**no public cluster**
3. Fixtures: `State` with `delinquent_upgrader` set explicitly; stake list with `StakeStatus::Unknown`; validator list with shadow balances; stake accounts in stake program owned shapes
4. Ability to set stake `deactivation_epoch` without mainnet (local stake program)

### PoC sketch — H5

```
SETUP: state.delinquent_upgrader = IteratingValidators { visited_count: 1, left: L }
       validators[0] already finalized (shadow=0, active=A0)
       validators[1] not finalized (shadow=S1, active=A1)
INITIAL: left = (A0-0)+(A1-S1) conserved
ATTACKER: deposit_stake_account into validator_index=0 with stake X
EXPECTED SECURE: either reject OR active+=X AND left adjusted / shadow rules keep conservation
SUSPECTED: active0 = A0+X, shadow0=0, left unchanged → finalize end require_eq(left,0) fails OR Done with inflated active
ASSERT: after full finalize, sum(validator.active) vs total_active_balance vs real stake
```

### PoC sketch — H1

```
SETUP: IteratingStakes; 3 Unknown active stakes
ACTION: update_active all 3 OR update 2 then update_deactivated on one visited after force-deactivate
EXPECTED: reach IteratingValidators then Done
SUSPECTED: UpgradingInvariantViolation loop OR visited>count; is_done false; deactivate_stake returns DelinquentUpgraderIsNotDone
```

---

# 11. UNKNOWN / UNVERIFIED ASSUMPTIONS

1. **UNVERIFIED** — This tree equals Immunefi commit `3e7c090` / PR #84 / mainnet binary (`0f031c4` claimed in README only).
2. **UNVERIFIED** — How mainnet account migration set `delinquent_upgrader` and `last_update_status` (Default vs explicit).
3. **UNVERIFIED** — Whether upgrade already completed on production (`Done`) making FSM bugs historical-only; still relevant if upgrade reusable / other deployments / future migrations.
4. **UNVERIFIED** — Runtime of hypotheses (no harness executed this stage).
5. **FACT** — Overflow checks enabled in Cargo profiles; bare `+=`/`−=` still panic on overflow rather than wrap in release-with-overflow-checks.

---

# 12. EXECUTIVE VERDICT

Repository-wide mapping is complete for all 29 instructions, authorities, asset flows, PDAs, CPIs, and the delinquent FSM.

**No proven exploit in this stage.** Strongest **code-backed** attack surfaces cluster around the **delinquent upgrader**—especially:

1. User `deposit_stake_account` during `IteratingValidators` (**H5**)
2. Permissionless interleaving of `finalize_delinquent_upgrade` with `update_deactivated` (**H3**)
3. Progression/`visited_count` stall conditions (**H1**, **H2**)

These can plausibly produce **High** temporary/permanent freezing of `is_done()`-gated operations, and possibly exchange-rate/accounting damage—**if** the upgrade FSM is still reachable. Deposit-fee LP routing (**H4**) is real behavior but likely **out of bounty scope** as fee design.

**Next stage:** Install local Anchor toolchain; implement failing-first tests for **H5 → H3 → H1** only; kill hypotheses that the protocol correctly rejects.

---

## Files created this stage

| File | Purpose |
|------|---------|
| `/workspace/STAGE2_SECURITY_ANALYSIS.md` | This report |

**Production program source:** not modified.

---

*End Stage 2 — analysis only; no PoC execution; no network interaction.*

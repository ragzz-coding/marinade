# STAGE6_HYPOTHESES

At most five diff-driven hypotheses from `2614737 → 3e7c090`.  
Reject criteria: admin/manager/governance, victim signature, patched state, impossible protocol state, external infra — unless the bug itself grants that power.

---

## D6-1 — `create_canonical_stake` list / balance desync

### ID
D6-1

### Commit/change introducing it
`e7e0bfd` / shipped in `3e7c090` (PR #84) — canonical PDA + `create_canonical_stake`

### Changed code
`instructions/crank/create_canonical_stake.rs`; `merge_stakes` destination PDA check

### Security invariant
Each lamport of marinade-controlled stake appears once in stake-list accounting; merge/create cannot duplicate or orphan controllable stake into attacker custody.

### Attacker-controlled input
Permissionless crank after `Done`: `source_stake_index`, `validator_index`, account metas (must satisfy PDA + list binding).

### Reachability from healthy state
Yes — after migration `Done`, anyone may call `create_canonical_stake`.

### Exact transaction sequence
1. Protocol in `Done` with ≥1 active listed stake for validator V.
2. Attacker calls `create_canonical_stake(source_i, V)`.
3. Optionally `merge_stakes` / further creates.

### Potential impact
Stolen SOL / double-counted active balance / drain via merge extras — **Critical** if real.

### Why the change may be vulnerable
New permissionless path rewrites list entries and moves full stake lamports via signed split; merge accounting uses `extra_delegated`.

### Why it might actually be safe
- `get_checked` binds index↔pubkey; voter must match validator.
- Native active + balance==last_update required.
- Split moves **all** lamports to PDA owned by marinade seeds; source removed from list; canonical added once.
- Re-create fails if PDA already stake-owned.
- Merge strengthened (canonical-only destination + `StakeStatus::Active`).

### Localnet PoC plan
Healthy pool → create canonical → assert list count, active totals, lamports conserved → second create fails → merge second stake into canonical → totals consistent.

### Verdict
**REJECTED** — no unauthorized custody or double-count under healthy constraints.

---

## D6-2 — Deposit-fee + LP full-fill path over-credits attacker mSOL

### ID
D6-2

### Commit/change introducing it
`fc217cd` / shipped in `3e7c090`

### Changed code
`deposit.rs`: fee then `calc_msol_from_lamports(lamports_minus_fee)`; unchanged LP branch still uses `sol_swapped = lamports` on full order fill.

### Security invariant
mSOL received ≤ fair value of SOL/stake contributed (after configured fee); attacker cannot mint unbacked mSOL.

### Attacker-controlled input
Deposit amount; timing vs LP mSOL balance; fee must be non-zero (admin-set; default 0 post-upgrade).

### Reachability from healthy state
Only if admin enabled fees (privileged config). Even then, user is the fee **payer**.

### Exact transaction sequence
1. Admin sets `deposit_sol_fee > 0` (out of attacker model for *enabling*, but assume fees live in prod).
2. Attacker deposits SOL while LP can fill `user_msol_buy_order`.
3. Observe mSOL out vs SOL in.

### Potential impact
Unbacked mSOL / LP drain — Critical/High if mint > assets.

### Why the change may be vulnerable
Fee shrinks buy order but full-fill still sends **full** `lamports` to LP — looks like a stale branch vs pre-fee semantics.

### Why it might actually be safe
User receives **less** mSOL (`lamports - fee` sized), not more. Extra SOL stays in LP (LP holders benefit) or reserve (mSOL holders benefit). No unbacked mint. Asymmetry is fee routing, not theft. Caps ≤ 0.2%. Stake deposit credits full stake while minting less — dilutive to depositor, beneficial to existing holders.

### Localnet PoC plan
Fee on → deposit with full LP fill → assert `msol_out == calc(lamports - fee)` and SOL conservation; compare mint-only path.

### Verdict
**REJECTED** — differential fee routing ≠ Immunefi theft; does not revive Stage 5 fee rejects.

---

## D6-3 — Upgrade zero-fill leaves `IteratingStakes`; attacker exploits migration window

### ID
D6-3

### Commit/change introducing it
`delinquent_upgrader` + `Default = IteratingStakes`; `State` append fields in #84

### Changed code
`state/delinquent_upgrader.rs`, `state/mod.rs`, `initialize.rs` (`Done` only on fresh init), crank/user gates

### Security invariant
During/after upgrade, attacker cannot move value or break exchange-rate solvency using migration-only state.

### Attacker-controlled input
Permissionless cranks + user deposit/deposit_stake during window.

### Reachability from healthy state
Healthy **post-migration** `Done` does not re-enter FSM without upgrade/admin path. Window exists only immediately after program upgrade (operator event). During window, many value-moving management/crank paths are **fail-closed** via `is_done()`.

### Exact transaction sequence
1. Program upgrade → zero `delinquent_upgrader`.
2. Attacker interleaves `deposit_stake` / `update_*` / `finalize_*`.
3. Attempt withdraw/merge/emergency while not `Done`.

### Potential impact
Accounting desync → insolvency (H3-class) or preferential mint.

### Why the change may be vulnerable
`Default` ≠ fresh `Done`; deposit_stake mutates `visited_count`/shadows; emergency path complex.

### Why it might actually be safe
- Fail-closed gates on withdraw_stake, merge, deactivate, stake_reserve, create_canonical, validator add/remove, emergency/partial.
- deposit_stake hooks intentionally preserve invariants (H5 closed).
- Emergency/finalize panic class already closed as non-bounty (not unprivileged from `Done`; requires native delinquent deactivation).
- Attacker cannot start migration from healthy `Done`.

### Localnet PoC plan
N/A for bounty from healthy `Done`. Migration-window tests already covered Stages 3–5.

### Verdict
**REJECTED** for bounty from healthy state; migration residual = prior closed work.

---

## D6-4 — `StakeStatus::Unknown` bypasses new Active checks after `Done`

### ID
D6-4

### Commit/change introducing it
`StakeStatus` on `StakeRecord` (`3e7c090`)

### Changed code
Zero padding → `Unknown`; `merge`/`withdraw`/`deactivate`/emergency require `Active`; `create_canonical` checks native only

### Security invariant
Deactivating/emergency stakes cannot be treated as fully active for user withdrawals or merges.

### Attacker-controlled input
Crank ordering; `create_canonical` on a stake still `Unknown` if any survived.

### Reachability from healthy state
After correct migration, all stakes should be `Active` or `Deactivating`. Leftover `Unknown` after `Done` would require incomplete iteration — progression to `IteratingValidators` counts `Unknown→Active` visits against stake list length; incomplete upgrade should not reach a consistent `Done` with stranded productive `Unknown` under normal cranking. `create_canonical` on `Unknown`+native-active only relocates to canonical Active — no withdraw privilege gain beyond existing active stake rights.

### Exact transaction sequence
1. Suppose `Unknown` stake remains with native active.
2. Attacker `create_canonical` or attempts `withdraw_stake_account`.

### Potential impact
Withdraw cooling-down stake / skip emergency accounting.

### Why the change may be vulnerable
Inconsistent status checks across ixs (`create_canonical` omits `last_update_status`).

### Why it might actually be safe
`withdraw_stake_account` / `merge` / `deactivate` require `Active`. `Unknown` cannot withdraw. Canonical create does not grant user withdrawal of marinade stake to attacker — it only re-keys marinade custody to PDA.

### Localnet PoC plan
Force `Unknown` after `Done` (would need patch → out of bounty) → confirm withdraw fails; create_canonical only moves custody internally.

### Verdict
**REJECTED** — no attacker value extraction; inconsistency is hardening gap at most, not a bounty path without patched state.

---

## D6-5 — List record growth / `additional_*_record_space` mis-parse

### ID
D6-5

### Commit/change introducing it
`StakeRecord` +`StakeStatus`; `ValidatorRecord` + shadow `u64`

### Changed code
`stake_system.rs`, `validator_system.rs`, `list.rs` item_size at init

### Security invariant
Record boundaries stable; attacker cannot reinterpret neighboring records to spoof stake pubkeys or balances.

### Attacker-controlled input
None on existing lists (`item_size` fixed at initialize by admin). Attacker cannot resize list header.

### Reachability from healthy state
Only if deploy upgraded program onto under-padded lists — **global** breakage / failed txs, not attacker-chosen corruption. Correct padding → extra bytes unused by `AnchorDeserialize` within larger `item_size`.

### Exact transaction sequence
N/A for unprivileged attacker on healthy correctly-padded deploy.

### Potential impact
Wrong stake account association → theft (theoretical).

### Why the change may be vulnerable
Struct size grew; readers use stored `item_size`.

### Why it might actually be safe
Attacker cannot set `item_size`. Under-padding is operator deploy risk. Over-padding is safe.

### Localnet PoC plan
Not bounty-eligible without admin initialize control.

### Verdict
**REJECTED** — deployment precondition, not unprivileged exploit.

---

## Summary

| ID | Theme | Verdict |
|----|-------|---------|
| D6-1 | Canonical stake create/merge | REJECTED |
| D6-2 | Deposit fee × LP fill differential | REJECTED |
| D6-3 | Upgrade Default / migration window | REJECTED (prior closed) |
| D6-4 | `Unknown` vs Active checks | REJECTED |
| D6-5 | List layout growth | REJECTED |

No hypothesis survived for Immunefi in-scope, attacker-reachable impact. No `STAGE6_POC_PLAN.md`.

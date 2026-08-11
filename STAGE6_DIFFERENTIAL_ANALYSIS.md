# STAGE6_DIFFERENTIAL_ANALYSIS

Primary diff base: `2614737` → `3e7c090` (tag `v2.1.0` / PR #84).  
Production tree unmodified. Upstream clone: `/tmp/marinade-upstream/liquid-staking-program`.

Closed findings (H3/H5/H1/H1-variant/S5-*) are **not** reopened; residual questions below are about *new* fix-introduced surfaces.

---

## 1. Security-relevant commit inspection

### 1.1 `3e7c090` / PR #84 (shipped)

**Before:** No delinquent-upgrader FSM; no `StakeStatus`; no deposit fees; `merge_stakes` allowed any marinade-listed destination; `redelegate` instruction existed; emergency/cooldown used `u8` flag only.

**After:** Combined delinquent detector + upgrade FSM, deposit SOL/stake fees, canonical stake PDA + permissionless `create_canonical_stake`, `merge_stakes` destination must be canonical, `redelegate` removed, many ops gated on `is_done()`.

**Intended invariant:** Detect stake accounts force-deactivated by the stake program (delinquent validators), migrate bookkeeping (`StakeStatus`, shadow balances), then resume normal ops. Optionally charge capped deposit fees.

**Residual assumptions:**

1. List accounts were initialized with enough `additional_*_record_space` for +1 byte (`StakeStatus`) and +8 bytes (`delinquent_upgrader_active_balance`).
2. After program upgrade, trailing `State` bytes are zero → `delinquent_upgrader = IteratingStakes{0,0,0}`, fees = 0 — migration **must** be cranked to `Done`.
3. Fresh `initialize` explicitly sets `Done` (does not rely on `Default`).
4. Cranks eventually visit every stake during `IteratingStakes`.
5. Emergency path in `update_deactivated` correctly adjusts `active` / `total_active` (shadow handled elsewhere) — H3 class panic is a **failed tx**, not value extraction, and is not unprivileged-inducible from healthy `Done`.

**New code:** FSM enum + finalize ix; `update.rs` upgrade/reward/slash hooks + emergency branch; deposit_stake FSM hooks; fee fields + apply on mint sizing; `create_canonical_stake`; merge PDA check; `is_done` gates.

### 1.2 PR #84 vs PR #81

PR #81 closed; delinquent work folded into #84 with deposit-fee + canonical stake. No separate shipped #81 tag.

### 1.3 `0f031c4`

On `fix-delinquent-plus-depositfee` tip only. **Not** ancestor of `3e7c090`. Diff: comment removal above `MAX_DEPOSIT_*_FEE`. **No semantic delta** for bounty `v2.1.0`.

---

## 2. Migration / upgrade security

| Question | Answer for PR #84 migration |
|----------|-----------------------------|
| Attacker influence initial field values? | No. Zero-fill on upgrade; fees stay 0 until admin `config_marinade`. |
| Partial migration? | Yes by design (multi-tx FSM). Gated ops refuse until `Done`. |
| Execute twice? | `Unknown→Active` is one-shot per stake; finalize consumes validator shadows; `Done` is terminal. |
| Permissionless crank wrong order? | `update_active` blocked in `IteratingValidators`; progression helpers enforce phase. Deposit_stake hooks preserve shadows (H5-closed pattern). |
| Interrupted mid-window? | Protocol stays in FSM; value ops that need `is_done` fail closed. |
| Epoch boundaries? | No special epoch gate for FSM completion; emergency still needs native deactivation. |
| Missing/dup/stale accounts? | List index + pubkey `get_checked`; wrong accounts fail. |
| Old state under new code? | Zero padding → `StakeStatus::Unknown` triggers upgrade path; `Default` for enum is `IteratingStakes` (matches upgrade zero-fill, **not** fresh init). |

**Layout risk:** If mainnet lists lack padding, deserialize/ops break for everyone (deploy failure), not a selective attacker theft path.

---

## 3. Deposit-fee differential (`fc217cd` → shipped in #84)

**Change:** Before mint/swap sizing, `fee.apply(amount)` then `calc_msol_from_lamports(amount - fee)`.

| Path | Behavior |
|------|----------|
| SOL deposit | Fee reduces `user_msol_buy_order`. Full SOL still transferred (LP and/or reserve). |
| Stake deposit | Full `delegation.stake` added to validator/total active; mSOL minted on `stake - fee`. |
| Caps | `MAX_DEPOSIT_*_FEE` = 0.2%; admin-only setters. |
| Default post-upgrade | 0 until configured. |
| Rounding | `FeeCents::apply` floors via integer division. |

**LP full-fill branch (differential nuance):** When `user_msol_buy_order == msol_swapped`, code still sets `sol_swapped = lamports` (entire deposit). After fees, that means LP receives full SOL while releasing mSOL sized to `lamports - fee`. Fee accrues to **LP holders**, not an external attacker. Mint path accrues fee to **mSOL holders** via reserve. Path-dependent fee beneficiary is economic design, not an invariant break. Stage 5 already rejected obvious fee-theft angles; this historical reading does not revive them.

**Stake vs SOL:** Stake path credits full stake while minting less — existing mSOL holders gain. Attacker depositing cannot mint above contributed stake.

---

## 4. Canonical stake / merge

**`create_canonical_stake` (permissionless after `Done`):**

- Requires native active delegation, marinade list binding, voter match, updated balances.
- Does **not** require `last_update_status == Active` (only native checks) — after `Done`, moving a leftover `Unknown` into canonical is harmless.
- Splits **all** source lamports into PDA; removes source list entry; adds canonical as Active.
- Second create fails (`CanonicalStakeAccountAlreadyCreated`).
- Dust on PDA system account withdrawn to `operational_sol_account` before allocate.

**`merge_stakes`:** Destination **must** be canonical PDA; both sides require `StakeStatus::Active` + native active. Stronger than pre-#84 (any listed destination). Merge DoS until canonical exists is mitigated by permissionless create.

**No fund double-count found:** one list remove + one add; merge removes source after consolidating delegation accounting.

---

## 5. Account-constraint differential

Reviewed `has_one` / `constraint` / `seeds` / `bump` / `owner` / `address` / `mut` / `signer` deltas in PR #84 instruction contexts.

- **No weakening** of fund-moving relationships observed.
- New constraints are additive: `is_done` gates, canonical address equality, `StakeStatus::Active` where emergency/withdraw/merge/deactivate need active stakes.
- `redelegate` removal deletes an entire privileged-move surface rather than loosening it.
- List accounts remain `address = state.*_list.account` (unchanged binding pattern).

---

## 6. Fix-adjacent questions (explicitly not re-running H3)

| Question | Result |
|----------|--------|
| New accounting diverge via other legitimate ix? | deposit_stake / rewards / slash hooks adjust shadows in `IteratingStakes`; validator phase zeros visited validators. Reviewed; no new theft path. |
| New state initialized wrong? | Fresh init → `Done` + zero fees. Upgrade → `IteratingStakes` + zero fees. Consistent with design. |
| Old account bypass new invariant? | `Unknown` must be upgraded before merge/withdraw/etc. that require `Active`. |
| Stale field? | Shadows zeroed through validator iteration + finalize; after `Done` unused. |
| Valid transition twice? | `Unknown→Active` once; finalize once to `Done`. |
| Old vs new accounting mismatch? | Emergency reduces active not shadow → finalize panic class (H3); not unprivileged from healthy `Done`. |
| Crank order violate assumption? | Phase checks + `update_active` block in validator iteration. |

---

## 7. Priority surfaces vs noise

**Worth audit time:** FSM migration, emergency/`StakeStatus`, deposit fee mint sizing, canonical create/merge, list layout padding assumption, slash `checked`/non-saturating subs (fail closed).

**Not worth:** README, comment-only `0f031c4`, event renames, formatting.

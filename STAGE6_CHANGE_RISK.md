# STAGE6_CHANGE_RISK

Security-meaningful changes in `2614737 → 3e7c090` (PR #84 / `v2.1.0`). Formatting-only and README omitted.

| Change | Security Surface | Attacker Input | Potential Impact | Risk |
| ------ | ---------------- | -------------- | ---------------- | ---- |
| `DelinquentUpgraderState` FSM + `finalize_delinquent_upgrade` | Migration / stake-status upgrade | Permissionless cranks during window | Freeze / accounting panic if bad interleave | **High code risk, Low bounty risk** (H3 closed: not unprivileged-inducible) |
| `StakeStatus` on `StakeRecord`; `bool` replaces `u8` emergency flag | Record layout + migration via `additional_*_record_space` padding | None directly; needs deploy padding | Mis-deserialize / Unknown default | Medium deploy; Low attacker |
| `ValidatorRecord.delinquent_upgrader_active_balance` | Shadow accounting for finalize | Cranks / deposit_stake during window | Finalize underflow if shadow desync | High code; bounty closed as H3 |
| `update_active` blocked in `IteratingValidators` | Ordering invariant | Cannot call successfully in that phase | Forces use of other ixs | Low |
| Emergency path in `update_deactivated` when Active+deactivating | Forced native deactivate handling | Needs native deactivation | Active/shadow desync | High code; H3 reachability failed |
| `deposit_stake_account` FSM hooks (`visited_count` / shadows) | Migration compatibility | User deposit_stake during window | Premature/incorrect FSM progress | Medium; H5-style paths reviewed safe |
| Gate `is_done()` on add/remove validator, emergency/partial unstake, withdraw_stake, stake_reserve, deactivate, merge, create_canonical | Temporary feature freeze during migration | None (honest cranks finish window) | Temporary freeze of gated ops | Low (intentional; temporary) |
| Remove `redelegate` ix | Stake lifecycle | N/A | Orphan redelegate-era accounts? | Low (update uses lamports−rent) |
| Canonical stake PDA + `create_canonical_stake` | Stake consolidation | Permissionless after `Done` | Wrong split / list corruption | Medium → analyzed Low |
| `merge_stakes` destination must be canonical PDA | Merge integrity | Permissionless | Merge DoS until canonical created | Low (permissionless create) |
| `deposit_sol_fee` / `deposit_stake_account_fee` | Mint amount vs assets taken | User deposits | Fee asymmetry / LP fill | Medium economic → Stage5 rejected |
| `config_marinade` fee setters + 0.2% caps | Admin fee config | Admin only | Misconfig | Out of attacker model |
| Slash path: saturating → checked sub | update_active arithmetic | Chain slash / desync | Tx panic (no commit) | Low (DoS-ish, not theft) |
| `0f031c4` TODO removal | Comment only | N/A | None | None (not in tag) |

---

## Risk summary

- The **largest new surface** is the delinquent-upgrader migration + emergency deactivation accounting. Residual **bounty** risk was previously exhausted (H3 non-reachable; H5/H1/H1-variant closed).
- **Stage 6 differential focus:** canonical stake create/merge, deposit-fee × LP fill branch, upgrade zero-fill/`Default`, `StakeStatus::Unknown` gaps, list padding — formalized as D6-1…D6-5; **all rejected** (see `STAGE6_HYPOTHESES.md` / `STAGE6_RESULTS.md`).
- Layout growth of list records **assumes** sufficient `additional_*_record_space` from original initialize; that is a **deployment precondition**, not an unprivileged attack.
- Account-constraint diffs in PR #84 are **strengthening or additive** (canonical destination, `is_done`, `StakeStatus::Active`); no fund-path weakening found.

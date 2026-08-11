# STAGE6_VERSION_PROVENANCE

## Network

GitHub network access: **available**.  
Read-only clone: `/tmp/marinade-upstream/liquid-staking-program`  
Upstream: `https://github.com/marinade-finance/liquid-staking-program`  
Working production tree under `/workspace/liquid-staking-program-main` was **not** modified for this stage.

---

## Claimed identity (Immunefi / local tree)

| Field | Value |
|-------|-------|
| `source_release` (security.txt) | `v2.1.0` |
| Program | `marinade-finance` |
| Program ID | `MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD` |

---

## Upstream match

| Ref | Commit | Date |
|-----|--------|------|
| Tag `v2.1.0` | `3e7c0904945a9fd6ddda6eddf10e19ab5b717a81` | 2026-06-22 |
| Message | `Fix delinquent + depositfee [GEN-6077] (#84)` | |

**Local `programs/marinade-finance/src` matches tag `v2.1.0` / `3e7c090` byte-for-byte** on sampled and directory-compared sources (`lib.rs`, delinquent upgrader, finalize, deposit paths, full `src/` tree via `diff -rq`).

**Conclusion:** Immunefi-supplied tree **is** upstream `v2.1.0` (`3e7c090`).

---

## Immediate neighbors

| Ref | Commit | Role |
|-----|--------|------|
| First-parent before `v2.1.0` | `26147376b75d8c971963da458623e646f2795e15` | `[readme] update audit links` (pre-PR#84 main) |
| `v2.1.0` / PR #84 squash | `3e7c090…` | Delinquent fix + deposit fees + canonical stake |
| After tag on `main` | `b8fe3f8…` | `[trivial] Update README.md (#89)` — no program logic |

---

## Requested commits

### `3e7c090` (tag `v2.1.0`, PR #84)

Squash-merge of combined work:

1. Delinquent stake detector / upgrader FSM (from PR #81 lineage)
2. Deposit SOL + stake fees (Jon C `depositfee` branch)
3. Canonical stake PDA + `create_canonical_stake` / merge destination enforcement
4. Removal of `redelegate` instruction

PR: https://github.com/marinade-finance/liquid-staking-program/pull/84  
(+885 / −552 across 28 files)

### PR #81

https://github.com/marinade-finance/liquid-staking-program/pull/81 — **closed**; commits folded into #84.

### `0f031c4`

| Field | Value |
|-------|-------|
| Full hash | `0f031c4e210a47080b09ae04731ae0984256bf4a` |
| Message | `limits checked and confirmed ok` |
| Branch | `origin/fix-delinquent-plus-depositfee` (tip at clone time) |
| Relation to `v2.1.0` | **Not an ancestor of `3e7c090`** |
| Diff | Removes a `TODO: Check these limits` comment above `MAX_DEPOSIT_*_FEE` in `state/mod.rs` |

`0f031c4` is post-squash polish on the working branch tip; **not** in the tagged `v2.1.0` history. Fee max constants (0.2%) are already present in `3e7c090`.

---

## Pre-squash lineage (for differential understanding)

Recovered from `origin/fix-delinquent-plus-depositfee` (informative; squash is what shipped):

| Commit | Theme |
|--------|-------|
| `1c46d37` | Detector for forced unstake from delinquent validator |
| `de13a0b` | Replace bool by enum; upgrade data process |
| `cb0890e` | Disable add/remove validator while upgrading |
| `1f3d027` | Remove redelegate |
| `9093131` | Maintain FSM invariants in `deposit_stake_account` |
| `6c560c1` | Block `update_active` during validator iteration |
| `e7e0bfd` | Canonical stake PDA |
| `fc217cd` | SOL + stake deposit fees |
| `26aec2d` | Merge depositfee ↔ fix-delinquent |
| `0f031c4` | Comment-only fee-limit TODO removal (branch tip only) |

---

## Diff bases used in Stage 6

1. **`2614737` → `3e7c090`** — previous main → bounty version (primary)
2. Component commits on the feature branch for fee / canonical / FSM (secondary)
3. **`0f031c4`** — confirmed non-shipping for `v2.1.0`; no program semantic delta vs tag beyond comment on unreleased branch tip

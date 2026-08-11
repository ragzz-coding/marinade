# STAGE6_RESULTS

## Verdict

**Clean negative.** Stage 6 history / differential review of Marinade `v2.1.0` (`3e7c090` / PR #84) found **no** historically introduced, unprivileged-attacker-reachable invariant violation with Immunefi in-scope impact.

Prior closed findings (H3, H5, H1, H1-variant, S5-1…S5-5) were **not** reopened.

---

## What was established

1. **Provenance:** Local Immunefi tree `programs/marinade-finance/src` matches upstream tag `v2.1.0` = `3e7c090` byte-for-byte. Program ID unchanged.
2. **Neighbors:** Parent `2614737` (readme); post-tag `b8fe3f8` (readme only).
3. **`0f031c4`:** Comment-only on unreleased branch tip; **not** in tagged history.
4. **Diff focus:** Delinquent FSM + emergency accounting, deposit fees, canonical stake/merge hardening, `redelegate` removal, record layout growth, constraint/`is_done` gates.

---

## Hypotheses (all rejected)

| ID | Result |
|----|--------|
| D6-1 Canonical create/merge desync | REJECTED |
| D6-2 Deposit fee × LP full-fill mint | REJECTED |
| D6-3 Upgrade zero-fill migration abuse | REJECTED |
| D6-4 `StakeStatus::Unknown` bypass | REJECTED |
| D6-5 List padding / layout reinterpret | REJECTED |

---

## Artifacts

| File | Role |
|------|------|
| `STAGE6_VERSION_PROVENANCE.md` | Tag/commit identity |
| `STAGE6_CHANGE_RISK.md` | Security change risk table |
| `STAGE6_DIFFERENTIAL_ANALYSIS.md` | Before/after + migration + fee + constraints |
| `STAGE6_HYPOTHESES.md` | ≤5 diff-driven hypotheses |
| `STAGE6_RESULTS.md` | This summary |

No `STAGE6_POC_PLAN.md` (nothing survived).

---

## Scope adherence

- Production program source **unchanged**.
- History via read-only upstream clone; no fabricated commits.
- No mainnet/testnet interaction; no Immunefi submission.

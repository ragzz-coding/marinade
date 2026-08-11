# STAGE5_RESULTS

## Executive verdict

**No bounty-grade vulnerability identified in this Stage 5 pass.**

Attack-surface and value-flow maps were built for the full instruction set. Five strongest attacker-first hypotheses were evaluated; **all were rejected** on reachability and/or Immunefi impact.

| Closed earlier | Stage 5 |
|----------------|---------|
| H5, H1, H1-variant, H3 (non-bounty) | H-S5-1…5 rejected |

A clean “not vulnerable under attacker-first bar” is the correct outcome for this pass.

---

## Methodology applied

For every “code can break if state Y” idea:

1. Can an unprivileged attacker create Y?
2. Can they control the relevant accounts/values?
3. Under normal protocol operation?
4. In-scope Immunefi impact?
5. Reproducible on localnet without patching?

If any fails → kill hypothesis.

---

## Artifacts

| File | Content |
|------|---------|
| `STAGE5_ATTACK_SURFACE.md` | Full ix classification, PDA map, user/crank notes |
| `STAGE5_VALUE_FLOW.md` | Deposit/withdraw/LP/ticket conservation |
| `STAGE5_HYPOTHESES.md` | Five hypotheses with reachability kills |

Production source: **untouched**.

---

## Strongest near-misses (not findings)

1. **`proportional` when `den==0`** — real footgun if `virtual==0`∧`supply>0`, but that state is not creatable by unprivileged unstake math alone (needs under_control drop / slash).
2. **`WAIT_EPOCHS=0` + fee 0** — can shift illiquidity onto LP; attacker does not extract risk-free profit; mitigated by deposit stake fee design in v2.1.0.
3. **`deposit` skips `liquidity_sol_cap`** — config bypass only.

---

## Next step (if continuing)

Pick a **new** code region not covered by rejected hypotheses (e.g. deeper fee rounding amplification across epochs with mainnet-like fee config, or stake_delta edge cases with real localnet), still under the same attacker-first bar. Do not reopen H3–H5.

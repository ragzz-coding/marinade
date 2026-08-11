# Stage 4 — FSM setup sequence (from source)

## Fresh initialize

`initialize` sets `delinquent_upgrader = Done` (`initialize.rs`).

`Default` for the enum is `IteratingStakes {0,0,0}` — used for **account upgrades** / zeroed new fields, not a runtime instruction that re-enters Stakes from Done.

## Production path to IteratingValidators

```text
T0  State after program upgrade / Default → IteratingStakes { visited_count=0, total_active=0, total_delinquent=0 }
    Stake records typically last_update_status=Unknown

T1  update_active(stake_i) for each Unknown stake
    → delinquent_upgrade: Unknown→Active, visited_count++, shadow+=amount
    (blocked if already IteratingValidators)

T2  When visited_count == stake_count AND FSM.total_active == validator_system.total_active
    → check_delinquent_upgrade_state_progression
    → IteratingValidators { visited_count=0, delinquent_balance_left=total_delinquent }

T3  finalize_delinquent_upgrade(max)
    → for each pending validator: left -= (active - shadow); active = shadow; shadow = 0
    → when all validators visited and left==0 → Done
```

`update_deactivated` during `IteratingStakes` can also call the same progression helper after removing a stake.

## Localnet H3 shortcut

Because no ix re-enters `IteratingStakes` from `Done`, Stage 4:

1. Built real accounts via `initialize` + `add_validator` + `stake_reserve` / `deposit_stake_account` (FSM=`Done`)
2. Offline-patched bytes → `IteratingValidators` + shadows = active + stake `deactivation_epoch=0`
3. Ran real `update_deactivated` + `finalize_delinquent_upgrade` against production BPF

## Stake deactivation observation

Program reads `StakeAccount.delegation().deactivation_epoch` (native stake program state).  
Minimum realistic local setup: real stake accounts + withdrawable deactivated delegation. Epoch warp (`--slots-per-epoch` / `--warp-slot`) required so `deactivation_epoch < current_epoch` allows withdraw.

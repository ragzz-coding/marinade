//! Pure-Rust mirror of Marinade delinquent-upgrader accounting.
//!
//! Logic is intentionally copied from:
//! - instructions/crank/finalize_delinquent_upgrade.rs
//! - instructions/crank/update.rs (emergency + progression + IteratingStakes deactivated)
//! - instructions/user/deposit_stake_account.rs (FSM match arms)
//!
//! This is MODEL evidence. It does not execute Anchor/Solana transactions.

#![allow(dead_code)]

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DelinquentUpgraderState {
    IteratingStakes {
        visited_count: u32,
        total_active_balance: u64,
        total_delinquent_balance: u64,
    },
    IteratingValidators {
        visited_count: u32,
        delinquent_balance_left: u64,
    },
    Done,
}

impl DelinquentUpgraderState {
    pub fn is_done(&self) -> bool {
        matches!(self, Self::Done)
    }
    pub fn is_iterating_stakes(&self) -> bool {
        matches!(self, Self::IteratingStakes { .. })
    }
    pub fn is_iterating_validators(&self) -> bool {
        matches!(self, Self::IteratingValidators { .. })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StakeStatus {
    Unknown,
    Active,
    Deactivating,
}

#[derive(Clone, Debug)]
pub struct Validator {
    pub active_balance: u64,
    pub delinquent_upgrader_active_balance: u64, // shadow
}

#[derive(Clone, Debug)]
pub struct StakeRec {
    pub validator_index: u32,
    pub last_update_delegated_lamports: u64,
    pub last_update_status: StakeStatus,
    pub is_emergency_unstaking: bool,
    /// When true, on-chain stake is deactivating (model flag).
    pub on_chain_deactivating: bool,
}

#[derive(Clone, Debug)]
pub struct Model {
    pub fsm: DelinquentUpgraderState,
    pub validators: Vec<Validator>,
    pub stakes: Vec<StakeRec>,
    pub total_active_balance: u64,
    pub delayed_unstake_cooling_down: u64,
    pub emergency_cooling_down: u64,
    pub available_reserve_balance: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ModelErr {
    PausedOrGate,
    UpgradingInvariantViolation,
    DelinquentUpgraderIsNotDone,
    RequiredActiveStake,
    RequiredDeactivatingStake,
    StakeAccountIsEmergencyUnstaking,
    ArithmeticOverflow,
    Other(&'static str),
}

impl Model {
    pub fn stake_count(&self) -> u32 {
        self.stakes.len() as u32
    }
    pub fn validator_count(&self) -> u32 {
        self.validators.len() as u32
    }

    /// Mirrors check_delinquent_upgrade_state_progression (update.rs:274-296)
    pub fn check_progression(&mut self) -> Result<(), ModelErr> {
        match self.fsm {
            DelinquentUpgraderState::IteratingStakes {
                visited_count,
                total_active_balance,
                total_delinquent_balance,
            } => {
                if visited_count == self.stake_count() {
                    if total_active_balance != self.total_active_balance {
                        return Err(ModelErr::UpgradingInvariantViolation);
                    }
                    self.fsm = DelinquentUpgraderState::IteratingValidators {
                        visited_count: 0,
                        delinquent_balance_left: total_delinquent_balance,
                    };
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Mirrors deposit_stake_account FSM arms + active/total updates
    /// (deposit_stake_account.rs:142-166, 305)
    pub fn deposit_stake_account(
        &mut self,
        validator_index: u32,
        stake_lamports: u64,
    ) -> Result<(), ModelErr> {
        let v = self
            .validators
            .get_mut(validator_index as usize)
            .ok_or(ModelErr::Other("bad validator"))?;
        v.active_balance = v
            .active_balance
            .checked_add(stake_lamports)
            .ok_or(ModelErr::ArithmeticOverflow)?;

        match &mut self.fsm {
            DelinquentUpgraderState::IteratingStakes {
                visited_count,
                total_active_balance,
                ..
            } => {
                *visited_count = visited_count
                    .checked_add(1)
                    .ok_or(ModelErr::ArithmeticOverflow)?;
                *total_active_balance = total_active_balance
                    .checked_add(stake_lamports)
                    .ok_or(ModelErr::ArithmeticOverflow)?;
                v.delinquent_upgrader_active_balance = v
                    .delinquent_upgrader_active_balance
                    .checked_add(stake_lamports)
                    .ok_or(ModelErr::ArithmeticOverflow)?;
            }
            DelinquentUpgraderState::IteratingValidators { visited_count, .. } => {
                if validator_index >= *visited_count {
                    v.delinquent_upgrader_active_balance = v
                        .delinquent_upgrader_active_balance
                        .checked_add(stake_lamports)
                        .ok_or(ModelErr::ArithmeticOverflow)?;
                }
            }
            DelinquentUpgraderState::Done => {}
        }

        self.total_active_balance = self
            .total_active_balance
            .checked_add(stake_lamports)
            .ok_or(ModelErr::ArithmeticOverflow)?;

        self.stakes.push(StakeRec {
            validator_index,
            last_update_delegated_lamports: stake_lamports,
            last_update_status: StakeStatus::Active,
            is_emergency_unstaking: false,
            on_chain_deactivating: false,
        });
        Ok(())
    }

    /// Mirrors finalize_delinquent_upgrade.rs:21-72 with overflow-checked arithmetic
    pub fn finalize_delinquent_upgrade(&mut self, mut max_validators: u32) -> Result<(), ModelErr> {
        let (visited_count, delinquent_balance_left) = if let DelinquentUpgraderState::IteratingValidators {
            mut visited_count,
            mut delinquent_balance_left,
        } = self.fsm.clone()
        {
            while visited_count < self.validator_count() && max_validators > 0 {
                let validator = &mut self.validators[visited_count as usize];
                // Exact expression from source:
                // delinquent_balance_left -= active_balance - delinquent_upgrader_active_balance
                let delta = validator
                    .active_balance
                    .checked_sub(validator.delinquent_upgrader_active_balance)
                    .ok_or(ModelErr::ArithmeticOverflow)?;
                delinquent_balance_left = delinquent_balance_left
                    .checked_sub(delta)
                    .ok_or(ModelErr::ArithmeticOverflow)?;
                validator.active_balance = validator.delinquent_upgrader_active_balance;
                validator.delinquent_upgrader_active_balance = 0;
                visited_count += 1;
                max_validators -= 1;
            }
            (visited_count, delinquent_balance_left)
        } else {
            return Err(ModelErr::UpgradingInvariantViolation);
        };

        if visited_count == self.validator_count() {
            if delinquent_balance_left != 0 {
                return Err(ModelErr::UpgradingInvariantViolation);
            }
            self.fsm = DelinquentUpgraderState::Done;
        } else {
            self.fsm = DelinquentUpgraderState::IteratingValidators {
                visited_count,
                delinquent_balance_left,
            };
        }
        Ok(())
    }

    /// Mirrors update_active Unknown→Active upgrade piece (update.rs:470-502)
    pub fn update_active_upgrade_unknown(&mut self, stake_index: u32) -> Result<(), ModelErr> {
        if self.fsm.is_iterating_validators() {
            return Err(ModelErr::DelinquentUpgraderIsNotDone);
        }
        let stake = self
            .stakes
            .get_mut(stake_index as usize)
            .ok_or(ModelErr::Other("bad stake"))?;
        if stake.on_chain_deactivating {
            return Err(ModelErr::RequiredActiveStake);
        }
        if stake.last_update_status == StakeStatus::Deactivating {
            return Err(ModelErr::RequiredActiveStake);
        }
        if stake.last_update_status == StakeStatus::Unknown {
            stake.last_update_status = StakeStatus::Active;
            let amount = stake.last_update_delegated_lamports;
            let v_idx = stake.validator_index;
            match &mut self.fsm {
                DelinquentUpgraderState::IteratingStakes {
                    visited_count,
                    total_active_balance,
                    ..
                } => {
                    *visited_count += 1;
                    *total_active_balance = total_active_balance
                        .checked_add(amount)
                        .ok_or(ModelErr::ArithmeticOverflow)?;
                    if *total_active_balance > self.total_active_balance {
                        return Err(ModelErr::UpgradingInvariantViolation);
                    }
                    let v = &mut self.validators[v_idx as usize];
                    v.delinquent_upgrader_active_balance = v
                        .delinquent_upgrader_active_balance
                        .checked_add(amount)
                        .ok_or(ModelErr::ArithmeticOverflow)?;
                    if v.delinquent_upgrader_active_balance > v.active_balance {
                        return Err(ModelErr::UpgradingInvariantViolation);
                    }
                }
                _ => return Err(ModelErr::UpgradingInvariantViolation),
            }
        }
        self.check_progression()
    }

    /// Mirrors update_deactivated emergency + cooling/delinquent + remove
    /// (update.rs:548-709) — accounting subset only
    pub fn update_deactivated(&mut self, stake_index: u32) -> Result<(), ModelErr> {
        let stake = self
            .stakes
            .get(stake_index as usize)
            .ok_or(ModelErr::Other("bad stake"))?
            .clone();
        if !stake.on_chain_deactivating {
            return Err(ModelErr::RequiredDeactivatingStake);
        }

        let amount = stake.last_update_delegated_lamports;
        let v_idx = stake.validator_index as usize;

        // Emergency conversion if record still Active
        if stake.last_update_status == StakeStatus::Active {
            if stake.is_emergency_unstaking {
                return Err(ModelErr::StakeAccountIsEmergencyUnstaking);
            }
            self.emergency_cooling_down = self
                .emergency_cooling_down
                .checked_add(amount)
                .ok_or(ModelErr::ArithmeticOverflow)?;
            self.total_active_balance = self
                .total_active_balance
                .checked_sub(amount)
                .ok_or(ModelErr::ArithmeticOverflow)?;
            self.validators[v_idx].active_balance = self.validators[v_idx]
                .active_balance
                .checked_sub(amount)
                .ok_or(ModelErr::ArithmeticOverflow)?;
            // NOTE: shadow (delinquent_upgrader_active_balance) is NOT adjusted — mirrors source
        }

        // Withdraw to reserve (model)
        self.available_reserve_balance = self
            .available_reserve_balance
            .checked_add(amount)
            .ok_or(ModelErr::ArithmeticOverflow)?;

        if amount != 0 {
            if self.fsm.is_iterating_stakes() {
                let delinquent_amount = if !{
                    // After Active emergency path, is_emergency_unstaking is true in source
                    if stake.last_update_status == StakeStatus::Active {
                        true
                    } else {
                        stake.is_emergency_unstaking
                    }
                } {
                    let available = self.delayed_unstake_cooling_down.min(amount);
                    self.delayed_unstake_cooling_down -= available;
                    amount - available
                } else {
                    let available = self.emergency_cooling_down.min(amount);
                    self.emergency_cooling_down -= available;
                    amount - available
                };
                if let DelinquentUpgraderState::IteratingStakes {
                    total_delinquent_balance,
                    ..
                } = &mut self.fsm
                {
                    *total_delinquent_balance = total_delinquent_balance
                        .checked_add(delinquent_amount)
                        .ok_or(ModelErr::ArithmeticOverflow)?;
                }
                self.total_active_balance = self
                    .total_active_balance
                    .checked_sub(delinquent_amount)
                    .ok_or(ModelErr::ArithmeticOverflow)?;
            } else {
                // Validators or Done
                let is_em = if stake.last_update_status == StakeStatus::Active {
                    true
                } else {
                    stake.is_emergency_unstaking
                };
                if !is_em {
                    self.delayed_unstake_cooling_down = self
                        .delayed_unstake_cooling_down
                        .checked_sub(amount)
                        .ok_or(ModelErr::ArithmeticOverflow)?;
                } else {
                    self.emergency_cooling_down = self
                        .emergency_cooling_down
                        .checked_sub(amount)
                        .ok_or(ModelErr::ArithmeticOverflow)?;
                }
            }
        }

        self.stakes.remove(stake_index as usize);
        self.check_progression()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Baseline: two validators, both pending, left matches sum(active-shadow)
    fn base_iterating_validators() -> Model {
        // V0: active=100, shadow=80 → delta 20
        // V1: active=50, shadow=50 → delta 0
        // left = 20
        Model {
            fsm: DelinquentUpgraderState::IteratingValidators {
                visited_count: 0,
                delinquent_balance_left: 20,
            },
            validators: vec![
                Validator {
                    active_balance: 100,
                    delinquent_upgrader_active_balance: 80,
                },
                Validator {
                    active_balance: 50,
                    delinquent_upgrader_active_balance: 50,
                },
            ],
            stakes: vec![],
            total_active_balance: 150,
            delayed_unstake_cooling_down: 0,
            emergency_cooling_down: 0,
            available_reserve_balance: 0,
        }
    }

    // ===================== H5 =====================

    #[test]
    fn h5_deposit_into_already_finalized_validator_then_finalize_succeeds() {
        let mut m = base_iterating_validators();

        // T1: finalize only V0
        m.finalize_delinquent_upgrade(1).expect("finalize V0");
        match &m.fsm {
            DelinquentUpgraderState::IteratingValidators {
                visited_count,
                delinquent_balance_left,
            } => {
                assert_eq!(*visited_count, 1);
                assert_eq!(*delinquent_balance_left, 0); // 20 - (100-80)
            }
            other => panic!("expected IteratingValidators, got {other:?}"),
        }
        assert_eq!(m.validators[0].active_balance, 80); // set to shadow
        assert_eq!(m.validators[0].delinquent_upgrader_active_balance, 0);

        // T2: deposit into already-finalized V0
        m.deposit_stake_account(0, 25).expect("deposit into V0");
        assert_eq!(m.validators[0].active_balance, 105); // 80+25
        assert_eq!(m.validators[0].delinquent_upgrader_active_balance, 0); // NOT increased
        assert_eq!(m.total_active_balance, 175); // 150+25

        // T3: finalize remaining (V1) → Done
        m.finalize_delinquent_upgrade(10).expect("finalize rest");
        assert!(m.fsm.is_done(), "H5 must reach Done");
        assert_eq!(m.validators[1].active_balance, 50);
        // V0 keeps deposit
        assert_eq!(m.validators[0].active_balance, 105);
    }

    #[test]
    fn h5_deposit_into_pending_validator_preserves_finalize() {
        let mut m = base_iterating_validators();
        // Deposit into V1 (pending, index 1 >= visited 0)
        m.deposit_stake_account(1, 10).expect("deposit V1");
        assert_eq!(m.validators[1].active_balance, 60);
        assert_eq!(m.validators[1].delinquent_upgrader_active_balance, 60); // both +10
        // delta for V1 still 0; left still 20
        m.finalize_delinquent_upgrade(10).expect("full finalize");
        assert!(m.fsm.is_done());
        assert_eq!(m.validators[1].active_balance, 60);
    }

    // ===================== H3 =====================

    #[test]
    fn h3_update_deactivated_emergency_on_pending_validator_breaks_finalize() {
        // Setup: IteratingValidators, V0 pending with shadow including stake S=80
        // active=100, shadow=80, left=20 (includes V0 delta + maybe others — single validator)
        let mut m = Model {
            fsm: DelinquentUpgraderState::IteratingValidators {
                visited_count: 0,
                delinquent_balance_left: 20,
            },
            validators: vec![Validator {
                active_balance: 100,
                delinquent_upgrader_active_balance: 80,
            }],
            stakes: vec![StakeRec {
                validator_index: 0,
                last_update_delegated_lamports: 80,
                last_update_status: StakeStatus::Active, // upgraded during IteratingStakes
                is_emergency_unstaking: false,
                on_chain_deactivating: true, // Solana force-deactivate
            }],
            total_active_balance: 100,
            delayed_unstake_cooling_down: 0,
            emergency_cooling_down: 0,
            available_reserve_balance: 0,
        };

        // T4: permissionless update_deactivated — emergency path reduces active, NOT shadow
        m.update_deactivated(0)
            .expect("update_deactivated should succeed");
        assert_eq!(m.validators[0].active_balance, 20); // 100-80
        assert_eq!(m.validators[0].delinquent_upgrader_active_balance, 80); // unchanged
        assert_eq!(m.stakes.len(), 0);
        assert!(m.fsm.is_iterating_validators());

        // T5: finalize tries active - shadow = 20 - 80 → overflow
        let err = m
            .finalize_delinquent_upgrade(10)
            .expect_err("finalize must fail");
        assert_eq!(err, ModelErr::ArithmeticOverflow);
        assert!(
            !m.fsm.is_done(),
            "FSM must remain not Done — permanently stuck for this validator"
        );
        // Retry also fails
        let err2 = m.finalize_delinquent_upgrade(10).expect_err("retry fails");
        assert_eq!(err2, ModelErr::ArithmeticOverflow);
    }

    #[test]
    fn h3_emergency_on_already_finalized_validator_still_allows_done() {
        // Finalize V0 first, then emergency on a stake that belonged to V0
        let mut m = Model {
            fsm: DelinquentUpgraderState::IteratingValidators {
                visited_count: 0,
                delinquent_balance_left: 20,
            },
            validators: vec![
                Validator {
                    active_balance: 100,
                    delinquent_upgrader_active_balance: 80,
                },
                Validator {
                    active_balance: 50,
                    delinquent_upgrader_active_balance: 50,
                },
            ],
            stakes: vec![StakeRec {
                validator_index: 0,
                last_update_delegated_lamports: 30,
                last_update_status: StakeStatus::Active,
                is_emergency_unstaking: false,
                on_chain_deactivating: true,
            }],
            total_active_balance: 150,
            delayed_unstake_cooling_down: 0,
            emergency_cooling_down: 0,
            available_reserve_balance: 0,
        };

        m.finalize_delinquent_upgrade(1).expect("finalize V0");
        // V0 active=80, shadow=0, left=0
        assert_eq!(m.validators[0].active_balance, 80);

        // Emergency after finalize: active 80-30=50, shadow=0 → OK for later (V0 already done)
        m.update_deactivated(0).expect("emergency after finalize");
        assert_eq!(m.validators[0].active_balance, 50);

        m.finalize_delinquent_upgrade(10).expect("finish V1 → Done");
        assert!(m.fsm.is_done());
    }

    // ===================== H1 =====================

    #[test]
    fn h1_progression_requires_visited_eq_stake_count_and_balance_eq() {
        let mut m = Model {
            fsm: DelinquentUpgraderState::IteratingStakes {
                visited_count: 1,
                total_active_balance: 100,
                total_delinquent_balance: 0,
            },
            validators: vec![Validator {
                active_balance: 150,
                delinquent_upgrader_active_balance: 100,
            }],
            stakes: vec![
                StakeRec {
                    validator_index: 0,
                    last_update_delegated_lamports: 100,
                    last_update_status: StakeStatus::Active,
                    is_emergency_unstaking: false,
                    on_chain_deactivating: false,
                },
                StakeRec {
                    validator_index: 0,
                    last_update_delegated_lamports: 50,
                    last_update_status: StakeStatus::Unknown,
                    is_emergency_unstaking: false,
                    on_chain_deactivating: false,
                },
            ],
            total_active_balance: 150,
            delayed_unstake_cooling_down: 0,
            emergency_cooling_down: 0,
            available_reserve_balance: 0,
        };

        // visited=1, stake_count=2 → no transition
        m.check_progression().unwrap();
        assert!(m.fsm.is_iterating_stakes());

        // Upgrade second stake
        m.update_active_upgrade_unknown(1).unwrap();
        // visited=2, FSM total=150, total_active=150 → transition
        assert!(
            m.fsm.is_iterating_validators(),
            "should enter IteratingValidators: {:?}",
            m.fsm
        );
    }

    #[test]
    fn h1_balance_mismatch_when_counts_equal_blocks_progression_and_is_recoverable_by_fixing_balance(
    ) {
        // Artificial mismatch: visited==count but FSM total != protocol total
        let mut m = Model {
            fsm: DelinquentUpgraderState::IteratingStakes {
                visited_count: 1,
                total_active_balance: 100,
                total_delinquent_balance: 7,
            },
            validators: vec![Validator {
                active_balance: 90,
                delinquent_upgrader_active_balance: 100,
            }],
            stakes: vec![StakeRec {
                validator_index: 0,
                last_update_delegated_lamports: 100,
                last_update_status: StakeStatus::Active,
                is_emergency_unstaking: false,
                on_chain_deactivating: false,
            }],
            total_active_balance: 90, // diverged (e.g. after delinquent residual subtract)
            delayed_unstake_cooling_down: 0,
            emergency_cooling_down: 0,
            available_reserve_balance: 0,
        };

        let err = m.check_progression().expect_err("must fail balance eq");
        assert_eq!(err, ModelErr::UpgradingInvariantViolation);
        assert!(m.fsm.is_iterating_stakes());

        // If protocol total is corrected to match FSM (or vice versa), progression works.
        // In production, no instruction freely "fixes" this — but deposits during IteratingStakes
        // bump BOTH FSM total and protocol total equally, which cannot close a prior gap.
        // Reducing stake_count without reducing visited can make visited > count:
        m.total_active_balance = 100; // hypothetically aligned
        m.check_progression().unwrap();
        assert!(m.fsm.is_iterating_validators());
    }

    #[test]
    fn h1_visited_eq_count_with_balance_mismatch_cannot_persist_due_to_atomicity() {
        // Any successful update_active/update_deactivated that reaches visited==stake_count
        // also calls check_progression. On balance mismatch the tx reverts — state not persisted.
        let mut m = Model {
            fsm: DelinquentUpgraderState::IteratingStakes {
                visited_count: 1,
                total_active_balance: 100,
                total_delinquent_balance: 0,
            },
            validators: vec![Validator {
                active_balance: 150,
                delinquent_upgrader_active_balance: 100,
            }],
            stakes: vec![
                StakeRec {
                    validator_index: 0,
                    last_update_delegated_lamports: 100,
                    last_update_status: StakeStatus::Active,
                    is_emergency_unstaking: false,
                    on_chain_deactivating: false,
                },
                StakeRec {
                    validator_index: 0,
                    last_update_delegated_lamports: 50,
                    last_update_status: StakeStatus::Unknown,
                    is_emergency_unstaking: false,
                    on_chain_deactivating: false,
                },
            ],
            // Diverged protocol total so that when second stake is upgraded (visited==count),
            // FSM total (150) != protocol total (140).
            total_active_balance: 140,
            delayed_unstake_cooling_down: 0,
            emergency_cooling_down: 0,
            available_reserve_balance: 0,
        };

        let err = m
            .update_active_upgrade_unknown(1)
            .expect_err("progression must fail and revert conceptually");
        assert_eq!(err, ModelErr::UpgradingInvariantViolation);
        // Model mutates before progression check (unlike Anchor atomic tx). Re-read intent:
        // In on-chain runtime the whole ix fails — visited stays 1, count stays 2.
        // Demonstrate that the ONLY persisted outcomes are: stay unequal, or transition cleanly.
    }

    #[test]
    fn h1_successful_path_always_transitions_when_last_stake_upgraded() {
        let mut m = Model {
            fsm: DelinquentUpgraderState::IteratingStakes {
                visited_count: 1,
                total_active_balance: 100,
                total_delinquent_balance: 0,
            },
            validators: vec![Validator {
                active_balance: 150,
                delinquent_upgrader_active_balance: 100,
            }],
            stakes: vec![
                StakeRec {
                    validator_index: 0,
                    last_update_delegated_lamports: 100,
                    last_update_status: StakeStatus::Active,
                    is_emergency_unstaking: false,
                    on_chain_deactivating: false,
                },
                StakeRec {
                    validator_index: 0,
                    last_update_delegated_lamports: 50,
                    last_update_status: StakeStatus::Unknown,
                    is_emergency_unstaking: false,
                    on_chain_deactivating: false,
                },
            ],
            total_active_balance: 150,
            delayed_unstake_cooling_down: 0,
            emergency_cooling_down: 0,
            available_reserve_balance: 0,
        };
        m.update_active_upgrade_unknown(1).unwrap();
        assert!(m.fsm.is_iterating_validators());
    }

    #[test]
    fn h1_emergency_remove_aligns_totals_and_transitions_cleanly() {
        // visited=2, count=3. Emergency-remove visited Active stake A=100.
        // Protocol total 300→200; FSM total stays 200; count→2; visited==count → transition.
        // This KILLS the "permanent visited>count stuck" claim for the Active emergency path:
        // balances remain aligned, so progression succeeds into IteratingValidators.
        let mut m = Model {
            fsm: DelinquentUpgraderState::IteratingStakes {
                visited_count: 2,
                total_active_balance: 200,
                total_delinquent_balance: 0,
            },
            validators: vec![Validator {
                active_balance: 300,
                delinquent_upgrader_active_balance: 200,
            }],
            stakes: vec![
                StakeRec {
                    validator_index: 0,
                    last_update_delegated_lamports: 100,
                    last_update_status: StakeStatus::Active,
                    is_emergency_unstaking: false,
                    on_chain_deactivating: true,
                },
                StakeRec {
                    validator_index: 0,
                    last_update_delegated_lamports: 100,
                    last_update_status: StakeStatus::Active,
                    is_emergency_unstaking: false,
                    on_chain_deactivating: false,
                },
                StakeRec {
                    validator_index: 0,
                    last_update_delegated_lamports: 100,
                    last_update_status: StakeStatus::Unknown,
                    is_emergency_unstaking: false,
                    on_chain_deactivating: false,
                },
            ],
            total_active_balance: 300,
            delayed_unstake_cooling_down: 0,
            emergency_cooling_down: 0,
            available_reserve_balance: 0,
        };

        m.update_deactivated(0).expect("emergency remove should succeed");
        assert_eq!(m.stake_count(), 2);
        assert!(
            m.fsm.is_iterating_validators(),
            "expected transition, got {:?}",
            m.fsm
        );
        // Remaining Unknown stake cannot be upgraded during Validators (update_active blocked).
        let still_unknown = m
            .stakes
            .iter()
            .any(|s| s.last_update_status == StakeStatus::Unknown);
        assert!(still_unknown);
    }

    #[test]
    fn h1_variant_unknown_stake_survives_into_done_and_cannot_upgrade() {
        // Same premature transition, then finalize to Done, then attempt upgrade.
        let mut m = Model {
            fsm: DelinquentUpgraderState::IteratingStakes {
                visited_count: 2,
                total_active_balance: 200,
                total_delinquent_balance: 0,
            },
            validators: vec![Validator {
                active_balance: 300,
                delinquent_upgrader_active_balance: 200,
            }],
            stakes: vec![
                StakeRec {
                    validator_index: 0,
                    last_update_delegated_lamports: 100,
                    last_update_status: StakeStatus::Active,
                    is_emergency_unstaking: false,
                    on_chain_deactivating: true,
                },
                StakeRec {
                    validator_index: 0,
                    last_update_delegated_lamports: 100,
                    last_update_status: StakeStatus::Active,
                    is_emergency_unstaking: false,
                    on_chain_deactivating: false,
                },
                StakeRec {
                    validator_index: 0,
                    last_update_delegated_lamports: 100,
                    last_update_status: StakeStatus::Unknown,
                    is_emergency_unstaking: false,
                    on_chain_deactivating: false,
                },
            ],
            total_active_balance: 300,
            delayed_unstake_cooling_down: 0,
            emergency_cooling_down: 0,
            available_reserve_balance: 0,
        };
        m.update_deactivated(0).unwrap();
        assert!(m.fsm.is_iterating_validators());
        // left=0, one validator, shadow==active after emergency? active=200, shadow=200
        m.finalize_delinquent_upgrade(10).unwrap();
        assert!(m.fsm.is_done());

        // Find remaining Unknown
        let idx = m
            .stakes
            .iter()
            .position(|s| s.last_update_status == StakeStatus::Unknown)
            .expect("Unknown stake must remain");
        let err = m
            .update_active_upgrade_unknown(idx as u32)
            .expect_err("Unknown cannot upgrade after Done");
        assert_eq!(err, ModelErr::UpgradingInvariantViolation);
    }
}

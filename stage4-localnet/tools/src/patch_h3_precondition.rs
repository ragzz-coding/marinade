//! Offline account patcher for H3 precondition (production types, no program changes).

use anchor_lang::prelude::*;
use marinade_finance::state::delinquent_upgrader::DelinquentUpgraderState;
use marinade_finance::state::stake_system::{StakeRecord, StakeStatus};
use marinade_finance::State;
use serde_json::{json, Value};
use solana_program::stake::state::{Authorized, Delegation, Lockup, Meta, Stake, StakeState};
use std::fs;
use std::path::PathBuf;

fn load_cli_account(path: &str) -> (Vec<u8>, u64, String, String) {
    let v: Value = serde_json::from_str(&fs::read_to_string(path).expect("read")).unwrap();
    let acc = &v["account"];
    let data_arr = acc["data"].as_array().expect("data array");
    let b64 = data_arr[0].as_str().unwrap();
    let data = base64::decode(b64).unwrap();
    let lamports = acc["lamports"].as_u64().unwrap();
    let owner = acc["owner"].as_str().unwrap().to_string();
    let pubkey = v["pubkey"].as_str().unwrap().to_string();
    (data, lamports, owner, pubkey)
}

fn save_cli_account(path: &str, pubkey: &str, data: &[u8], lamports: u64, owner: &str) {
    let b64 = base64::encode(data);
    let out = json!({
        "pubkey": pubkey,
        "account": {
            "lamports": lamports,
            "data": [b64, "base64"],
            "owner": owner,
            "executable": false,
            "rentEpoch": 0
        }
    });
    fs::write(path, serde_json::to_string_pretty(&out).unwrap()).unwrap();
}

fn main() {
    let dir = PathBuf::from(std::env::args().nth(1).unwrap_or_else(|| "fixtures".into()));
    let (mut state_data, state_lamports, state_owner, state_pubkey) =
        load_cli_account(dir.join("state.json").to_str().unwrap());
    let (mut vlist_data, v_lamports, v_owner, vlist_pubkey) =
        load_cli_account(dir.join("validator_list.json").to_str().unwrap());
    let (mut slist_data, s_lamports, s_owner, slist_pubkey) =
        load_cli_account(dir.join("stake_list.json").to_str().unwrap());

    let mut state: State = State::try_deserialize(&mut &state_data[..]).expect("State");
    println!("Before: fsm={:?}", state.delinquent_upgrader);
    println!(
        "  total_active={} stakes={} validators={}",
        state.validator_system.total_active_balance,
        state.stake_system.stake_count(),
        state.validator_system.validator_count()
    );

    let vc = state.validator_system.validator_count();
    assert!(vc >= 1, "need >=1 validator for H3");
    for i in 0..vc {
        let mut vi = state.validator_system.get(&vlist_data, i).unwrap();
        println!(
            "V{} active={} shadow={}",
            i, vi.active_balance, vi.delinquent_upgrader_active_balance
        );
        vi.delinquent_upgrader_active_balance = vi.active_balance;
        state.validator_system.set(&mut vlist_data, i, vi).unwrap();
    }

    let sc = state.stake_system.stake_count();
    assert!(sc >= 1, "need >=1 stake");
    let mut target_stake_pubkey = Pubkey::default();
    let mut target_amount = 0u64;
    for i in 0..sc {
        let mut rec: StakeRecord = state.stake_system.stake_list.get(&slist_data, i).unwrap();
        println!(
            "S{} status={:?} amt={} key={}",
            i, rec.last_update_status, rec.last_update_delegated_lamports, rec.stake_account
        );
        rec.last_update_status = StakeStatus::Active;
        if i == 0 {
            target_stake_pubkey = rec.stake_account;
            target_amount = rec.last_update_delegated_lamports;
        }
        state.stake_system.set(&mut slist_data, i, rec).unwrap();
    }

    state.delinquent_upgrader = DelinquentUpgraderState::IteratingValidators {
        visited_count: 0,
        delinquent_balance_left: 0,
    };

    let orig_len = state_data.len();
    let mut out_body = Vec::new();
    state.try_serialize(&mut out_body).unwrap();
    assert!(out_body.len() <= orig_len, "serialized state grew unexpectedly");
    out_body.resize(orig_len, 0);
    state_data = out_body;
    println!("After: fsm={:?}", state.delinquent_upgrader);

    // Patch stake account #0 to on-chain deactivating (simulate DeactivateDelinquent result)
    let stake_acc_path = dir.join("stake0.json");
    let (mut stake_data, stake_lamports, stake_owner, stake_pubkey) =
        load_cli_account(stake_acc_path.to_str().unwrap());
    assert_eq!(
        stake_pubkey,
        target_stake_pubkey.to_string(),
        "stake0.json pubkey mismatch"
    );
    let mut ss: StakeState = bincode::deserialize(&stake_data).expect("StakeState");
    match &mut ss {
        StakeState::Stake(meta, stake) => {
            println!(
                "StakeState before: deactivation_epoch={} stake={}",
                stake.delegation.deactivation_epoch, stake.delegation.stake
            );
            stake.delegation.deactivation_epoch = 0; // deactivated in past
            println!(
                "StakeState after: deactivation_epoch={}",
                stake.delegation.deactivation_epoch
            );
            let _ = meta;
        }
        other => panic!("expected StakeState::Stake, got {:?}", other),
    }
    stake_data = bincode::serialize(&ss).unwrap();
    // StakeState is fixed size 200 bytes typically - pad
    if stake_data.len() < 200 {
        stake_data.resize(200, 0);
    }

    let out_dir = dir.join("patched");
    fs::create_dir_all(&out_dir).unwrap();
    save_cli_account(out_dir.join("state.json").to_str().unwrap(), &state_pubkey, &state_data, state_lamports, &state_owner);
    save_cli_account(out_dir.join("validator_list.json").to_str().unwrap(), &vlist_pubkey, &vlist_data, v_lamports, &v_owner);
    save_cli_account(out_dir.join("stake_list.json").to_str().unwrap(), &slist_pubkey, &slist_data, s_lamports, &s_owner);
    save_cli_account(out_dir.join("stake0.json").to_str().unwrap(), &stake_pubkey, &stake_data, stake_lamports, &stake_owner);

    // Write meta for TS replay
    let meta = json!({
        "state": state_pubkey,
        "validator_list": vlist_pubkey,
        "stake_list": slist_pubkey,
        "stake0": stake_pubkey,
        "stake0_amount": target_amount,
        "stake_index": 0,
        "validator_index": 0
    });
    fs::write(out_dir.join("meta.json"), serde_json::to_string_pretty(&meta).unwrap()).unwrap();
    println!("Wrote {} (target stake amount={})", out_dir.display(), target_amount);
}

//! Offline account patcher for H1-variant precondition.
//! Starts at IteratingStakes with 2 Unknown stakes; offline only sets FSM + Unknown.
//! Runtime sequence: update_active(S0) → force-deactivate S0 → update_deactivated(S0)
//! → finalize → Done with S1 still Unknown.

use marinade_finance::state::delinquent_upgrader::DelinquentUpgraderState;
use marinade_finance::state::stake_system::{StakeRecord, StakeStatus};
use marinade_finance::State;
use serde_json::{json, Value};
use solana_program::stake::state::StakeState;
use std::fs;
use std::path::PathBuf;
use anchor_lang::prelude::*;

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
    let sc = state.stake_system.stake_count();
    println!("stakes={} validators={}", sc, state.validator_system.validator_count());

    // Reset shadows
    for i in 0..state.validator_system.validator_count() {
        let mut vi = state.validator_system.get(&vlist_data, i).unwrap();
        vi.delinquent_upgrader_active_balance = 0;
        state.validator_system.set(&mut vlist_data, i, vi).unwrap();
    }

    let mut keys = vec![];
    for i in 0..sc {
        let mut rec: StakeRecord = state.stake_system.stake_list.get(&slist_data, i).unwrap();
        rec.last_update_status = StakeStatus::Unknown;
        rec.is_emergency_unstaking = false;
        keys.push((rec.stake_account.to_string(), rec.last_update_delegated_lamports));
        state.stake_system.set(&mut slist_data, i, rec).unwrap();
        println!("S{} → Unknown amt={} {}", i, keys[i as usize].1, keys[i as usize].0);
    }

    state.delinquent_upgrader = DelinquentUpgraderState::IteratingStakes {
        visited_count: 0,
        total_active_balance: 0,
        total_delinquent_balance: 0,
    };

    let orig_len = state_data.len();
    let mut out_body = Vec::new();
    state.try_serialize(&mut out_body).unwrap();
    out_body.resize(orig_len, 0);
    state_data = out_body;

    let out_dir = dir.join("patched_h1");
    fs::create_dir_all(&out_dir).unwrap();
    save_cli_account(out_dir.join("state.json").to_str().unwrap(), &state_pubkey, &state_data, state_lamports, &state_owner);
    save_cli_account(out_dir.join("validator_list.json").to_str().unwrap(), &vlist_pubkey, &vlist_data, v_lamports, &v_owner);
    save_cli_account(out_dir.join("stake_list.json").to_str().unwrap(), &slist_pubkey, &slist_data, s_lamports, &s_owner);

    // Copy stake accounts as-is (still active on-chain for update_active)
    for name in ["stake0.json", "stake1.json"] {
        let p = dir.join(name);
        if p.exists() {
            fs::copy(&p, out_dir.join(name)).unwrap();
        }
    }

    let meta = json!({
        "state": state_pubkey,
        "validator_list": vlist_pubkey,
        "stake_list": slist_pubkey,
        "stakes": keys.iter().map(|(k,a)| json!({"pubkey": k, "amount": a})).collect::<Vec<_>>(),
        "stake_count": sc,
    });
    fs::write(out_dir.join("meta.json"), serde_json::to_string_pretty(&meta).unwrap()).unwrap();
    println!("Wrote {} need >=2 stakes for full H1-variant (have {})", out_dir.display(), sc);
}

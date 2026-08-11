/**
 * H1-variant localnet replay:
 * IteratingStakes + 2 Unknown stakes → update_active(S0) → deactivate S0 →
 * update_deactivated(S0) → finalize → Done with S1 still Unknown →
 * update_active(S1) fails.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, web3 } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { decodeStake0, decodeValidator0 } from "./decode_lists";

const PROGRAM_ID = new web3.PublicKey("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD");
const OUT = path.join(__dirname, "..", "results");
fs.mkdirSync(OUT, { recursive: true });

async function snap(program: Program, meta: any, label: string) {
  const st: any = await program.account.state.fetch(new web3.PublicKey(meta.state));
  const du = st.delinquentUpgrader;
  let duJson: any;
  if (du.done !== undefined || Object.keys(du).includes("done") || (du.done === undefined && !du.iteratingValidators && !du.iteratingStakes)) {
    // Anchor encodes unit variant as { done: {} } sometimes
    if (du.iteratingStakes) {
      duJson = {
        state: "IteratingStakes",
        visitedCount: du.iteratingStakes.visitedCount,
        totalActiveBalance: du.iteratingStakes.totalActiveBalance.toString(),
        totalDelinquentBalance: du.iteratingStakes.totalDelinquentBalance.toString(),
      };
    } else if (du.iteratingValidators) {
      duJson = {
        state: "IteratingValidators",
        visitedCount: du.iteratingValidators.visitedCount,
        delinquentBalanceLeft: du.iteratingValidators.delinquentBalanceLeft.toString(),
      };
    } else {
      duJson = { state: "Done", raw: du };
    }
  } else if (du.iteratingStakes) {
    duJson = {
      state: "IteratingStakes",
      visitedCount: du.iteratingStakes.visitedCount,
      totalActiveBalance: du.iteratingStakes.totalActiveBalance.toString(),
      totalDelinquentBalance: du.iteratingStakes.totalDelinquentBalance.toString(),
    };
  } else if (du.iteratingValidators) {
    duJson = {
      state: "IteratingValidators",
      visitedCount: du.iteratingValidators.visitedCount,
      delinquentBalanceLeft: du.iteratingValidators.delinquentBalanceLeft.toString(),
    };
  } else {
    duJson = { state: "Done", raw: du };
  }

  const vAcc = await program.provider.connection.getAccountInfo(new web3.PublicKey(meta.validator_list));
  const sAcc = await program.provider.connection.getAccountInfo(new web3.PublicKey(meta.stake_list));
  const stakeCount = st.stakeSystem.stakeList.count;
  let stakes: any[] = [];
  if (sAcc && stakeCount > 0) {
    const itemSize = Number(st.stakeSystem.stakeList.itemSize);
    for (let i = 0; i < stakeCount; i++) {
      const start = 8 + i * itemSize;
      const item = (sAcc.data as Buffer).subarray(start, start + itemSize);
      const status = item[49];
      stakes.push({
        index: i,
        stakeAccount: new web3.PublicKey(item.subarray(0, 32)).toBase58(),
        amount: item.readBigUInt64LE(32).toString(),
        status: status === 0 ? "Unknown" : status === 1 ? "Active" : status === 2 ? "Deactivating" : status,
        emergency: item[48] !== 0,
      });
    }
  }
  const out = {
    label,
    slot: await program.provider.connection.getSlot(),
    delinquentUpgrader: duJson,
    stakeCount,
    totalActiveBalance: st.validatorSystem.totalActiveBalance.toString(),
    stakes,
    validator0: vAcc ? decodeValidator0(vAcc.data as Buffer, st) : null,
  };
  fs.writeFileSync(path.join(OUT, `h1_${label}.json`), JSON.stringify(out, null, 2));
  console.log(`\n=== ${label} ===`, JSON.stringify(out, null, 2));
  return out;
}

function patchStakeDeactivation(pubkey: string, outFile: string) {
  // dump, set deactivation_epoch=0 via rust tool or python
  execSync(`solana account ${pubkey} --output json -o /tmp/stake_patch.json`, { stdio: "inherit" });
  const py = `
import json,base64,struct
p='/tmp/stake_patch.json'
d=json.load(open(p))
data=bytearray(base64.b64decode(d['account']['data'][0]))
# deactivation_epoch at offset 172 (validated in H3 fixtures)
struct.pack_into('<Q', data, 172, 0)
d['account']['data'][0]=base64.b64encode(data).decode()
open('${outFile}','w').write(json.dumps(d,indent=2))
print('patched deactivation_epoch=0 for', d['pubkey'])
`;
  execSync(`python3 -c ${JSON.stringify(py)}`, { stdio: "inherit" });
}

async function main() {
  const setup = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "fixtures", "setup_meta.json"), "utf8")
  );
  const meta = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "fixtures", "patched_h1", "meta.json"), "utf8")
  );
  meta.msolMint = setup.msolMint;
  meta.treasuryMsol = setup.treasuryMsol;
  meta.operational = setup.operational;
  meta.reservePda = setup.reservePda;

  const connection = new web3.Connection("http://127.0.0.1:8899", "confirmed");
  const secret = JSON.parse(
    fs.readFileSync(path.join(process.env.HOME!, ".config/solana/id.json"), "utf8")
  );
  const payer = web3.Keypair.fromSecretKey(Uint8Array.from(secret));
  const provider = new AnchorProvider(connection, new anchor.Wallet(payer), {
    commitment: "confirmed",
  });
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "marinade_finance.json"), "utf8"));
  const program = new Program(idl, PROGRAM_ID, provider);

  const [withdrawAuth] = web3.PublicKey.findProgramAddressSync(
    [new web3.PublicKey(meta.state).toBytes(), Buffer.from("withdraw")],
    PROGRAM_ID
  );
  const [msolMintAuth] = web3.PublicKey.findProgramAddressSync(
    [new web3.PublicKey(meta.state).toBytes(), Buffer.from("st_mint")],
    PROGRAM_ID
  );

  const stakesMeta = meta.stakes as { pubkey: string; amount: number }[];
  if (stakesMeta.length < 2) {
    console.error("Need >=2 stakes in patched_h1 meta; have", stakesMeta.length);
    process.exit(3);
  }
  const s0 = stakesMeta[0].pubkey;
  const s1 = stakesMeta[1].pubkey;

  const t0 = await snap(program, meta, "T0_start");

  // update_active stake index 0
  let updateActiveOk = false;
  try {
    await program.methods
      .updateActive(0, 0)
      .accounts({
        common: {
          state: meta.state,
          stakeList: meta.stake_list,
          stakeAccount: s0,
          stakeWithdrawAuthority: withdrawAuth,
          reservePda: meta.reservePda,
          msolMint: meta.msolMint,
          msolMintAuthority: msolMintAuth,
          treasuryMsolAccount: meta.treasuryMsol,
          clock: web3.SYSVAR_CLOCK_PUBKEY,
          stakeHistory: web3.SYSVAR_STAKE_HISTORY_PUBKEY,
          stakeProgram: web3.StakeProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          validatorList: meta.validator_list,
        },
      })
      .rpc();
    updateActiveOk = true;
    console.log("update_active(S0) OK");
  } catch (e: any) {
    console.error("update_active(S0) FAIL", e.message, e.logs?.slice(-8));
  }
  const t1 = await snap(program, meta, "T1_after_update_active_s0");

  // Force-deactivate S0: dump, patch, reload validator is heavy.
  // Instead use solana CLI to... can't mutate live.
  // Approach: write patched stake file and instruct operator to reload — OR
  // use `solana-ledger-tool` — not available.
  // Practical approach for same process: call stake program Deactivate — but withdrawer/staker is marinade PDA.
  // So we MUST reload S0 with patched deactivation. Script will exit with instruction...
  // For automation: dump all accounts after T1, patch S0, restart validator mid-script via helper.

  console.log("Dumping mid-state for S0 deactivation patch...");
  const mid = path.join(__dirname, "..", "fixtures", "h1_mid");
  fs.mkdirSync(mid, { recursive: true });
  for (const [pk, name] of [
    [meta.state, "state.json"],
    [meta.validator_list, "validator_list.json"],
    [meta.stake_list, "stake_list.json"],
    [s0, "stake0.json"],
    [s1, "stake1.json"],
    [meta.msolMint, "msol_mint.json"],
    [meta.treasuryMsol, "treasury.json"],
    [meta.reservePda, "reserve.json"],
    [meta.operational, "operational.json"],
  ] as const) {
    execSync(`solana account ${pk} --output json -o ${mid}/${name}`, { stdio: "inherit" });
  }
  // also copy lp etc from fixtures
  for (const f of ["lp_mint.json", "msol_leg.json", "sol_leg.json", "vote.json"]) {
    const src = path.join(__dirname, "..", "fixtures", f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(mid, f));
  }
  // patch stake0 deactivation
  const py = `
import json,base64,struct
p='${mid}/stake0.json'
d=json.load(open(p))
data=bytearray(base64.b64decode(d['account']['data'][0]))
old=struct.unpack_from('<Q', data, 172)[0]
struct.pack_into('<Q', data, 172, 0)
d['account']['data'][0]=base64.b64encode(bytes(data)).decode()
open(p,'w').write(json.dumps(d,indent=2))
print('S0 deactivation', old, '->', 0)
`;
  execSync(`python3 -c ${JSON.stringify(py)}`, { stdio: "inherit" });
  fs.writeFileSync(
    path.join(mid, "meta.json"),
    JSON.stringify({ ...meta, s0, s1, phase: "after_update_active" }, null, 2)
  );
  fs.writeFileSync(
    path.join(OUT, "h1_mid_ready.json"),
    JSON.stringify({ updateActiveOk, t0, t1, midDir: mid }, null, 2)
  );
  console.log("MID STATE DUMPED to", mid, "— runner will reload and continue via h1_replay_part2.ts");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

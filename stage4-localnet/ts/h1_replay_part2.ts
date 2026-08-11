/**
 * H1 part 2: after mid-state reload with S0 deactivated.
 * update_deactivated(S0) → finalize → assert S1 Unknown + Done → update_active(S1) fails.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, web3 } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { decodeValidator0 } from "./decode_lists";

const PROGRAM_ID = new web3.PublicKey("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD");
const OUT = path.join(__dirname, "..", "results");

async function snap(program: Program, meta: any, label: string) {
  const st: any = await program.account.state.fetch(new web3.PublicKey(meta.state));
  const du = st.delinquentUpgrader;
  let duJson: any;
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
  const sAcc = await program.provider.connection.getAccountInfo(
    new web3.PublicKey(meta.stake_list)
  );
  const stakeCount = st.stakeSystem.stakeList.count;
  const stakes: any[] = [];
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
        status:
          status === 0
            ? "Unknown"
            : status === 1
            ? "Active"
            : status === 2
            ? "Deactivating"
            : status,
      });
    }
  }
  const vAcc = await program.provider.connection.getAccountInfo(
    new web3.PublicKey(meta.validator_list)
  );
  const out = {
    label,
    delinquentUpgrader: duJson,
    stakeCount,
    stakes,
    totalActiveBalance: st.validatorSystem.totalActiveBalance.toString(),
    validator0: vAcc ? decodeValidator0(vAcc.data as Buffer, st) : null,
  };
  fs.writeFileSync(path.join(OUT, `h1_${label}.json`), JSON.stringify(out, null, 2));
  console.log(`\n=== ${label} ===`, JSON.stringify(out, null, 2));
  return out;
}

async function main() {
  const midMeta = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "fixtures", "h1_mid", "meta.json"),
      "utf8"
    )
  );
  const connection = new web3.Connection("http://127.0.0.1:8899", "confirmed");
  const secret = JSON.parse(
    fs.readFileSync(path.join(process.env.HOME!, ".config/solana/id.json"), "utf8")
  );
  const payer = web3.Keypair.fromSecretKey(Uint8Array.from(secret));
  const provider = new AnchorProvider(connection, new anchor.Wallet(payer), {
    commitment: "confirmed",
  });
  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "marinade_finance.json"), "utf8")
  );
  const program = new Program(idl, PROGRAM_ID, provider);
  const meta = midMeta;
  const s0 = meta.s0;
  const s1 = meta.s1;

  const [withdrawAuth] = web3.PublicKey.findProgramAddressSync(
    [new web3.PublicKey(meta.state).toBytes(), Buffer.from("withdraw")],
    PROGRAM_ID
  );
  const [msolMintAuth] = web3.PublicKey.findProgramAddressSync(
    [new web3.PublicKey(meta.state).toBytes(), Buffer.from("st_mint")],
    PROGRAM_ID
  );

  const t2 = await snap(program, meta, "T2_reloaded_s0_deactivated");

  // Find index of s0 in stake list
  let s0index = 0;
  for (const s of t2.stakes) {
    if (s.stakeAccount === s0) s0index = s.index;
  }

  let updateDeactOk = false;
  let updateDeactErr: any = null;
  try {
    await program.methods
      .updateDeactivated(s0index, 0)
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
        operationalSolAccount: meta.operational,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();
    updateDeactOk = true;
    console.log("update_deactivated(S0) OK");
  } catch (e: any) {
    updateDeactErr = { message: e.message, logs: e.logs?.slice(-10) };
    console.error("update_deactivated FAIL", updateDeactErr);
  }
  const t3 = await snap(program, meta, "T3_after_update_deactivated_s0");

  let finalizeOk = false;
  let finalizeErr: any = null;
  try {
    await program.methods
      .finalizeDelinquentUpgrade(10)
      .accounts({ state: meta.state, validatorList: meta.validator_list })
      .rpc();
    finalizeOk = true;
    console.log("finalize OK");
  } catch (e: any) {
    finalizeErr = { message: e.message, logs: e.logs?.slice(-10) };
    console.error("finalize FAIL", finalizeErr);
  }
  const t4 = await snap(program, meta, "T4_after_finalize");

  // Try update_active on remaining Unknown stake
  let updateS1Ok = false;
  let updateS1Err: any = null;
  const remaining = t4.stakes.find((s: any) => s.stakeAccount === s1) || t4.stakes[0];
  if (remaining) {
    try {
      await program.methods
        .updateActive(remaining.index, 0)
        .accounts({
          common: {
            state: meta.state,
            stakeList: meta.stake_list,
            stakeAccount: remaining.stakeAccount,
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
      updateS1Ok = true;
    } catch (e: any) {
      updateS1Err = { message: e.message, logs: e.logs?.slice(-10) };
    }
  }
  const t5 = await snap(program, meta, "T5_after_update_active_s1_attempt");

  const assertions = [
    {
      name: "T3_transitioned_or_ready_for_finalize",
      pass:
        updateDeactOk &&
        (t3.delinquentUpgrader.state === "IteratingValidators" ||
          t3.delinquentUpgrader.state === "Done"),
    },
    {
      name: "T4_done",
      pass: finalizeOk && t4.delinquentUpgrader.state === "Done",
    },
    {
      name: "T4_unknown_stake_remains",
      pass: t4.stakes.some((s: any) => s.status === "Unknown"),
    },
    {
      name: "T5_update_active_on_unknown_fails",
      pass: !updateS1Ok,
      detail: updateS1Err,
    },
    {
      name: "T5_still_done",
      pass: t5.delinquentUpgrader.state === "Done",
    },
    {
      name: "T5_unknown_still_present",
      pass: t5.stakes.some((s: any) => s.status === "Unknown"),
    },
  ];
  for (const a of assertions) {
    console.log(a.pass ? "PASS" : "FAIL", a.name, a.detail ?? "");
  }
  const report = {
    updateDeactOk,
    updateDeactErr,
    finalizeOk,
    finalizeErr,
    updateS1Ok,
    updateS1Err,
    assertions,
    t2,
    t3,
    t4,
    t5,
  };
  fs.writeFileSync(path.join(OUT, "h1_report.json"), JSON.stringify(report, null, 2));
  if (!assertions.every((a) => a.pass)) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

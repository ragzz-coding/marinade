/**
 * H3 localnet replay: load patched IteratingValidators + deactivated stake,
 * run update_deactivated then finalize_delinquent_upgrade, attempt recovery.
 */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program, AnchorProvider, web3 } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new web3.PublicKey("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD");
const OUT = path.join(__dirname, "..", "results");
fs.mkdirSync(OUT, { recursive: true });

type Snapshot = Record<string, unknown>;

async function snap(
  program: Program,
  meta: any,
  setup: any,
  label: string
): Promise<Snapshot> {
  const statePk = new web3.PublicKey(meta.state);
  const st: any = await program.account.state.fetch(statePk);
  const vlist = new web3.PublicKey(meta.validator_list);
  const slist = new web3.PublicKey(meta.stake_list);
  const stakeInfo = await program.provider.connection.getAccountInfo(
    new web3.PublicKey(meta.stake0)
  );
  // Fetch validator record via account data is awkward; use raw decode from IDL account types if available.
  // Use program coder for ValidatorRecord via state helpers — fall back to listing fields we can get from state.
  const du = st.delinquentUpgrader;
  let duJson: any;
  if (du.done !== undefined || "done" in du) {
    duJson = { state: "Done" };
  } else if (du.iteratingValidators) {
    duJson = {
      state: "IteratingValidators",
      visitedCount: du.iteratingValidators.visitedCount,
      delinquentBalanceLeft: du.iteratingValidators.delinquentBalanceLeft.toString(),
    };
  } else if (du.iteratingStakes) {
    duJson = {
      state: "IteratingStakes",
      visitedCount: du.iteratingStakes.visitedCount,
      totalActiveBalance: du.iteratingStakes.totalActiveBalance.toString(),
      totalDelinquentBalance: du.iteratingStakes.totalDelinquentBalance.toString(),
    };
  } else {
    duJson = du;
  }

  // Parse validator list account with program coder
  const vAcc = await program.provider.connection.getAccountInfo(vlist);
  const sAcc = await program.provider.connection.getAccountInfo(slist);
  // Manual: after discriminator(8) + account discriminator for list — ValidatorList is Account with disc
  // Simpler approach: call getProgramAccounts is overkill. Decode using layout from marinade types.
  // We embedded helper: use `program.coder.accounts.decode` won't work for list items.
  // Read via RPC + offline from known offsets after patcher printed values — use TS struct from IDL events? 
  // For assertions, dump state-level fields + stake account existence + raw first validator via buffer.

  let validator0: any = null;
  let stake0rec: any = null;
  if (vAcc) {
    // ValidatorList: 8 byte account disc + list header. Marinade List: account disc already 8.
    // state.validator_system has discriminator in list account: "validator_list" account type.
    // Use get from program by simulating — instead decode with borsh manually via anchor Account.
    // Practical: invoke a small view by reading bytes with known StakeRecord/ValidatorRecord sizes.
    const data = vAcc.data;
    // Anchor account discriminator 8 bytes, then List { account: Pubkey(32), item_size:u32, count:u32, ... }
    // Actually ValidatorList wraps List. Layout from marinade: after 8-byte disc:
    // We'll parse count from state.
  }
  const stakeCount = st.stakeSystem.stakeList.count;
  const valCount = st.validatorSystem.validatorList.count;

  // Decode first validator & stake using coder accounts if registered as types — fallback raw
  const { decodeValidator0, decodeStake0 } = await import("./decode_lists");
  try {
    validator0 = decodeValidator0(vAcc!.data as Buffer, st);
    if (stakeCount > 0 && sAcc) {
      stake0rec = decodeStake0(sAcc.data as Buffer, st);
    }
  } catch (e: any) {
    validator0 = { error: String(e.message || e) };
  }

  const out: Snapshot = {
    label,
    slot: await program.provider.connection.getSlot(),
    epoch: (await program.provider.connection.getEpochInfo()).epoch,
    delinquentUpgrader: duJson,
    stakeCount,
    validatorCount: valCount,
    totalActiveBalance: st.validatorSystem.totalActiveBalance.toString(),
    emergencyCoolingDown: st.emergencyCoolingDown.toString(),
    availableReserveBalance: st.availableReserveBalance.toString(),
    msolSupply: st.msolSupply.toString(),
    msolPrice: st.msolPrice.toString(),
    paused: st.paused,
    validator0,
    stake0rec,
    stake0Exists: stakeInfo !== null,
    stake0Lamports: stakeInfo?.lamports ?? 0,
    stake0Owner: stakeInfo?.owner?.toBase58?.() ?? null,
  };
  fs.writeFileSync(path.join(OUT, `${label}.json`), JSON.stringify(out, null, 2));
  console.log(`\n=== SNAP ${label} ===`);
  console.log(JSON.stringify(out, null, 2));
  return out;
}

async function main() {
  const setup = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "fixtures", "setup_meta.json"), "utf8")
  );
  const meta = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "fixtures", "patched", "meta.json"),
      "utf8"
    )
  );
  // Prefer setup_meta for mint/treasury/operational
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
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);
  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "marinade_finance.json"), "utf8")
  );
  const program = new Program(idl, PROGRAM_ID, provider);

  const log: any[] = [];
  const recordTx = (step: string, ok: boolean, detail: any) => {
    const entry = { step, ok, detail, slot: null as number | null };
    log.push(entry);
    console.log(`TX ${step}:`, ok ? "OK" : "FAIL", detail?.message || detail);
    return entry;
  };

  // Wait until epoch > 0 so deactivation_epoch=0 is fully inactive
  let epochInfo = await connection.getEpochInfo();
  console.log("initial epoch", epochInfo);
  let waits = 0;
  while (epochInfo.epoch < 2 && waits < 120) {
    await new Promise((r) => setTimeout(r, 500));
    epochInfo = await connection.getEpochInfo();
    waits++;
  }
  console.log("ready epoch", epochInfo, "waits", waits);

  const t0 = await snap(program, meta, setup, "T0_before_update_deactivated");

  const [withdrawAuth] = web3.PublicKey.findProgramAddressSync(
    [new web3.PublicKey(meta.state).toBytes(), Buffer.from("withdraw")],
    PROGRAM_ID
  );
  const [msolMintAuth] = web3.PublicKey.findProgramAddressSync(
    [new web3.PublicKey(meta.state).toBytes(), Buffer.from("st_mint")],
    PROGRAM_ID
  );

  // T1 update_deactivated
  let updateOk = false;
  let updateErr: any = null;
  let updateSig: string | null = null;
  try {
    updateSig = await program.methods
      .updateDeactivated(0, 0)
      .accounts({
        common: {
          state: meta.state,
          stakeList: meta.stake_list,
          stakeAccount: meta.stake0,
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
    updateOk = true;
    recordTx("T1_update_deactivated", true, { signature: updateSig });
  } catch (e: any) {
    updateErr = {
      message: e.message,
      logs: e.logs ?? e.error?.logs,
      code: e.error?.errorCode || e.code,
    };
    recordTx("T1_update_deactivated", false, updateErr);
  }

  const t2 = await snap(program, meta, setup, "T2_after_update_deactivated");

  // T3 finalize
  let finalizeOk = false;
  let finalizeErr: any = null;
  try {
    const sig = await program.methods
      .finalizeDelinquentUpgrade(10)
      .accounts({
        state: meta.state,
        validatorList: meta.validator_list,
      })
      .rpc();
    finalizeOk = true;
    recordTx("T3_finalize_delinquent_upgrade", true, { signature: sig });
  } catch (e: any) {
    finalizeErr = {
      message: e.message,
      logs: e.logs ?? e.error?.logs,
      code: e.error?.errorCode || e.code,
    };
    recordTx("T3_finalize_delinquent_upgrade", false, finalizeErr);
  }

  const t4 = await snap(program, meta, setup, "T4_after_finalize");

  // T5 recovery attempts (permissionless / available)
  const recoveries: any[] = [];

  // finalize again
  try {
    await program.methods
      .finalizeDelinquentUpgrade(10)
      .accounts({ state: meta.state, validatorList: meta.validator_list })
      .rpc();
    recoveries.push({ ix: "finalize_delinquent_upgrade", ok: true });
  } catch (e: any) {
    recoveries.push({
      ix: "finalize_delinquent_upgrade",
      ok: false,
      error: e.message,
      logs: e.logs?.slice(-8),
    });
  }

  // update_active — should be blocked in IteratingValidators
  try {
    await program.methods
      .updateActive(0, 0)
      .accounts({
        common: {
          state: meta.state,
          stakeList: meta.stake_list,
          stakeAccount: meta.stake0,
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
    recoveries.push({ ix: "update_active", ok: true });
  } catch (e: any) {
    recoveries.push({
      ix: "update_active",
      ok: false,
      error: e.message,
      logs: e.logs?.slice(-8),
    });
  }

  // update_deactivated again (stake may be gone)
  try {
    await program.methods
      .updateDeactivated(0, 0)
      .accounts({
        common: {
          state: meta.state,
          stakeList: meta.stake_list,
          stakeAccount: meta.stake0,
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
    recoveries.push({ ix: "update_deactivated_again", ok: true });
  } catch (e: any) {
    recoveries.push({
      ix: "update_deactivated_again",
      ok: false,
      error: e.message,
      logs: e.logs?.slice(-8),
    });
  }

  // deposit (liquid) — should still work if not gated by is_done
  try {
    // skip if complex; note only
    recoveries.push({
      ix: "deposit_liq_pool_note",
      ok: null,
      note: "is_done gates stake-moving ops; liquid deposit/unstake checked separately in report",
    });
  } catch {}

  const t6 = await snap(program, meta, setup, "T6_after_recovery");

  // Assertions for H3
  const assertions: any[] = [];
  const assert = (name: string, cond: boolean, detail?: any) => {
    assertions.push({ name, pass: cond, detail });
    console.log(cond ? `PASS ${name}` : `FAIL ${name}`, detail ?? "");
  };

  assert(
    "T0_fsm_iterating_validators",
    (t0.delinquentUpgrader as any).state === "IteratingValidators"
  );
  assert("T1_update_succeeded", updateOk, updateErr);
  assert(
    "T2_active_decreased_or_zero",
    updateOk &&
      Number((t2.validator0 as any)?.activeBalance ?? -1) <
        Number((t0.validator0 as any)?.activeBalance ?? 0),
    { before: (t0.validator0 as any)?.activeBalance, after: (t2.validator0 as any)?.activeBalance }
  );
  assert(
    "T2_shadow_unchanged",
    updateOk &&
      String((t2.validator0 as any)?.delinquentUpgraderActiveBalance) ===
        String((t0.validator0 as any)?.delinquentUpgraderActiveBalance),
    {
      before: (t0.validator0 as any)?.delinquentUpgraderActiveBalance,
      after: (t2.validator0 as any)?.delinquentUpgraderActiveBalance,
    }
  );
  assert(
    "T2_active_lt_shadow",
    updateOk &&
      Number((t2.validator0 as any)?.activeBalance) <
        Number((t2.validator0 as any)?.delinquentUpgraderActiveBalance)
  );
  assert("T3_finalize_failed", !finalizeOk, finalizeErr);
  assert(
    "T4_still_iterating_validators",
    (t4.delinquentUpgrader as any).state === "IteratingValidators"
  );
  assert(
    "T4_matches_T2_validator_active",
    String((t4.validator0 as any)?.activeBalance) ===
      String((t2.validator0 as any)?.activeBalance)
  );
  assert(
    "T4_matches_T2_shadow",
    String((t4.validator0 as any)?.delinquentUpgraderActiveBalance) ===
      String((t2.validator0 as any)?.delinquentUpgraderActiveBalance)
  );
  assert(
    "T6_still_stuck",
    (t6.delinquentUpgrader as any).state === "IteratingValidators" &&
      (t6.delinquentUpgrader as any).state !== "Done"
  );

  const report = {
    updateOk,
    updateSig,
    updateErr,
    finalizeOk,
    finalizeErr,
    recoveries,
    assertions,
    t0,
    t2,
    t4,
    t6,
    log,
  };
  fs.writeFileSync(path.join(OUT, "h3_report.json"), JSON.stringify(report, null, 2));
  console.log("\n=== ASSERTION SUMMARY ===");
  console.log(
    `passed ${assertions.filter((a) => a.pass).length}/${assertions.length}`
  );
  if (!assertions.every((a) => a.pass)) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

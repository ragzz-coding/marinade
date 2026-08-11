/**
 * Expand H3 stuck-state recovery + impact probes.
 * Assumes validator already in H3 stuck state (after h3_replay) OR reloads and re-runs critical path.
 */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program, AnchorProvider, web3 } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new web3.PublicKey("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD");
const OUT = path.join(__dirname, "..", "results");

async function main() {
  const setup = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "fixtures", "setup_meta.json"), "utf8")
  );
  const meta = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "fixtures", "patched", "meta.json"), "utf8")
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

  const st: any = await program.account.state.fetch(new web3.PublicKey(meta.state));
  console.log("FSM", st.delinquentUpgrader);
  console.log("isDone?", !st.delinquentUpgrader.iteratingValidators && !st.delinquentUpgrader.iteratingStakes);

  const results: any[] = [];
  const tryIx = async (name: string, fn: () => Promise<any>) => {
    try {
      const sig = await fn();
      results.push({ name, ok: true, sig });
      console.log("OK", name, sig);
    } catch (e: any) {
      results.push({
        name,
        ok: false,
        error: e.message,
        logs: (e.logs || []).slice(-6),
      });
      console.log("FAIL", name, e.message?.split("\n")[0]);
    }
  };

  // Permissionless finalize
  await tryIx("finalize_delinquent_upgrade", () =>
    program.methods
      .finalizeDelinquentUpgrade(10)
      .accounts({ state: meta.state, validatorList: meta.validator_list })
      .rpc()
  );

  // Liquid deposit (should work — not gated by is_done)
  const { createTokenAccountOffCurve } = await import("./token_helpers").catch(() => ({
    createTokenAccountOffCurve: null as any,
  }));

  // Inline token account create
  const {
    ACCOUNT_SIZE,
    createInitializeAccountInstruction,
    getMinimumBalanceForRentExemptAccount,
  } = await import("@solana/spl-token");
  async function makeTok(mint: web3.PublicKey, owner: web3.PublicKey) {
    const account = web3.Keypair.generate();
    const lamports = await getMinimumBalanceForRentExemptAccount(connection);
    const tx = new web3.Transaction().add(
      web3.SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: account.publicKey,
        space: ACCOUNT_SIZE,
        lamports,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeAccountInstruction(account.publicKey, mint, owner)
    );
    await provider.sendAndConfirm(tx, [payer, account]);
    return account.publicKey;
  }

  const userMsol = await makeTok(new web3.PublicKey(setup.msolMint), payer.publicKey);
  const [msolMintAuth] = web3.PublicKey.findProgramAddressSync(
    [new web3.PublicKey(meta.state).toBytes(), Buffer.from("st_mint")],
    PROGRAM_ID
  );
  const [solLeg] = web3.PublicKey.findProgramAddressSync(
    [new web3.PublicKey(meta.state).toBytes(), Buffer.from("liq_sol")],
    PROGRAM_ID
  );
  const [liqMsolLegAuth] = web3.PublicKey.findProgramAddressSync(
    [new web3.PublicKey(meta.state).toBytes(), Buffer.from("liq_st_sol_authority")],
    PROGRAM_ID
  );
  // Get msol_leg from state
  const msolLeg = st.liqPool.msolLeg;

  await tryIx("deposit_sol", () =>
    program.methods
      .deposit(new BN(1_000_000_000))
      .accounts({
        state: meta.state,
        msolMint: setup.msolMint,
        liqPoolSolLegPda: solLeg,
        liqPoolMsolLeg: msolLeg,
        liqPoolMsolLegAuthority: liqMsolLegAuth,
        reservePda: setup.reservePda,
        transferFrom: payer.publicKey,
        mintTo: userMsol,
        msolMintAuthority: msolMintAuth,
        systemProgram: web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc()
  );

  // stake_reserve — gated by is_done
  const newStake = web3.Keypair.generate();
  const [stakeDepositAuth] = web3.PublicKey.findProgramAddressSync(
    [new web3.PublicKey(meta.state).toBytes(), Buffer.from("deposit")],
    PROGRAM_ID
  );
  await tryIx("stake_reserve", () =>
    program.methods
      .stakeReserve(0)
      .accounts({
        state: meta.state,
        validatorList: meta.validator_list,
        stakeList: meta.stake_list,
        validatorVote: setup.vote,
        reservePda: setup.reservePda,
        stakeAccount: newStake.publicKey,
        stakeDepositAuthority: stakeDepositAuth,
        rentPayer: payer.publicKey,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
        epochSchedule: web3.SYSVAR_EPOCH_SCHEDULE_PUBKEY,
        rent: web3.SYSVAR_RENT_PUBKEY,
        stakeHistory: web3.SYSVAR_STAKE_HISTORY_PUBKEY,
        stakeConfig: new web3.PublicKey("StakeConfig11111111111111111111111111111111"),
        systemProgram: web3.SystemProgram.programId,
        stakeProgram: web3.StakeProgram.programId,
      })
      .signers([newStake])
      .rpc()
  );

  // deactivate_stake — gated (need a stake — likely none)
  await tryIx("add_validator_gated", () =>
    program.methods
      .addValidator(1)
      .accounts({
        state: meta.state,
        managerAuthority: payer.publicKey,
        validatorList: meta.validator_list,
        validatorVote: web3.Keypair.generate().publicKey,
        duplicationFlag: web3.Keypair.generate().publicKey,
        rentPayer: payer.publicKey,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
        rent: web3.SYSVAR_RENT_PUBKEY,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc()
  );

  // liquid unstake if possible
  const [msolLegAuth] = web3.PublicKey.findProgramAddressSync(
    [new web3.PublicKey(meta.state).toBytes(), Buffer.from("liq_st_sol_authority")],
    PROGRAM_ID
  );
  await tryIx("liquid_unstake", () =>
    program.methods
      .liquidUnstake(new BN(100_000_000))
      .accounts({
        state: meta.state,
        msolMint: setup.msolMint,
        liqPoolSolLegPda: solLeg,
        liqPoolMsolLeg: msolLeg,
        treasuryMsolAccount: setup.treasuryMsol,
        getMsolFrom: userMsol,
        getMsolFromAuthority: payer.publicKey,
        transferSolTo: payer.publicKey,
        systemProgram: web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc()
  );

  // order_unstake (delayed) — typically not gated by is_done
  const ticket = web3.Keypair.generate();
  const ticketRent = await connection.getMinimumBalanceForRentExemption(200);
  await tryIx("order_unstake", () =>
    program.methods
      .orderUnstake(new BN(100_000_000))
      .accounts({
        state: meta.state,
        msolMint: setup.msolMint,
        burnMsolFrom: userMsol,
        burnMsolAuthority: payer.publicKey,
        newTicketAccount: ticket.publicKey,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
        rent: web3.SYSVAR_RENT_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([
        web3.SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: ticket.publicKey,
          lamports: ticketRent,
          space: 200,
          programId: PROGRAM_ID,
        }),
      ])
      .signers([ticket])
      .rpc()
  );

  const stAfter: any = await program.account.state.fetch(new web3.PublicKey(meta.state));
  const summary = {
    fsmBefore: st.delinquentUpgrader,
    fsmAfter: stAfter.delinquentUpgrader,
    results,
  };
  fs.writeFileSync(path.join(OUT, "h3_recovery_impact.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

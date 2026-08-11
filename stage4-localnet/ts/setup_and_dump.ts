/**
 * Stage 4: Initialize Marinade on local validator, create 1 validator + 1 stake via stake_reserve,
 * dump accounts for H3 patch/reload.
 *
 * Run against: solana-test-validator with marinade BPF already loaded.
 */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program, AnchorProvider, web3, utils } from "@coral-xyz/anchor";
import {
  createMint,
  TOKEN_PROGRAM_ID,
  ACCOUNT_SIZE,
  createInitializeAccountInstruction,
  getMinimumBalanceForRentExemptAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

const PROGRAM_ID = new web3.PublicKey("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD");

/** Create a token account (non-ATA) that may be owned by a PDA. */
async function createTokenAccountOffCurve(
  connection: web3.Connection,
  payer: web3.Keypair,
  mint: web3.PublicKey,
  owner: web3.PublicKey
): Promise<web3.PublicKey> {
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
  const latest = await connection.getLatestBlockhash();
  tx.recentBlockhash = latest.blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer, account);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  return account.publicKey;
}

async function dumpAccount(pubkey: web3.PublicKey, outFile: string) {
  execSync(`solana account ${pubkey.toBase58()} --output json -o ${outFile}`, {
    stdio: "inherit",
  });
}

async function main() {
  const connection = new web3.Connection("http://127.0.0.1:8899", "confirmed");
  const walletPath = path.join(process.env.HOME!, ".config/solana/id.json");
  const secret = JSON.parse(fs.readFileSync(walletPath, "utf8"));
  const payer = web3.Keypair.fromSecretKey(Uint8Array.from(secret));
  const wallet = new anchor.Wallet(payer);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  // Airdrop
  const bal = await connection.getBalance(payer.publicKey);
  if (bal < 200e9) {
    const sig = await connection.requestAirdrop(payer.publicKey, 500e9);
    await connection.confirmTransaction(sig, "confirmed");
  }
  console.log("payer", payer.publicKey.toBase58(), "bal", await connection.getBalance(payer.publicKey));

  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "marinade_finance.json"), "utf8")
  );
  const program = new Program(idl, PROGRAM_ID, provider);

  const state = web3.Keypair.generate();
  const stakeList = web3.Keypair.generate();
  const validatorList = web3.Keypair.generate();
  const operational = web3.Keypair.generate();

  const [reservePda, reserveBump] = web3.PublicKey.findProgramAddressSync(
    [state.publicKey.toBytes(), Buffer.from("reserve")],
    PROGRAM_ID
  );
  const [msolMintAuth] = web3.PublicKey.findProgramAddressSync(
    [state.publicKey.toBytes(), Buffer.from("st_mint")],
    PROGRAM_ID
  );
  const [lpMintAuth] = web3.PublicKey.findProgramAddressSync(
    [state.publicKey.toBytes(), Buffer.from("liq_mint")],
    PROGRAM_ID
  );
  const [solLegPda] = web3.PublicKey.findProgramAddressSync(
    [state.publicKey.toBytes(), Buffer.from("liq_sol")],
    PROGRAM_ID
  );
  const [msolLegAuth] = web3.PublicKey.findProgramAddressSync(
    [state.publicKey.toBytes(), Buffer.from("liq_st_sol_authority")],
    PROGRAM_ID
  );

  const rent = await connection.getMinimumBalanceForRentExemption(0);

  // Fund reserve & sol leg with rent-exempt for token account (program expects this)
  // From initialize: rent_exempt_for_token_acc
  const rentExemptToken = await connection.getMinimumBalanceForRentExemption(165);

  // Create mSOL mint with PDA authority
  const msolMint = await createMint(
    connection,
    payer,
    msolMintAuth,
    null,
    9
  );
  console.log("msolMint", msolMint.toBase58());

  const lpMint = await createMint(connection, payer, lpMintAuth, null, 9);
  console.log("lpMint", lpMint.toBase58());

  // msol_leg owned by msolLegAuth (PDA — must not use ATA helper)
  const msolLeg = await createTokenAccountOffCurve(
    connection,
    payer,
    msolMint,
    msolLegAuth
  );
  console.log("msolLeg", msolLeg.toBase58());

  const treasuryMsol = await createTokenAccountOffCurve(
    connection,
    payer,
    msolMint,
    payer.publicKey
  );

  // Create zero accounts for state / lists
  const stateSpace = 10240; // generous for State
  const listSpace = 1024 * 64;

  const createStateIx = web3.SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: state.publicKey,
    lamports: await connection.getMinimumBalanceForRentExemption(stateSpace),
    space: stateSpace,
    programId: PROGRAM_ID,
  });
  const createStakeListIx = web3.SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: stakeList.publicKey,
    lamports: await connection.getMinimumBalanceForRentExemption(listSpace),
    space: listSpace,
    programId: PROGRAM_ID,
  });
  const createValListIx = web3.SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: validatorList.publicKey,
    lamports: await connection.getMinimumBalanceForRentExemption(listSpace),
    space: listSpace,
    programId: PROGRAM_ID,
  });

  // Fund reserve PDA and sol leg PDA
  const fundReserveIx = web3.SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: reservePda,
    lamports: rentExemptToken,
  });
  const fundSolLegIx = web3.SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: solLegPda,
    lamports: rentExemptToken,
  });
  // operational system account
  const fundOpsIx = web3.SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: operational.publicKey,
    lamports: await connection.getMinimumBalanceForRentExemption(0) + 1e9,
  });

  await provider.sendAndConfirm(
    new web3.Transaction().add(
      createStateIx,
      createStakeListIx,
      createValListIx,
      fundReserveIx,
      fundSolLegIx,
      fundOpsIx
    ),
    [payer, state, stakeList, validatorList]
  );
  console.log("created state", state.publicKey.toBase58());

  const initData = {
    adminAuthority: payer.publicKey,
    validatorManagerAuthority: payer.publicKey,
    minStake: new BN(1_000_000_000), // 1 SOL
    rewardsFee: { basisPoints: 100 }, // 1%
    liqPool: {
      lpLiquidityTarget: new BN(10_000_000_000_000),
      lpMaxFee: { basisPoints: 300 },
      lpMinFee: { basisPoints: 30 },
      lpTreasuryCut: { basisPoints: 2500 },
    },
    additionalStakeRecordSpace: 0,
    additionalValidatorRecordSpace: 0,
    slotsForStakeDelta: new BN(3000),
    pauseAuthority: payer.publicKey,
  };

  await program.methods
    .initialize(initData)
    .accounts({
      state: state.publicKey,
      reservePda,
      stakeList: stakeList.publicKey,
      validatorList: validatorList.publicKey,
      msolMint,
      operationalSolAccount: operational.publicKey,
      liqPool: {
        lpMint,
        solLegPda,
        msolLeg,
      },
      treasuryMsolAccount: treasuryMsol,
      clock: web3.SYSVAR_CLOCK_PUBKEY,
      rent: web3.SYSVAR_RENT_PUBKEY,
    })
    .rpc();
  console.log("initialized");

  // Add validator — need a vote account. Create a dummy vote account is hard;
  // use stake program vote account from validator. For localnet, create vote account.
  const voteAccount = web3.Keypair.generate();
  const identity = web3.Keypair.generate();
  // Fund identity
  {
    const tx = new web3.Transaction().add(
      web3.SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: identity.publicKey,
        lamports: 2e9,
      })
    );
    await provider.sendAndConfirm(tx, [payer]);
  }

  const voteKpPath = path.join(__dirname, "vote.json");
  const withdrawerPath = path.join(__dirname, "withdrawer.json");
  const identityPath = path.join(__dirname, "identity.json");
  fs.writeFileSync(voteKpPath, JSON.stringify(Array.from(voteAccount.secretKey)));
  fs.writeFileSync(withdrawerPath, JSON.stringify(Array.from(payer.secretKey)));
  fs.writeFileSync(identityPath, JSON.stringify(Array.from(identity.secretKey)));

  try {
    execSync(
      `solana create-vote-account ${voteKpPath} ${identityPath} ${withdrawerPath} --url localhost --commitment confirmed`,
      { stdio: "inherit" }
    );
  } catch (e) {
    console.error("create-vote-account failed", e);
    throw e;
  }
  console.log("vote", voteAccount.publicKey.toBase58());

  const [dupFlag] = web3.PublicKey.findProgramAddressSync(
    [
      state.publicKey.toBytes(),
      Buffer.from("unique_validator"),
      voteAccount.publicKey.toBytes(),
    ],
    PROGRAM_ID
  );

  await program.methods
    .addValidator(1000)
    .accounts({
      state: state.publicKey,
      managerAuthority: payer.publicKey,
      validatorList: validatorList.publicKey,
      validatorVote: voteAccount.publicKey,
      duplicationFlag: dupFlag,
      rentPayer: payer.publicKey,
      clock: web3.SYSVAR_CLOCK_PUBKEY,
      rent: web3.SYSVAR_RENT_PUBKEY,
      systemProgram: web3.SystemProgram.programId,
    })
    .rpc();
  console.log("validator added");

  // Deposit SOL then stake_reserve to create a stake
  // First deposit SOL to reserve
  const userMsol = await createTokenAccountOffCurve(
    connection,
    payer,
    msolMint,
    payer.publicKey
  );
  const [msolMintAuthority] = web3.PublicKey.findProgramAddressSync(
    [state.publicKey.toBytes(), Buffer.from("st_mint")],
    PROGRAM_ID
  );
  const [liqMsolLegAuth] = web3.PublicKey.findProgramAddressSync(
    [state.publicKey.toBytes(), Buffer.from("liq_st_sol_authority")],
    PROGRAM_ID
  );

  await program.methods
    .deposit(new BN(50_000_000_000)) // 50 SOL
    .accounts({
      state: state.publicKey,
      msolMint,
      liqPoolSolLegPda: solLegPda,
      liqPoolMsolLeg: msolLeg,
      liqPoolMsolLegAuthority: liqMsolLegAuth,
      reservePda,
      transferFrom: payer.publicKey,
      mintTo: userMsol,
      msolMintAuthority,
      systemProgram: web3.SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log("deposited 50 SOL");

  // stake_reserve — create stake for validator 0
  const newStake = web3.Keypair.generate();
  const [stakeDepositAuth] = web3.PublicKey.findProgramAddressSync(
    [state.publicKey.toBytes(), Buffer.from("deposit")],
    PROGRAM_ID
  );

  // Need to be in stake-delta window — config may require slots_for_stake_delta near epoch end.
  // Force by warping nearly to epoch end.
  const epochInfo = await connection.getEpochInfo();
  console.log("epoch", epochInfo);
  // Warp slots if validator supports it
  try {
    execSync(
      `solana-test-validator is not a client; use RPC`,
      { stdio: "ignore" }
    );
  } catch {}

  // Use `solana` wait and configValidatorSystem extra runs; or call stakeReserve and see.
  // Many local tests warp: connection.requestAirdrop doesn't warp.
  // solana-test-validator has `solana` CLI: not available. Use JSON RPC `context` 
  // Actually: `solana-validator` doesn't expose warp via normal RPC.
  // ProgramTest has warp_to_slot; test-validator needs `--slots-per-epoch` small and wait.

  // Try stake_reserve anyway — may fail TooEarlyForStakeDelta
  try {
    await program.methods
      .stakeReserve(0)
      .accounts({
        state: state.publicKey,
        validatorList: validatorList.publicKey,
        stakeList: stakeList.publicKey,
        validatorVote: voteAccount.publicKey,
        reservePda,
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
      .rpc();
    console.log("stake_reserve OK", newStake.publicKey.toBase58());
  } catch (e: any) {
    console.error("stake_reserve failed:", e.message);
    console.log("Will try deposit_stake_account path instead...");
    // Create and delegate a stake account manually, then deposit_stake_account
    const userStake = web3.Keypair.generate();
    const stakeTx = web3.StakeProgram.createAccount({
      fromPubkey: payer.publicKey,
      stakePubkey: userStake.publicKey,
      authorized: new web3.Authorized(payer.publicKey, payer.publicKey),
      lamports: 10_000_000_000 + (await connection.getMinimumBalanceForRentExemption(200)),
    });
    await provider.sendAndConfirm(stakeTx, [payer, userStake]);
    const delTx = web3.StakeProgram.delegate({
      stakePubkey: userStake.publicKey,
      authorizedPubkey: payer.publicKey,
      votePubkey: voteAccount.publicKey,
    });
    await provider.sendAndConfirm(delTx, [payer]);
    // Wait for activation — with slots-per-epoch default may need warp.
    // On test validator, activation often next epoch. Use deposit anyway (WAIT_EPOCHS=0).
    await program.methods
      .depositStakeAccount(0)
      .accounts({
        state: state.publicKey,
        validatorList: validatorList.publicKey,
        stakeList: stakeList.publicKey,
        stakeAccount: userStake.publicKey,
        stakeAuthority: payer.publicKey,
        duplicationFlag: dupFlag,
        rentPayer: payer.publicKey,
        msolMint,
        mintTo: userMsol,
        msolMintAuthority,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
        rent: web3.SYSVAR_RENT_PUBKEY,
        systemProgram: web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        stakeProgram: web3.StakeProgram.programId,
      })
      .rpc();
    console.log("deposit_stake_account OK", userStake.publicKey.toBase58());
    (global as any).__stake = userStake.publicKey;
  }

  // Second stake for H1-variant (deposit another delegated stake)
  let stake1Pubkey: string | null = null;
  try {
    const userStake2 = web3.Keypair.generate();
    const rentStake = await connection.getMinimumBalanceForRentExemption(200);
    const stakeTx2 = web3.StakeProgram.createAccount({
      fromPubkey: payer.publicKey,
      stakePubkey: userStake2.publicKey,
      authorized: new web3.Authorized(payer.publicKey, payer.publicKey),
      lamports: 5_000_000_000 + rentStake,
    });
    await provider.sendAndConfirm(stakeTx2, [payer, userStake2]);
    const delTx2 = web3.StakeProgram.delegate({
      stakePubkey: userStake2.publicKey,
      authorizedPubkey: payer.publicKey,
      votePubkey: voteAccount.publicKey,
    });
    await provider.sendAndConfirm(delTx2, [payer]);
    await program.methods
      .depositStakeAccount(0)
      .accounts({
        state: state.publicKey,
        validatorList: validatorList.publicKey,
        stakeList: stakeList.publicKey,
        stakeAccount: userStake2.publicKey,
        stakeAuthority: payer.publicKey,
        duplicationFlag: dupFlag,
        rentPayer: payer.publicKey,
        msolMint,
        mintTo: userMsol,
        msolMintAuthority,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
        rent: web3.SYSVAR_RENT_PUBKEY,
        systemProgram: web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        stakeProgram: web3.StakeProgram.programId,
      })
      .rpc();
    stake1Pubkey = userStake2.publicKey.toBase58();
    console.log("deposit_stake_account #2 OK", stake1Pubkey);
  } catch (e: any) {
    console.error("second stake failed (H1 may be limited):", e.message);
  }

  // Dump accounts
  const fixDir = path.join(__dirname, "..", "fixtures");
  fs.mkdirSync(fixDir, { recursive: true });
  await dumpAccount(state.publicKey, path.join(fixDir, "state.json"));
  await dumpAccount(validatorList.publicKey, path.join(fixDir, "validator_list.json"));
  await dumpAccount(stakeList.publicKey, path.join(fixDir, "stake_list.json"));

  // Find stake0 from stake list via fetch
  const st: any = await program.account.state.fetch(state.publicKey);
  console.log("state delinquent", st.delinquentUpgrader);
  console.log("stake count", st.stakeSystem?.stakeList?.count ?? st.stake_system);

  // Dump all stake accounts referenced — parse from dumped stake list after patch tool prints keys
  // For now dump newStake or userStake if set
  const stakePubkey =
    (global as any).__stake?.toBase58?.() || newStake.publicKey.toBase58();
  await dumpAccount(new web3.PublicKey(stakePubkey), path.join(fixDir, "stake0.json"));
  if (stake1Pubkey) {
    await dumpAccount(new web3.PublicKey(stake1Pubkey), path.join(fixDir, "stake1.json"));
  }

  // Also dump other needed accounts for validator restart
  await dumpAccount(msolMint, path.join(fixDir, "msol_mint.json"));
  await dumpAccount(reservePda, path.join(fixDir, "reserve.json"));
  await dumpAccount(treasuryMsol, path.join(fixDir, "treasury.json"));
  await dumpAccount(operational.publicKey, path.join(fixDir, "operational.json"));
  await dumpAccount(lpMint, path.join(fixDir, "lp_mint.json"));
  await dumpAccount(msolLeg, path.join(fixDir, "msol_leg.json"));
  await dumpAccount(solLegPda, path.join(fixDir, "sol_leg.json"));

  fs.writeFileSync(
    path.join(fixDir, "setup_meta.json"),
    JSON.stringify(
      {
        state: state.publicKey.toBase58(),
        stakeList: stakeList.publicKey.toBase58(),
        validatorList: validatorList.publicKey.toBase58(),
        stake0: stakePubkey,
        stake1: stake1Pubkey,
        vote: voteAccount.publicKey.toBase58(),
        msolMint: msolMint.toBase58(),
        reservePda: reservePda.toBase58(),
        treasuryMsol: treasuryMsol.toBase58(),
        operational: operational.publicKey.toBase58(),
        programId: PROGRAM_ID.toBase58(),
        stakeCount: st.stakeSystem.stakeList.count,
      },
      null,
      2
    )
  );
  console.log("Dumped fixtures to", fixDir);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

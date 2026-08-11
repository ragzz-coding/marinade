/**
 * Decode ValidatorRecord / StakeRecord from Marinade list accounts.
 * List account layout: 8-byte discriminator + [item × item_size].
 * List metadata (item_size, count) lives in State, not the list account.
 */
import { web3 } from "@coral-xyz/anchor";

function readU32(buf: Buffer, off: number) {
  return buf.readUInt32LE(off);
}
function readU64(buf: Buffer, off: number) {
  return buf.readBigUInt64LE(off).toString();
}

export function decodeValidator0(data: Buffer, st: any) {
  const itemSize = Number(st.validatorSystem.validatorList.itemSize);
  const count = Number(st.validatorSystem.validatorList.count);
  if (count < 1) return { count, itemSize, empty: true };
  const start = 8;
  const item = data.subarray(start, start + itemSize);
  return {
    count,
    itemSize,
    validatorAccount: new web3.PublicKey(item.subarray(0, 32)).toBase58(),
    activeBalance: readU64(item, 32),
    score: readU32(item, 40),
    lastStakeDeltaEpoch: readU64(item, 44),
    duplicationFlagBumpSeed: item[52],
    delinquentUpgraderActiveBalance: readU64(item, 53),
  };
}

export function decodeStake0(data: Buffer, st: any) {
  const itemSize = Number(st.stakeSystem.stakeList.itemSize);
  const count = Number(st.stakeSystem.stakeList.count);
  if (count < 1) return { count, itemSize, empty: true };
  const start = 8;
  const item = data.subarray(start, start + itemSize);
  const status = item[49];
  const statusName =
    status === 0 ? "Unknown" : status === 1 ? "Active" : status === 2 ? "Deactivating" : `raw:${status}`;
  return {
    count,
    itemSize,
    stakeAccount: new web3.PublicKey(item.subarray(0, 32)).toBase58(),
    lastUpdateDelegatedLamports: readU64(item, 32),
    lastUpdateEpoch: readU64(item, 40),
    isEmergencyUnstaking: item[48] !== 0,
    lastUpdateStatus: statusName,
  };
}

#!/usr/bin/env bash
# H3 repeatability: restart patched validator + run replay N times.
set -euo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
ROOT=/workspace/stage4-localnet
N="${1:-3}"
OUT="$ROOT/results/h3_repeatability.json"
echo "[]" > "$OUT"

kill_validators() {
  for pid in $(ps -eo pid,cmd | awk '/solana-test-validator/ && !/awk/ {print $1}'); do
    kill -9 "$pid" 2>/dev/null || true
  done
  sleep 2
}

for i in $(seq 1 "$N"); do
  echo "===== H3 RUN $i ====="
  kill_validators
  RUN="$i" python3 - <<'PY' > /tmp/h3_validator_cmd.sh
import json, os, shutil
ROOT="/workspace/stage4-localnet"
FIX=f"{ROOT}/fixtures"
PAT=f"{FIX}/patched"
PROG=f"{ROOT}/programs/marinade_finance.so"
i=os.environ["RUN"]
LEDGER=f"/tmp/marinade-ledger-h3-run{i}"
shutil.rmtree(LEDGER, ignore_errors=True)
accounts = [
  ("state.json", PAT), ("validator_list.json", PAT), ("stake_list.json", PAT), ("stake0.json", PAT),
  ("msol_mint.json", FIX), ("treasury.json", FIX), ("reserve.json", FIX), ("operational.json", FIX),
  ("lp_mint.json", FIX), ("msol_leg.json", FIX), ("sol_leg.json", FIX), ("vote.json", FIX),
]
cmd = (
  "#!/bin/bash\nset -euo pipefail\n"
  f"exec solana-test-validator --reset --ledger {LEDGER} --quiet --slots-per-epoch 32 "
  f"--bpf-program MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD {PROG} --warp-slot 200 "
)
for name,d in accounts:
  path=f"{d}/{name}"
  pk=json.load(open(path))["pubkey"]
  cmd += f"--account {pk} {path} "
cmd += f"> {ROOT}/logs/validator_h3_run{i}.log 2>&1\n"
print(cmd)
PY
  chmod +x /tmp/h3_validator_cmd.sh
  nohup bash /tmp/h3_validator_cmd.sh >/dev/null 2>&1 &
  sleep 8
  cd "$ROOT/ts"
  set +e
  npx --yes tsx h3_replay.ts > "$ROOT/logs/h3_replay_run${i}.log" 2>&1
  rc=$?
  set -e
  RUN="$i" RC="$rc" OUT="$OUT" ROOT="$ROOT" python3 - <<'PY'
import json, os
from pathlib import Path
out=Path(os.environ["OUT"])
arr=json.loads(out.read_text())
rep=json.loads(Path(os.environ["ROOT"],"results/h3_report.json").read_text())
arr.append({
  "run": int(os.environ["RUN"]),
  "exit": int(os.environ["RC"]),
  "all_pass": all(a["pass"] for a in rep["assertions"]),
  "updateOk": rep["updateOk"],
  "finalizeOk": rep["finalizeOk"],
  "finalize_panic": any("overflow" in (l or "") for l in ((rep.get("finalizeErr") or {}).get("logs") or [])),
  "t2_active": (rep.get("t2") or {}).get("validator0",{}).get("activeBalance"),
  "t2_shadow": (rep.get("t2") or {}).get("validator0",{}).get("delinquentUpgraderActiveBalance"),
  "t4_fsm": (rep.get("t4") or {}).get("delinquentUpgrader"),
})
out.write_text(json.dumps(arr, indent=2))
print("recorded", arr[-1])
PY
done
echo "DONE repeatability"
cat "$OUT"

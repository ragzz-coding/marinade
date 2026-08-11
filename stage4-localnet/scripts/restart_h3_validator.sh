#!/usr/bin/env bash
# Restart solana-test-validator with patched H3 precondition accounts + Marinade BPF.
set -euo pipefail
ROOT=/workspace/stage4-localnet
FIX=$ROOT/fixtures
PAT=$FIX/patched
PROG=$ROOT/programs/marinade_finance.so
if [[ ! -f "$PROG" ]]; then
  PROG=$ROOT/marinade_finance.so
fi
LEDGER=/tmp/marinade-ledger-h3

killall solana-test-validator 2>/dev/null || true
sleep 2
rm -rf "$LEDGER"

# Also need duplication flag PDA if present on live chain — dump before kill if possible
# Warp well past epoch 0 so deactivation_epoch=0 is inactive.
WARP_SLOT=200

ARGS=(
  --reset
  --ledger "$LEDGER"
  --quiet
  --slots-per-epoch 32
  --bpf-program MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD "$PROG"
  --warp-slot "$WARP_SLOT"
  --account "$(python3 -c "import json;print(json.load(open('$PAT/state.json'))['pubkey'])")" "$PAT/state.json"
  --account "$(python3 -c "import json;print(json.load(open('$PAT/validator_list.json'))['pubkey'])")" "$PAT/validator_list.json"
  --account "$(python3 -c "import json;print(json.load(open('$PAT/stake_list.json'))['pubkey'])")" "$PAT/stake_list.json"
  --account "$(python3 -c "import json;print(json.load(open('$PAT/stake0.json'))['pubkey'])")" "$PAT/stake0.json"
  --account "$(python3 -c "import json;print(json.load(open('$FIX/msol_mint.json'))['pubkey'])")" "$FIX/msol_mint.json"
  --account "$(python3 -c "import json;print(json.load(open('$FIX/treasury.json'))['pubkey'])")" "$FIX/treasury.json"
  --account "$(python3 -c "import json;print(json.load(open('$FIX/reserve.json'))['pubkey'])")" "$FIX/reserve.json"
  --account "$(python3 -c "import json;print(json.load(open('$FIX/operational.json'))['pubkey'])")" "$FIX/operational.json"
  --account "$(python3 -c "import json;print(json.load(open('$FIX/lp_mint.json'))['pubkey'])")" "$FIX/lp_mint.json"
  --account "$(python3 -c "import json;print(json.load(open('$FIX/msol_leg.json'))['pubkey'])")" "$FIX/msol_leg.json"
  --account "$(python3 -c "import json;print(json.load(open('$FIX/sol_leg.json'))['pubkey'])")" "$FIX/sol_leg.json"
  --account "$(python3 -c "import json;print(json.load(open('$FIX/vote.json'))['pubkey'])")" "$FIX/vote.json"
)

mkdir -p "$ROOT/logs"
solana-test-validator "${ARGS[@]}" >"$ROOT/logs/validator_h3.log" 2>&1 &
echo "validator pid $!"
sleep 8
solana cluster-version -u localhost
solana epoch-info -u localhost

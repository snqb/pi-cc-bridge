#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROVIDER="pi-cc-bridge"
MODEL="${MODEL:-claude-haiku-4-5}"
TMP_ROOT="${TMPDIR:-/tmp}/pi-cc-bridge-regression-$$"
mkdir -p "$TMP_ROOT"
trap 'rm -rf "$TMP_ROOT"' EXIT

expect_eq() {
  local got="$1"
  local want="$2"
  local name="$3"
  if [[ "$got" != "$want" ]]; then
    echo "[$name] expected: $want" >&2
    echo "[$name] got:      $got" >&2
    exit 1
  fi
  echo "PASS: $name"
}

expect_contains() {
  local got="$1"
  local want="$2"
  local name="$3"
  if [[ "$got" != *"$want"* ]]; then
    echo "[$name] expected output containing: $want" >&2
    echo "[$name] got: $got" >&2
    exit 1
  fi
  echo "PASS: $name"
}

run_pi() {
  local session_dir="$1"
  shift
  pi -e "$ROOT" --session-dir "$session_dir" --provider "$PROVIDER" --model "$MODEL" -p "$@"
}

run_pi_from_cwd() {
  local workdir="$1"
  local session_dir="$2"
  shift 2
  (
    cd "$workdir"
    pi -e "$ROOT" --session-dir "$session_dir" --provider "$PROVIDER" --model "$MODEL" -p "$@"
  )
}

BASIC_DIR="$TMP_ROOT/basic"
mkdir -p "$BASIC_DIR"
out=$(run_pi "$BASIC_DIR" "Reply with exactly: REG_BASIC_ONE")
expect_eq "$out" "REG_BASIC_ONE" "basic-first-turn"
out=$(pi -e "$ROOT" --session-dir "$BASIC_DIR" --continue --provider "$PROVIDER" --model "$MODEL" -p "What was my previous exact reply token? Reply with exactly: REG_BASIC_ONE_SEEN")
expect_eq "$out" "REG_BASIC_ONE_SEEN" "basic-continue"

TOOL_DIR="$TMP_ROOT/tool"
mkdir -p "$TOOL_DIR"
out=$(run_pi "$TOOL_DIR" "Use the read tool on /etc/hosts, then reply with exactly: REG_TOOL_DONE")
expect_eq "$out" "REG_TOOL_DONE" "tool-first-turn"
out=$(pi -e "$ROOT" --session-dir "$TOOL_DIR" --continue --provider "$PROVIDER" --model "$MODEL" -p "What file did you inspect previously? Reply with exactly: REG_TOOL_SEEN")
expect_contains "$out" "REG_TOOL_SEEN" "tool-continue"

STATUS_DIR="$TMP_ROOT/status"
mkdir -p "$STATUS_DIR"
out=$(run_pi "$STATUS_DIR" "/pi-cc-bridge-status")
expect_contains "$out" "provider: pi-cc-bridge" "status-provider"
expect_contains "$out" "duplicateInstallSeverity:" "status-duplicates"
expect_contains "$out" "sqliteDb:" "status-sqlite"

DOCTOR_DIR="$TMP_ROOT/doctor"
mkdir -p "$DOCTOR_DIR"
out=$(run_pi "$DOCTOR_DIR" "/pi-cc-bridge-doctor")
expect_contains "$out" "doctorStatus:" "doctor-status"
expect_contains "$out" "claudeAuth:" "doctor-auth"
expect_contains "$out" "duplicates:" "doctor-duplicates"

DUP_PROJECT="$TMP_ROOT/duplicate-project"
mkdir -p "$DUP_PROJECT/.pi" "$TMP_ROOT/duplicate-session"
cat > "$DUP_PROJECT/.pi/settings.json" <<'JSON'
{
  "packages": [
    "./extensions/pi-cc-bridge"
  ]
}
JSON

out=$(run_pi_from_cwd "$DUP_PROJECT" "$TMP_ROOT/duplicate-session" "/pi-cc-bridge-doctor")
expect_contains "$out" "doctorStatus: fatal" "doctor-fatal-duplicate"
expect_contains "$out" "duplicates: fatal" "doctor-duplicate-detail"

set +e
out=$(run_pi_from_cwd "$DUP_PROJECT" "$TMP_ROOT/duplicate-session" "Reply with exactly: SHOULD_NOT_RUN" 2>&1)
code=$?
set -e
if [[ "$code" -eq 0 ]]; then
  echo "[provider-duplicate-hard-fail] expected non-zero exit" >&2
  exit 1
fi
expect_contains "$out" "pi-cc-bridge refused to run" "provider-duplicate-hard-fail"

echo "All regression checks passed."

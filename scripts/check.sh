#!/usr/bin/env bash
# The repository's one check command; CI runs exactly this.
#   1. content guard over tracked files
#   2. guard self-test on synthetic cases in throwaway repositories
#   3. agent-instruction adapters still point at AGENTS.md
#   4. each project's tests
#   5. shellcheck, when it is installed (optional)
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"
fail() { echo "check: $*" >&2; exit 1; }
step() { printf '\n== %s\n' "$1"; }

step "content guard"
scripts/guard.sh

step "guard self-test"
make_scratch() { # same temp-space rule as the guard: $TMPDIR named explicitly, else the git dir
  mktemp -d "${TMPDIR:-/tmp}/check.XXXXXX" 2>/dev/null || mktemp -d "$(git rev-parse --git-dir)/check.XXXXXX"
}
scratch=$(make_scratch) || fail "cannot create a temporary directory"
trap 'rm -rf "$scratch"' EXIT
scratch=$(cd "$scratch" && pwd -P)    # absolute, so hook paths resolve inside nested fixture repos
cases=0

# Synthetic values are assembled at runtime from split fragments, so this
# file never contains a literal marker or credential shape for the guard.
mrn="M""RN"; dob="D""OB"; birth="date of"" birth"; sec="#sec""ure#"
local_home_prefix="/Use""rs"; pk="PRIV""ATE"; sk="s""k-"
a36=$(printf 'a%.0s' {1..36}); q16=$(printf 'Q%.0s' {1..16}); z20=$(printf 'z%.0s' {1..20})

repo() { # repo NAME: fresh throwaway repository holding a copy of the guard
  mkdir -p "$scratch/$1/scripts"
  git -C "$scratch/$1" init -q
  cp "$root/scripts/guard.sh" "$scratch/$1/scripts/guard.sh"
  git -C "$scratch/$1" add scripts/guard.sh
}

text_case() { # text_case NAME FILE CONTENT: repository with FILE holding CONTENT, staged
  repo "$1"
  printf '%s\n' "$3" > "$scratch/$1/$2"
  git -C "$scratch/$1" add -- "$2"
}

expect() { # expect NAME MODE WANT_EXIT [RULE] [TEXT_THAT_MUST_NOT_APPEAR]
  local name=$1 mode=$2 want=$3 rule=${4:-} secret=${5:-} got=0 flag=""
  if [ "$mode" = staged ]; then flag=--staged; fi
  # shellcheck disable=SC2086  # $flag is empty or one word
  (cd "$scratch/$name" && bash scripts/guard.sh $flag < /dev/null) > "$scratch/$name.out" 2>&1 || got=$?
  if [ "$got" != "$want" ]; then
    sed 's/^/    /' "$scratch/$name.out" >&2
    fail "self-test $name ($mode): guard exited $got, expected $want"
  fi
  if [ -n "$rule" ] && ! grep -qF "[$rule]" "$scratch/$name.out"; then
    fail "self-test $name ($mode): expected a [$rule] finding"
  fi
  if [ -n "$secret" ] && grep -qF -- "$secret" "$scratch/$name.out"; then
    fail "self-test $name ($mode): the guard printed matched text"
  fi
  cases=$((cases + 1))
}

text_case clean notes.txt "hello world"
expect clean staged 0
expect clean worktree 0

while IFS='|' read -r rule content; do
  text_case "$rule" notes.txt "$content"
  expect "$rule" staged 1 "$rule" "$content"
done <<EOF
record-number-marker|id $mrn 1234567
birth-date-marker|$dob 1900-01-01
record-phrase|$birth unknown
secure-tag|subject $sec hello
ssn-shape|$(printf '%s-%s-%s' 123 45 6789)
local-home-path|$local_home_prefix/someone/notes.txt
private-key|-----BEGIN RSA $pk KEY-----
github-token|ghp_$a36
llm-api-key|key $sk$a36
cloud-key|AKIA$q16
secret-assignment|api_key = '$z20'
EOF

text_case colon-path "a:b.txt" "id $mrn 1"
expect colon-path staged 1 record-number-marker
grep -qF "a:b.txt:1  [record-number-marker]" "$scratch/colon-path.out" \
  || fail "self-test colon-path: wrong path:line report"

for name in .env .ENV id_rsa server.pem; do
  repo "cred-$name"
  printf 'X=1\n' > "$scratch/cred-$name/$name"
  printf '%s\n' "$name" > "$scratch/cred-$name/.guard-allow"
  git -C "$scratch/cred-$name" add -- "$name" .guard-allow
  expect "cred-$name" staged 1 credential-file    # credentials are never allow-listed
done
text_case env-example .env.example "X=changeme"
expect env-example staged 0

text_case data-space "my table.csv" "a,b"
expect data-space staged 1 data-file
grep -qF "my table.csv  [data-file]" "$scratch/data-space.out" \
  || fail "self-test data-space: path with a space not reported"
text_case data-tab "$(printf 'tab\tname.CSV')" "a,b"
expect data-tab staged 1 data-file    # NUL-safe listing, case-insensitive extension
repo newline-allow
nl_name=$(printf 'unexpected\npermitted.csv')
printf 'a,b\n' > "$scratch/newline-allow/$nl_name"
printf 'permitted.csv\n' > "$scratch/newline-allow/.guard-allow"
git -C "$scratch/newline-allow" add -- "$nl_name" .guard-allow
expect newline-allow staged 1 data-file    # a newline in a path cannot match a line of .guard-allow

repo binary
printf 'a\000b' > "$scratch/binary/blob.bin"
git -C "$scratch/binary" add blob.bin
expect binary staged 1 binary-file
printf 'blob.bin\n' > "$scratch/binary/.guard-allow"
expect binary staged 1 binary-file    # an unstaged exception does not count
git -C "$scratch/binary" add .guard-allow
expect binary staged 0                # the staged exception does
git -C "$scratch/binary" rm -q --cached blob.bin .guard-allow
expect binary staged 0                # a staged removal leaves nothing to flag

text_case worktree-binary sample.txt "plain"
printf 'now\000binary' > "$scratch/worktree-binary/sample.txt"
expect worktree-binary worktree 1 binary-file
expect worktree-binary staged 0

text_case worktree-text sample.txt "plain"
printf 'id %s 1\n' "$mrn" > "$scratch/worktree-text/sample.txt"
expect worktree-text worktree 1 record-number-marker
expect worktree-text staged 0

text_case tmp-fallback notes.txt "hello world"    # an unusable $TMPDIR falls back to the git dir
if ! (cd "$scratch/tmp-fallback" && TMPDIR=/nonexistent-guard-tmp bash scripts/guard.sh --staged < /dev/null) > "$scratch/tmp-fallback.out" 2>&1; then
  sed 's/^/    /' "$scratch/tmp-fallback.out" >&2
  fail "self-test tmp-fallback: guard failed when \$TMPDIR is unusable"
fi
if ls -d "$scratch"/tmp-fallback/.git/guard.* > /dev/null 2>&1; then
  fail "self-test tmp-fallback: guard left its temp dir in the git dir"
fi
cases=$((cases + 1))

# This script's own allocation takes the same fallback.
fallback=$(TMPDIR=/nonexistent-check-tmp make_scratch) || fail "self-test check-tmp-fallback: no temp dir when \$TMPDIR is unusable"
gitdir=$(cd "$(git rev-parse --git-dir)" && pwd -P)
case "$(cd "$fallback" && pwd -P)" in
  "$gitdir"/check.*) rm -rf "$fallback" ;;
  *) rm -rf "$fallback"; fail "self-test check-tmp-fallback: temp dir outside the git dir" ;;
esac
cases=$((cases + 1))

# The guard must not consult a configured fsmonitor (sandboxes can't reach its daemon).
hook="$scratch/fsmonitor-hook"; hook_log="$scratch/fsmonitor.log"
printf '#!/bin/sh\necho called >> "%s"\nexit 1\n' "$hook_log" > "$hook"
chmod +x "$hook"
text_case fsmonitor notes.txt "hello world"
with_hook() { (cd "$scratch/fsmonitor" && GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0="$hook" "$@") > /dev/null 2>&1 < /dev/null; }
with_hook git ls-files    # control: plain git does consult the hook
if [ -s "$hook_log" ]; then
  : > "$hook_log"
  with_hook bash scripts/guard.sh --staged || fail "self-test fsmonitor: guard failed with a configured fsmonitor"
  with_hook bash scripts/guard.sh || fail "self-test fsmonitor: guard failed with a configured fsmonitor (working tree)"
  [ ! -s "$hook_log" ] || fail "self-test fsmonitor: the guard consulted core.fsmonitor"
  cases=$((cases + 1))
else
  echo "  fsmonitor case skipped: this git doesn't consult the hook for ls-files"
fi

echo "guard self-test: $cases cases passed"

step "agent instruction adapters"
grep -qxF '@AGENTS.md' CLAUDE.md || fail "CLAUDE.md must import @AGENTS.md"
grep -qF 'AGENTS.md' .github/copilot-instructions.md || fail ".github/copilot-instructions.md must point to AGENTS.md"
lines=$(($(wc -l < AGENTS.md)))
bytes=$(($(wc -c < AGENTS.md)))
if [ "$lines" -gt 120 ] || [ "$bytes" -gt 16384 ]; then
  fail "AGENTS.md is $lines lines / $bytes bytes; keep startup instructions under 120 lines and 16 KiB"
fi
echo "adapters ok; AGENTS.md $lines lines"

step "project tests"
found=0
for dir in projects/*/; do
  [ -d "$dir" ] || continue
  found=1
  if [ -f "$dir/package.json" ]; then
    echo "-- $dir (node $(node --version))"
    (cd "$dir" && npm test --silent)
  else
    fail "$dir has no recognised test entry (add a package.json test script, or teach scripts/check.sh its language)"
  fi
done
[ "$found" -eq 1 ] || echo "no projects yet"

step "shellcheck"
if command -v shellcheck > /dev/null 2>&1; then
  shellcheck scripts/*.sh .githooks/pre-commit
  echo "shellcheck ok"
else
  echo "shellcheck not installed; skipped"
fi

printf '\nAll checks passed.\n'

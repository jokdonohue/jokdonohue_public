#!/usr/bin/env bash
# Content guard: a cheap heuristic tripwire that stops common leaks before they
# reach GitHub: patient-record markers, credential shapes, absolute local
# paths, credential files, data exports and binary files. It cannot prove that
# content is safe to publish; a person reviewing the change still decides that.
#
#   scripts/guard.sh            check tracked files as they are in the working tree
#   scripts/guard.sh --staged   check the staged snapshot (the pre-commit hook)
#
# Findings print as path:line plus a rule name, never the matched text, so a
# hit cannot leak into a public CI log. To commit a binary or data file on
# purpose, list its exact repo-relative path in .guard-allow; in --staged mode
# only the staged copy of that list counts. The guard skips its own file,
# which necessarily contains the patterns. Exit status: 0 clean, 1 findings,
# 2 usage or scanner error.
set -euo pipefail

cached=""
column=w
scope="working-tree"
case "${1:-}" in
  "") ;;
  --staged) cached="--cached"; column=i; scope="staged" ;;
  *) echo "usage: scripts/guard.sh [--staged]" >&2; exit 2 ;;
esac

top=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "guard: not inside a git repository" >&2; exit 2; }
cd "$top"

scanner_error() { echo "guard: scanner error: $*" >&2; exit 2; }
work=$(mktemp -d) || scanner_error "cannot create a temporary directory"
trap 'rm -rf "$work"' EXIT
findings=0
finding() { printf '  %s  [%s]\n' "$1" "$2"; findings=$((findings + 1)); }

# The exception list comes from the same snapshot as the content checked.
if [ -n "$cached" ]; then
  git show :.guard-allow > "$work/allow" 2>/dev/null || : > "$work/allow"
else
  cat .guard-allow > "$work/allow" 2>/dev/null || : > "$work/allow"
fi
allowed() { # exact-path lookup; grep error -> not allowed (fails closed)
  case "$1" in *$'\n'*) return 1 ;; esac  # the list is line-based, so a path with a newline never matches
  grep -qxF -- "$1" "$work/allow"
}

# Content rules: name, git-grep flags, pattern (POSIX ERE unless -F).
while IFS=$'\t' read -r rule flags pattern; do
  [ -n "$rule" ] || continue
  rc=0
  # shellcheck disable=SC2086  # $cached and $flags are deliberate word lists
  git grep $cached -l -z -I $flags -e "$pattern" -- . ':(exclude)scripts/guard.sh' > "$work/matched" || rc=$?
  [ "$rc" -le 1 ] || scanner_error "git grep exited $rc on rule $rule"
  while IFS= read -r -d '' path; do
    # shellcheck disable=SC2086
    lines=$(git grep $cached -h -n -I $flags -e "$pattern" -- ":(literal)$path" | cut -d: -f1 | paste -sd, -) \
      || scanner_error "git grep failed on $path"
    finding "$path:$lines" "$rule"
  done < "$work/matched"
done <<'RULES'
record-number-marker	-E	(^|[^A-Za-z0-9_])MRN([^A-Za-z0-9_]|$)
birth-date-marker	-E	(^|[^A-Za-z0-9_])DOB([^A-Za-z0-9_]|$)
record-phrase	-i -E	medical record (number|no\.?)|date of birth
secure-tag	-i -F	#secure#
ssn-shape	-E	(^|[^0-9])[0-9]{3}-[0-9]{2}-[0-9]{4}([^0-9]|$)
local-home-path	-E	/Users/[A-Za-z0-9._-]+/
private-key	-E	-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY-----
github-token	-E	gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}
llm-api-key	-E	(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}
cloud-key	-E	AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[abposr]-[A-Za-z0-9-]{10,}
secret-assignment	-i -E	(api[_-]?key|secret|token|passw(or)?d)["']?[[:space:]]*[:=][[:space:]]*["'][A-Za-z0-9_/+=.-]{16,}["']
RULES

# File rules, NUL-safe and case-insensitive (macOS paths usually are).
# Columns from `git ls-files --eol`: i/ = staged copy, w/ = working tree.
git ls-files -z --eol > "$work/entries" || scanner_error "git ls-files failed"
shopt -s nocasematch
while IFS= read -r -d '' entry; do
  info=${entry%%$'\t'*}
  path=${entry#*$'\t'}
  name=${path##*/}
  case "$name" in
    .env.example|.env.sample|.env.template) ;;
    .env|.env.*|.netrc|.pypirc|id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials.json|*.pem|*.p12|*.pfx|*.key|*.keystore|*.jks|*.kdbx)
      finding "$path" credential-file ;;  # never allowed, even via .guard-allow
    *.csv|*.tsv|*.hl7)
      allowed "$path" || finding "$path" data-file ;;
  esac
  case " $info " in
    *" $column/-text "*) allowed "$path" || finding "$path" binary-file ;;
  esac
done < "$work/entries"
shopt -u nocasematch

if [ "$findings" -gt 0 ]; then
  echo "guard: $findings finding(s) in $scope files. Fix them, or ask the owner about an exception; never bypass the guard." >&2
  exit 1
fi
echo "guard: clean ($scope files)"

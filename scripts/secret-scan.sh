#!/usr/bin/env bash
# Fails when a tracked file looks like it holds a secret: private keys, GitHub, AWS, Cloudflare and OpenAI-style
# tokens, and a password or secret written as a literal. Test values say what they are and stay out: names with
# example, test, dummy, fake, synthetic, prova (test), private, «non-deve…» (must not…), never-persist; counting
# sequences (0123456789, abcdefghij, the bytes 0-31 in base64 AAECAwQF…); and the throwaway key of the local FTPS
# test server (scripts/fixtures/certs/).
set -euo pipefail
cd "$(dirname "$0")/.."
pattern='-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{32,}|(password|passwd|secret|api[_-]?key|token)["'"'"']?\s*[:=]\s*["'"'"'][A-Za-z0-9+/_=-]{20,}["'"'"']'
hits=$(git ls-files -z | xargs -0 grep -nIiE -e "$pattern" -- \
  | grep -viE 'example|dummy|fake|synthetic|test-key|test-token|placeholder|xxxxx|nonvero|prova|never-persist|non-deve|_private|aggiornata|portachiavi|key-material' \
  | grep -vE '0123456789|abcdefghij|AAECAwQFBgcICQoL' \
  | grep -vE '([a-z0-9])\1{7}-|^scripts/fixtures/certs/' || true)
if [ -n "$hits" ]; then
  echo "Possibili segreti nei file del repository:" >&2
  echo "$hits" | cut -c1-200 >&2
  exit 1
fi
echo "Nessun segreto trovato."

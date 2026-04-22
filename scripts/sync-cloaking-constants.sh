#!/usr/bin/env bash
#
# Sync check for the OpenCode cloaking constants.
#
# Pulls the current `src/constants.ts` from ex-machina-co/opencode-anthropic-auth
# and extracts OPENCODE_IDENTITY_PREFIX, PARAGRAPH_REMOVAL_ANCHORS and
# TEXT_REPLACEMENTS. Compares the extracted values against the ones baked into
# src/services/claudeCloakingUtils.js in this repo.
#
# Exit code:
#   0  local copy is in sync with upstream
#   1  drift detected (stdout shows the diff) - a human must update
#      claudeCloakingUtils.js and commit
#   2  network or parse failure
#
# Intended to be run by a cron / GitHub Action / pre-release hook. Purely a
# drift detector; does NOT auto-edit files because a human should review each
# anchor/replacement change before trusting it in production.

set -euo pipefail

UPSTREAM_RAW_URL="${UPSTREAM_RAW_URL:-https://raw.githubusercontent.com/ex-machina-co/opencode-anthropic-auth/main/src/constants.ts}"
LOCAL_FILE="${LOCAL_FILE:-src/services/claudeCloakingUtils.js}"

cd "$(dirname "$0")/.."

if [[ ! -f "${LOCAL_FILE}" ]]; then
  echo "ERROR: ${LOCAL_FILE} not found (are you in the repo root?)" >&2
  exit 2
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "${tmpdir}"' EXIT

upstream_ts="${tmpdir}/constants.ts"
if ! curl -fsSL "${UPSTREAM_RAW_URL}" -o "${upstream_ts}"; then
  echo "ERROR: failed to fetch ${UPSTREAM_RAW_URL}" >&2
  exit 2
fi

# --- Extract upstream values -------------------------------------------------

extract_ts_string() {
  # $1 = TS identifier name, prints its string literal value
  node -e '
    const fs = require("fs");
    const src = fs.readFileSync(process.argv[1], "utf8");
    const name = process.argv[2];
    const re = new RegExp(
      "export\\s+const\\s+" + name + "\\s*=\\s*([\"\x27])([\\s\\S]*?)\\1",
      "m"
    );
    const m = src.match(re);
    if (!m) { process.exit(3); }
    process.stdout.write(m[2]);
  ' "${upstream_ts}" "$1"
}

extract_ts_string_array() {
  # $1 = TS identifier, prints one entry per line
  node -e '
    const fs = require("fs");
    const src = fs.readFileSync(process.argv[1], "utf8");
    const name = process.argv[2];
    const re = new RegExp(
      "export\\s+const\\s+" + name + "\\s*(?::[^=]+)?=\\s*\\[([\\s\\S]*?)\\]",
      "m"
    );
    const m = src.match(re);
    if (!m) { process.exit(3); }
    const entries = Array.from(m[1].matchAll(/[\x27"]([^\x27"]+)[\x27"]/g))
      .map(x => x[1]);
    for (const e of entries) process.stdout.write(e + "\n");
  ' "${upstream_ts}" "$1"
}

extract_ts_replacement_pairs() {
  # Prints `match=>replacement` one per line
  node -e '
    const fs = require("fs");
    const src = fs.readFileSync(process.argv[1], "utf8");
    const name = process.argv[2];
    const re = new RegExp(
      "export\\s+const\\s+" + name + "\\s*(?::[^=]+)?=\\s*\\[([\\s\\S]*?)\\]",
      "m"
    );
    const m = src.match(re);
    if (!m) { process.exit(3); }
    const objRe = /\{\s*match:\s*[\x27"]([^\x27"]+)[\x27"]\s*,\s*replacement:\s*[\x27"]([^\x27"]+)[\x27"]\s*,?\s*\}/g;
    let pair;
    while ((pair = objRe.exec(m[1])) !== null) {
      process.stdout.write(pair[1] + "=>" + pair[2] + "\n");
    }
  ' "${upstream_ts}" "$1"
}

upstream_identity="$(extract_ts_string OPENCODE_IDENTITY_PREFIX)"
upstream_anchors="$(extract_ts_string_array PARAGRAPH_REMOVAL_ANCHORS | sort)"
upstream_pairs="$(extract_ts_replacement_pairs TEXT_REPLACEMENTS | sort)"

# --- Extract local values ----------------------------------------------------

extract_js_string() {
  node -e '
    const fs = require("fs");
    const src = fs.readFileSync(process.argv[1], "utf8");
    const name = process.argv[2];
    const re = new RegExp(
      "const\\s+" + name + "\\s*=\\s*([\"\x27])([\\s\\S]*?)\\1",
      "m"
    );
    const m = src.match(re);
    if (!m) { process.exit(3); }
    process.stdout.write(m[2]);
  ' "${LOCAL_FILE}" "$1"
}

extract_js_string_array() {
  node -e '
    const fs = require("fs");
    const src = fs.readFileSync(process.argv[1], "utf8");
    const name = process.argv[2];
    const re = new RegExp(
      "const\\s+" + name + "\\s*=\\s*\\[([\\s\\S]*?)\\]",
      "m"
    );
    const m = src.match(re);
    if (!m) { process.exit(3); }
    const entries = Array.from(m[1].matchAll(/[\x27"]([^\x27"]+)[\x27"]/g))
      .map(x => x[1]);
    for (const e of entries) process.stdout.write(e + "\n");
  ' "${LOCAL_FILE}" "$1"
}

extract_js_replacement_pairs() {
  node -e '
    const fs = require("fs");
    const src = fs.readFileSync(process.argv[1], "utf8");
    const name = process.argv[2];
    const re = new RegExp(
      "const\\s+" + name + "\\s*=\\s*\\[([\\s\\S]*?)\\]",
      "m"
    );
    const m = src.match(re);
    if (!m) { process.exit(3); }
    const objRe = /\{\s*match:\s*[\x27"]([^\x27"]+)[\x27"]\s*,\s*replacement:\s*[\x27"]([^\x27"]+)[\x27"]\s*,?\s*\}/g;
    let pair;
    while ((pair = objRe.exec(m[1])) !== null) {
      process.stdout.write(pair[1] + "=>" + pair[2] + "\n");
    }
  ' "${LOCAL_FILE}" "$1"
}

local_identity="$(extract_js_string OPENCODE_IDENTITY_PREFIX)"
local_anchors="$(extract_js_string_array PARAGRAPH_REMOVAL_ANCHORS | sort)"
local_pairs="$(extract_js_replacement_pairs TEXT_REPLACEMENTS | sort)"

# --- Compare -----------------------------------------------------------------

drift=0

if [[ "${upstream_identity}" != "${local_identity}" ]]; then
  echo "DRIFT: OPENCODE_IDENTITY_PREFIX"
  echo "  upstream: ${upstream_identity}"
  echo "  local:    ${local_identity}"
  drift=1
fi

if [[ "${upstream_anchors}" != "${local_anchors}" ]]; then
  echo "DRIFT: PARAGRAPH_REMOVAL_ANCHORS"
  diff <(printf '%s\n' "${local_anchors}") <(printf '%s\n' "${upstream_anchors}") \
    | sed 's/^/  /'
  drift=1
fi

if [[ "${upstream_pairs}" != "${local_pairs}" ]]; then
  echo "DRIFT: TEXT_REPLACEMENTS"
  diff <(printf '%s\n' "${local_pairs}") <(printf '%s\n' "${upstream_pairs}") \
    | sed 's/^/  /'
  drift=1
fi

if [[ "${drift}" -eq 0 ]]; then
  echo "OK: ${LOCAL_FILE} is in sync with upstream (${UPSTREAM_RAW_URL})"
  exit 0
fi

echo ""
echo "Update ${LOCAL_FILE} to match upstream, then commit."
echo "Upstream source: ${UPSTREAM_RAW_URL}"
exit 1

#!/usr/bin/env bash
#
# Sync check for the OpenCode cloaking + CCH-billing constants.
#
# Pulls the current `src/constants.ts` from ex-machina-co/opencode-anthropic-auth
# and extracts:
#   * cloaking      : OPENCODE_IDENTITY_PREFIX, PARAGRAPH_REMOVAL_ANCHORS,
#                      TEXT_REPLACEMENTS  → src/services/claudeCloakingUtils.js
#   * cch billing    : CCH_SALT, CCH_POSITIONS, CLAUDE_CODE_VERSION,
#                      CLAUDE_CODE_ENTRYPOINT  → src/utils/cchHelper.js
# Compares the extracted values against the ones baked into the local files.
#
# Exit code:
#   0  local copy is in sync with upstream
#   1  drift detected (stdout shows the diff) - a human must update
#      claudeCloakingUtils.js / cchHelper.js and commit
#   2  network or parse failure
#
# Intended to be run by a cron / GitHub Action / pre-release hook. Purely a
# drift detector; does NOT auto-edit files because a human should review each
# anchor/replacement change before trusting it in production.

set -euo pipefail

UPSTREAM_RAW_URL="${UPSTREAM_RAW_URL:-https://raw.githubusercontent.com/ex-machina-co/opencode-anthropic-auth/main/src/constants.ts}"
LOCAL_CLOAKING_FILE="${LOCAL_CLOAKING_FILE:-${LOCAL_FILE:-src/services/claudeCloakingUtils.js}}"
LOCAL_CCH_FILE="${LOCAL_CCH_FILE:-src/utils/cchHelper.js}"

cd "$(dirname "$0")/.."

for f in "${LOCAL_CLOAKING_FILE}" "${LOCAL_CCH_FILE}"; do
  if [[ ! -f "${f}" ]]; then
    echo "ERROR: ${f} not found (are you in the repo root?)" >&2
    exit 2
  fi
done

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

extract_ts_number_array() {
  # $1 = TS identifier, prints comma-joined number list (e.g. "4,7,20")
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
    const nums = Array.from(m[1].matchAll(/-?\d+(?:\.\d+)?/g)).map(x => x[0]);
    process.stdout.write(nums.join(","));
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
  # $1 = local JS file, $2 = identifier name
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
  ' "$1" "$2"
}

extract_js_string_array() {
  # $1 = local JS file, $2 = identifier name
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
  ' "$1" "$2"
}

extract_js_replacement_pairs() {
  # $1 = local JS file, $2 = identifier name
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
  ' "$1" "$2"
}

extract_js_number_array() {
  # $1 = local JS file, $2 = identifier name; prints comma-joined numbers
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
    const nums = Array.from(m[1].matchAll(/-?\d+(?:\.\d+)?/g)).map(x => x[0]);
    process.stdout.write(nums.join(","));
  ' "$1" "$2"
}

# Cloaking constants live in claudeCloakingUtils.js
local_identity="$(extract_js_string "${LOCAL_CLOAKING_FILE}" OPENCODE_IDENTITY_PREFIX)"
local_anchors="$(extract_js_string_array "${LOCAL_CLOAKING_FILE}" PARAGRAPH_REMOVAL_ANCHORS | sort)"
local_pairs="$(extract_js_replacement_pairs "${LOCAL_CLOAKING_FILE}" TEXT_REPLACEMENTS | sort)"

# CCH-billing constants live in cchHelper.js
upstream_cch_salt="$(extract_ts_string CCH_SALT)"
upstream_cch_positions="$(extract_ts_number_array CCH_POSITIONS)"
upstream_cc_version="$(extract_ts_string CLAUDE_CODE_VERSION)"
upstream_cc_entrypoint="$(extract_ts_string CLAUDE_CODE_ENTRYPOINT)"

local_cch_salt="$(extract_js_string "${LOCAL_CCH_FILE}" CCH_SALT)"
local_cch_positions="$(extract_js_number_array "${LOCAL_CCH_FILE}" CCH_POSITIONS)"
local_cc_version="$(extract_js_string "${LOCAL_CCH_FILE}" CLAUDE_CODE_VERSION)"
local_cc_entrypoint="$(extract_js_string "${LOCAL_CCH_FILE}" CLAUDE_CODE_ENTRYPOINT)"

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

if [[ "${upstream_cch_salt}" != "${local_cch_salt}" ]]; then
  echo "DRIFT: CCH_SALT"
  echo "  upstream: ${upstream_cch_salt}"
  echo "  local:    ${local_cch_salt}"
  drift=1
fi

if [[ "${upstream_cch_positions}" != "${local_cch_positions}" ]]; then
  echo "DRIFT: CCH_POSITIONS"
  echo "  upstream: [${upstream_cch_positions}]"
  echo "  local:    [${local_cch_positions}]"
  drift=1
fi

if [[ "${upstream_cc_version}" != "${local_cc_version}" ]]; then
  echo "DRIFT: CLAUDE_CODE_VERSION"
  echo "  upstream: ${upstream_cc_version}"
  echo "  local:    ${local_cc_version}"
  drift=1
fi

if [[ "${upstream_cc_entrypoint}" != "${local_cc_entrypoint}" ]]; then
  echo "DRIFT: CLAUDE_CODE_ENTRYPOINT"
  echo "  upstream: ${upstream_cc_entrypoint}"
  echo "  local:    ${local_cc_entrypoint}"
  drift=1
fi

if [[ "${drift}" -eq 0 ]]; then
  echo "OK: ${LOCAL_CLOAKING_FILE} + ${LOCAL_CCH_FILE} are in sync with upstream (${UPSTREAM_RAW_URL})"
  exit 0
fi

echo ""
echo "Update ${LOCAL_CLOAKING_FILE} / ${LOCAL_CCH_FILE} to match upstream, then commit."
echo "Upstream source: ${UPSTREAM_RAW_URL}"
exit 1

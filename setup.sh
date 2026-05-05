#!/usr/bin/env bash
# setup.sh — one-command installer for the Send to Claude extension.
#
# What it does:
#   1. Verifies Python 3 is available.
#   2. Verifies the Claude workspace is set up (KB2948102). Bails if not.
#   3. Auto-detects the unpacked extension ID by scanning Chrome's profile
#      Preferences files. Falls back to interactive prompt.
#   4. Installs pdfplumber via pip (--user, no sudo).
#   5. Writes the native messaging host manifest into Chrome's (and
#      Chromium / Edge if present) NativeMessagingHosts dir, with the
#      absolute host path and the extension ID substituted in.
#   6. Smoke-tests the host with a ping.
#
# What it deliberately does NOT do:
#   - Touch ~/my-claude-workspace/ in any way.
#   - Run as root.
#   - Modify Chrome settings.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_BIN="$REPO_DIR/host/send_to_claude_host.py"
HOST_NAME="com.servicenow.send_to_claude"
HOST_MANIFEST_TEMPLATE="$REPO_DIR/host/${HOST_NAME}.json"

WORKSPACE_DEFAULT="$HOME/my-claude-workspace"
WORKSPACE_CONFIG="$WORKSPACE_DEFAULT/.claude/config.json"
KB_REF="KB2948102"

# Coloured output if the terminal supports it.
if [[ -t 1 ]]; then
    GREEN="\033[32m"; RED="\033[31m"; YELLOW="\033[33m"; DIM="\033[2m"; RESET="\033[0m"
else
    GREEN=""; RED=""; YELLOW=""; DIM=""; RESET=""
fi

ok()   { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
fail() { printf "  ${RED}✗${RESET} %s\n" "$1" >&2; }
note() { printf "  ${YELLOW}!${RESET} %s\n" "$1"; }

printf "Send to Claude — Setup\n"
printf "======================\n\n"

# --- 1. Python 3 ----------------------------------------------------------
printf "Checking prerequisites...\n"
if ! command -v python3 >/dev/null 2>&1; then
    fail "Python 3 not found."
    cat >&2 <<EOF
    Install Python 3:
      macOS:  brew install python  (or download from https://python.org/downloads)
      Linux:  sudo apt install python3 python3-pip   (Debian/Ubuntu)
              sudo dnf install python3 python3-pip   (Fedora/RHEL)
    Then re-run ./setup.sh.
EOF
    exit 1
fi
PY_VER="$(python3 --version 2>&1 | awk '{print $2}')"
ok "Python 3 found ($PY_VER)"

# --- 2. Workspace prerequisite -------------------------------------------
if [[ ! -f "$WORKSPACE_CONFIG" ]]; then
    fail "Claude workspace not found at $WORKSPACE_DEFAULT"
    cat >&2 <<EOF

    Set up your Claude workspace first: $KB_REF

    Then re-run ./setup.sh.
EOF
    exit 1
fi
ok "Workspace found at $WORKSPACE_DEFAULT"

if ! python3 -c "import json,sys; json.load(open('$WORKSPACE_CONFIG'))" 2>/dev/null; then
    fail "Workspace config is unparseable: $WORKSPACE_CONFIG"
    cat >&2 <<EOF
    Check JSON syntax, or re-run $KB_REF setup to restore it.
EOF
    exit 1
fi
ok "Workspace config valid"

# --- 3. Bundled parser ----------------------------------------------------
if [[ ! -f "$REPO_DIR/host/parser.py" ]]; then
    fail "Bundled parser missing at host/parser.py"
    cat >&2 <<EOF
    The repo is incomplete. Re-clone or download a fresh copy.
EOF
    exit 1
fi
ok "Bundled parser at host/parser.py"

# --- 4. Detect extension ID ----------------------------------------------
printf "\nDetecting extension ID...\n"

case "$(uname -s)" in
    Darwin) CHROME_DATA="$HOME/Library/Application Support/Google/Chrome" ;;
    Linux)  CHROME_DATA="$HOME/.config/google-chrome" ;;
    *)      CHROME_DATA="" ;;
esac

EXT_ID=""
if [[ -n "$CHROME_DATA" && -d "$CHROME_DATA" ]]; then
    EXT_ID="$(python3 - "$CHROME_DATA" "$REPO_DIR" <<'PYEOF'
import json, os, sys, glob
chrome_data, repo_dir = sys.argv[1], sys.argv[2]
repo_real = os.path.realpath(repo_dir)
candidates = (
    glob.glob(os.path.join(chrome_data, "*/Preferences")) +
    glob.glob(os.path.join(chrome_data, "*/Secure Preferences"))
)
for prefs in candidates:
    try:
        with open(prefs, "r", encoding="utf-8") as f:
            j = json.load(f)
    except Exception:
        continue
    settings = ((j.get("extensions") or {}).get("settings") or {})
    for ext_id, ext in settings.items():
        path = ext.get("path") or ""
        if not path:
            continue
        try:
            real = os.path.realpath(path)
        except Exception:
            continue
        if real == repo_real:
            print(ext_id)
            sys.exit(0)
sys.exit(0)
PYEOF
)"
fi

if [[ -z "$EXT_ID" ]]; then
    note "Could not auto-detect extension ID."
    cat <<EOF

    Find your extension ID:
      1. Open chrome://extensions/
      2. Enable "Developer mode" (top right)
      3. Find "Send to Claude" — the ID is the 32-char string under the name

EOF
    read -rp "  Paste extension ID: " EXT_ID
    EXT_ID="$(printf '%s' "$EXT_ID" | tr -d '[:space:]')"
fi

if [[ ! "$EXT_ID" =~ ^[a-p]{32}$ ]]; then
    fail "'$EXT_ID' doesn't look like a valid Chrome extension ID (32 letters a-p)."
    exit 1
fi
ok "Extension ID: $EXT_ID"

# --- 5. Python deps ------------------------------------------------------
printf "\nInstalling Python dependencies...\n"
if python3 -c "import pdfplumber" 2>/dev/null; then
    ok "pdfplumber already installed"
else
    if python3 -m pip install --user pdfplumber >/tmp/send_to_claude_pip.log 2>&1; then
        ok "pdfplumber installed"
    else
        fail "pip install pdfplumber failed. See /tmp/send_to_claude_pip.log"
        printf "    Run manually: %spython3 -m pip install --user pdfplumber%s\n" "$DIM" "$RESET"
        exit 1
    fi
fi

# --- 6. Install native messaging manifest --------------------------------
printf "\nInstalling native messaging manifest...\n"

chmod +x "$HOST_BIN"

case "$(uname -s)" in
    Darwin)
        CHROME_NMH="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
        CHROMIUM_NMH="$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
        EDGE_NMH="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
        ;;
    Linux)
        CHROME_NMH="$HOME/.config/google-chrome/NativeMessagingHosts"
        CHROMIUM_NMH="$HOME/.config/chromium/NativeMessagingHosts"
        EDGE_NMH="$HOME/.config/microsoft-edge/NativeMessagingHosts"
        ;;
    *)
        fail "Unsupported OS: $(uname -s). Manual install required."
        exit 1
        ;;
esac

write_manifest() {
    local target_dir="$1"
    local manifest_path="$target_dir/${HOST_NAME}.json"
    mkdir -p "$target_dir"
    python3 - "$HOST_MANIFEST_TEMPLATE" "$HOST_BIN" "$EXT_ID" "$manifest_path" <<'PYEOF'
import json, sys
src, host_bin, ext_id, dst = sys.argv[1:]
with open(src, "r", encoding="utf-8") as f:
    j = json.load(f)
j["path"] = host_bin
j["allowed_origins"] = [f"chrome-extension://{ext_id}/"]
with open(dst, "w", encoding="utf-8") as f:
    json.dump(j, f, indent=2)
PYEOF
    ok "Wrote $manifest_path"
}

# Always write for Chrome. Write for Chromium / Edge only if their data dirs exist.
write_manifest "$CHROME_NMH"
[[ -d "$(dirname "$CHROMIUM_NMH")" ]] && write_manifest "$CHROMIUM_NMH" || true
[[ -d "$(dirname "$EDGE_NMH")" ]]     && write_manifest "$EDGE_NMH"     || true

# --- 7. Smoke test -------------------------------------------------------
printf "\nSmoke test...\n"

PING_RESULT="$(python3 - "$HOST_BIN" <<'PYEOF'
import json, struct, subprocess, sys
host_bin = sys.argv[1]
msg = json.dumps({"op": "ping"}).encode("utf-8")
frame = struct.pack("<I", len(msg)) + msg
try:
    proc = subprocess.run(
        ["python3", host_bin],
        input=frame,
        capture_output=True,
        timeout=15,
    )
except Exception as e:
    print(f"ERROR: {e}")
    sys.exit(1)
out = proc.stdout
if len(out) < 4:
    err = proc.stderr.decode(errors="replace")[:400]
    print(f"ERROR: empty/short response. stderr={err}")
    sys.exit(1)
n = struct.unpack("<I", out[:4])[0]
body = out[4:4+n].decode("utf-8")
print(body)
PYEOF
)"

if printf '%s' "$PING_RESULT" | python3 -c "import json,sys
try:
    r = json.loads(sys.stdin.read())
except Exception:
    sys.exit(1)
sys.exit(0 if r.get('ok') else 1)" 2>/dev/null; then
    ok "Host responded to ping"
else
    fail "Host smoke test failed:"
    printf "    %s\n" "$PING_RESULT" >&2
    exit 1
fi

printf "\n${GREEN}Setup complete.${RESET} Reload the extension in chrome://extensions/ to activate.\n"

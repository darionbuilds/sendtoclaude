#!/usr/bin/env bash
# uninstall.sh — removes the Send to Claude native messaging manifest.
# Does NOT touch the Claude workspace or pip packages.

set -euo pipefail

HOST_NAME="com.servicenow.send_to_claude"

if [[ -t 1 ]]; then
    GREEN="\033[32m"; YELLOW="\033[33m"; RESET="\033[0m"
else
    GREEN=""; YELLOW=""; RESET=""
fi

case "$(uname -s)" in
    Darwin)
        TARGETS=(
            "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
            "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
            "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
        )
        ;;
    Linux)
        TARGETS=(
            "$HOME/.config/google-chrome/NativeMessagingHosts"
            "$HOME/.config/chromium/NativeMessagingHosts"
            "$HOME/.config/microsoft-edge/NativeMessagingHosts"
        )
        ;;
    *)
        printf "Unsupported OS: %s. Manual cleanup required.\n" "$(uname -s)" >&2
        exit 1
        ;;
esac

removed=0
for tgt in "${TARGETS[@]}"; do
    f="$tgt/${HOST_NAME}.json"
    if [[ -f "$f" ]]; then
        rm -f "$f"
        printf "  ${GREEN}✓${RESET} Removed %s\n" "$f"
        removed=$((removed + 1))
    fi
done

if [[ "$removed" -eq 0 ]]; then
    printf "  ${YELLOW}!${RESET} Nothing to remove (no installed manifests found).\n"
fi

printf "\nDone. Workspace and pip packages were not touched.\n"

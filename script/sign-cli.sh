#!/usr/bin/env bash
#
# Sign a CLI binary with Azure Trusted Signing, for use as the export:local
# --sign hook (the command receives the binary path as its only argument).
# Delegates to script/sign-windows.ps1, which performs the actual signing.
#
# No-op safety: when Azure Trusted Signing is not configured or pwsh is
# unavailable, this leaves the binary unsigned and exits 0, so exports stay
# usable without any signing setup.
set -euo pipefail

binary="${1:?usage: sign-cli.sh <binary>}"

if [ -z "${AZURE_TRUSTED_SIGNING_ENDPOINT:-}" ] ||
  [ -z "${AZURE_TRUSTED_SIGNING_ACCOUNT_NAME:-}" ] ||
  [ -z "${AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE:-}" ]; then
  echo "sign-cli: Azure Trusted Signing is not configured; leaving unsigned"
  exit 0
fi

if ! command -v pwsh >/dev/null 2>&1; then
  echo "sign-cli: pwsh is not available; leaving unsigned"
  exit 0
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pwsh -NoProfile -File "$script_dir/sign-windows.ps1" "$binary"

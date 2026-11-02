#!/bin/sh
# Rebuild the self-hosted @bsv/sdk browser bundle that gift.js imports (vendor/bsv-sdk-<version>.min.js).
# Gift pots hold a spending key in the page, so the SDK is served from our own origin, never from a CDN.
# Only the names in EXPORTS are bundled (about 270 KB instead of 840 KB); keep it in step with gift.js's import.
#
# To update: bump "@bsv/sdk" in package.json, run `pnpm install` (pnpm checks the lockfile integrity hash),
# run this script, point the import at the top of gift.js at the new file, delete the old file, and test a
# gift end to end (make, claim, reclaim) before shipping.
set -eu
cd "$(dirname "$0")/.."
EXPORTS="PrivateKey, PublicKey, P2PKH, Transaction, SatoshisPerKilobyte, Random, Utils"
V=$(node -p "require('./node_modules/@bsv/sdk/package.json').version")
OUT="vendor/bsv-sdk-$V.min.js"
echo "export { $EXPORTS } from './node_modules/@bsv/sdk/dist/esm/mod.js'" | pnpm dlx esbuild@0.25.10 \
  --bundle --format=esm --platform=browser --target=es2022 --minify --legal-comments=none \
  --banner:js="/* @bsv/sdk $V ($EXPORTS) from npm (pnpm-lock integrity checked), built by scripts/vendor-bsv-sdk.sh. Do not edit. */" \
  --outfile="$OUT"
echo "$OUT"

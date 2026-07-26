#!/usr/bin/env bash
# setup-test-env.sh - make the screeps mockup runnable in a sandbox/fresh clone.
#
# WHY THIS EXISTS (measured, 2026-07-26 session): `npm install` builds two
# native modules and one webpack bundle via install scripts. In sandboxes the
# isolated-vm native build often FAILS under parallel make (missing .deps dir
# race), which rolls back the whole install. The workaround - `npm install
# --ignore-scripts` - then skips THREE build artifacts, and the third one is
# the invisible trap:
#
#   1. node_modules/isolated-vm/out/isolated_vm.node      (native, node-gyp)
#   2. node_modules/@screeps/driver/native/build/Release/native.node
#   3. node_modules/@screeps/driver/build/runtime.bundle.js   (webpack)
#
# Without #3 every mockup bot dies at script load ("Cannot find module
# '../../build/runtime.bundle.js'") and screeps-server-mockup's console parser
# DROPS the error field of the console event - so the failure is INVISIBLE:
# the server ticks, cells run, and every bot just "does nothing". If grid or
# integration runs show bots producing ZERO console output and every economy
# assertion timing out, it is this, not the bot.
#
# Idempotent: checks each artifact and builds only what's missing.
# Run from the repo root:  bash scripts/setup-test-env.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
GYP="$ROOT/node_modules/.bin/node-gyp"

if [ ! -d node_modules ] || [ ! -x "$GYP" ]; then
  echo "[setup-test-env] node_modules missing/incomplete - installing (scripts skipped; we build below)"
  npm install --ignore-scripts --no-audit --no-fund
fi

# 1. isolated-vm native module (the user-script VM).
if ! node -e "require('isolated-vm')" >/dev/null 2>&1; then
  echo "[setup-test-env] building isolated-vm (single-threaded - parallel make races)"
  (cd node_modules/isolated-vm && rm -rf build out && "$GYP" configure >/dev/null && "$GYP" build -j 1)
  node -e "require('isolated-vm')"
  echo "[setup-test-env] isolated-vm OK"
else
  echo "[setup-test-env] isolated-vm OK (cached)"
fi

# 2. @screeps/driver native addon (pathfinder).
if [ ! -f node_modules/@screeps/driver/native/build/Release/native.node ]; then
  echo "[setup-test-env] building @screeps/driver native addon"
  (cd node_modules/@screeps/driver/native && rm -rf build && "$GYP" configure >/dev/null && "$GYP" build -j 1)
  echo "[setup-test-env] driver native OK"
else
  echo "[setup-test-env] driver native OK (cached)"
fi

# 3. @screeps/driver runtime bundle (the in-VM game runtime). THE INVISIBLE ONE.
if [ ! -f node_modules/@screeps/driver/build/runtime.bundle.js ]; then
  echo "[setup-test-env] building @screeps/driver runtime bundle (webpack)"
  (cd node_modules/@screeps/driver && npx webpack >/dev/null)
  [ -f node_modules/@screeps/driver/build/runtime.bundle.js ]
  echo "[setup-test-env] runtime bundle OK"
else
  echo "[setup-test-env] runtime bundle OK (cached)"
fi

echo "[setup-test-env] environment ready - grid/integration runs will execute bot scripts."
echo "[setup-test-env] smoke-check any time with: node scripts/probe-mockup.js"

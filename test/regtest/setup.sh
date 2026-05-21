#!/bin/bash
set -euo pipefail

# Resolve script directory so the compose override path is robust to invocation cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OVERRIDE_FILE="$SCRIPT_DIR/docker-compose.override.yml"

# Fulmine pin — keep in sync with docker-compose.override.yml.
# Source of truth: ArkLabsHQ/fulmine PR #411 HEAD.
FULMINE_COMMIT="01c72a5b7e00b6b149c7cea995cea002b45835d2"
FULMINE_PR_REF="refs/pull/411/head"

echo "=== Golem Regtest Setup ==="

# 1. Clone/update Introspector (includes PR #63 for recursive covenant, PR #72 for non-interactive HTLC test).
if [ ! -d /tmp/introspector ]; then
  echo "Cloning Introspector..."
  git clone --depth 1 https://github.com/ArkLabsHQ/introspector.git /tmp/introspector
else
  echo "Updating Introspector..."
  (cd /tmp/introspector && git pull)
fi

# 1b. Clone/update Fulmine and check out PR #411 commit.
# Required for the covenant-receive-e2e test (NonInteractiveClaim VHTLC sender).
if [ ! -d /tmp/fulmine ]; then
  echo "Cloning Fulmine..."
  git clone https://github.com/ArkLabsHQ/fulmine.git /tmp/fulmine
fi
echo "Fetching Fulmine PR #411 ($FULMINE_COMMIT)..."
(cd /tmp/fulmine && \
  git fetch origin "$FULMINE_PR_REF:pr-411" 2>/dev/null || true && \
  git checkout "$FULMINE_COMMIT")

# 2. Clean slate.
echo "Stopping existing services..."
docker compose -f /tmp/introspector/docker-compose.regtest.yml -f "$OVERRIDE_FILE" down 2>/dev/null || true
nigiri stop 2>/dev/null || true

# 3. Start nigiri (Bitcoin regtest + esplora). NO --ark — Introspector compose has its own arkd.
echo "Starting nigiri..."
nigiri start --ci

echo "Waiting for Bitcoin RPC..."
for i in $(seq 1 15); do
  nigiri rpc getblockcount >/dev/null 2>&1 && break
  sleep 2
done

# 4. Start full stack (Introspector + arkd + nbxplorer + postgres + Fulmine + bancod).
# First run builds Fulmine (~5-10 min) and Introspector (~2-5 min). Subsequent runs are fast.
echo "Starting full stack (Introspector + Fulmine + bancod)..."
docker compose -f /tmp/introspector/docker-compose.regtest.yml -f "$OVERRIDE_FILE" up -d

# 4a. Initialize arkd wallet (required on fresh tmpfs volumes).
echo "Waiting for arkd admin API..."
status=""
for i in $(seq 1 30); do
  status=$(curl -sf http://localhost:7071/v1/admin/wallet/status 2>/dev/null) && break
  sleep 2
done

if echo "$status" | grep -q '"initialized":false'; then
  echo "Initializing arkd wallet..."
  curl -sf -X POST -H "Content-Type: application/json" \
    http://localhost:7071/v1/admin/wallet/create \
    -d '{"seed":"abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about","password":"test1234"}'
  curl -sf -X POST -H "Content-Type: application/json" \
    http://localhost:7071/v1/admin/wallet/unlock \
    -d '{"password":"test1234"}'
elif echo "$status" | grep -q '"unlocked":false'; then
  echo "Unlocking arkd wallet..."
  curl -sf -X POST -H "Content-Type: application/json" \
    http://localhost:7071/v1/admin/wallet/unlock \
    -d '{"password":"test1234"}'
fi

echo "Waiting for arkd..."
for i in $(seq 1 30); do
  curl -sf http://localhost:7070/v1/info >/dev/null 2>&1 && break
  sleep 3
done

echo "Waiting for Introspector..."
for i in $(seq 1 10); do
  curl -sf http://localhost:7073/v1/info >/dev/null 2>&1 && break
  sleep 2
done

# 4b. Wait for Fulmine WalletService to be reachable, then bootstrap the wallet.
# Fulmine starts with no wallet; we need to GenSeed + CreateWallet + Unlock before
# Service.GetInfo / CreateVHTLC will succeed. Pattern matches /tmp/fulmine/scripts/setup.
echo "Waiting for Fulmine WalletService..."
for i in $(seq 1 60); do
  grpcurl -plaintext localhost:7000 fulmine.v1.WalletService.GenSeed >/dev/null 2>&1 && break
  sleep 2
done

# Bootstrap wallet (idempotent across re-runs — CreateWallet on already-initialized
# wallet returns an error we ignore; Unlock either succeeds or returns "already unlocked").
SEED=$(grpcurl -plaintext localhost:7000 fulmine.v1.WalletService.GenSeed 2>/dev/null | jq -r .hex)
if [ -n "$SEED" ] && [ "$SEED" != "null" ]; then
  echo "Bootstrapping Fulmine wallet..."
  grpcurl -plaintext \
    -d "{\"private_key\":\"$SEED\",\"password\":\"password\",\"server_url\":\"http://arkd:7070\"}" \
    localhost:7000 fulmine.v1.WalletService.CreateWallet >/dev/null 2>&1 || true
  sleep 1
  grpcurl -plaintext -d '{"password":"password"}' \
    localhost:7000 fulmine.v1.WalletService.Unlock >/dev/null 2>&1 || true
fi

# Wait for Service.GetInfo to confirm the wallet is loaded.
echo "Waiting for Fulmine Service.GetInfo..."
for i in $(seq 1 30); do
  grpcurl -plaintext localhost:7000 fulmine.v1.Service.GetInfo 2>&1 | grep -q '"network"' && break
  sleep 2
done

# 4c. Confirm bancod is running. Bancod is a Fulmine peer dependency, not used by
# Golem's self-solver path. We just check the container is up and ready in its logs.
echo "Waiting for bancod..."
for i in $(seq 1 30); do
  docker logs bancod 2>&1 | grep -q 'bancod started' && break
  sleep 2
done

# 5. Verify.
echo ""
echo "=== Service Status ==="
echo "Bitcoin:      $(nigiri rpc getblockcount 2>/dev/null || echo 'FAILED')"
echo "Esplora:      $(curl -sf http://localhost:3000/api/blocks/tip/height 2>/dev/null || echo 'FAILED')"
echo "arkd:         $(curl -sf http://localhost:7070/v1/info 2>/dev/null | jq -r '.network' 2>/dev/null || echo 'FAILED')"
echo "Introspector: $(curl -sf http://localhost:7073/v1/info 2>/dev/null | jq -r '.version' 2>/dev/null || echo 'FAILED')"
echo "Fulmine:      $(grpcurl -plaintext localhost:7000 fulmine.v1.Service.GetInfo 2>/dev/null | jq -r '.network' 2>/dev/null || echo 'FAILED')"
echo "bancod:       $(docker logs bancod 2>&1 | grep -q 'bancod started' && echo 'OK' || echo 'FAILED')"
echo ""
echo "=== Ready for tests ==="
echo "  npx tsx test/regtest/covenant-claim.ts"
echo "  npx tsx test/regtest/covenant-lifecycle.ts"
echo "  npx tsx test/regtest/covenant-receive-e2e.ts"

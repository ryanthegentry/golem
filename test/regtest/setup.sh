#!/bin/bash
set -euo pipefail

echo "=== Golem Regtest Setup ==="

# 1. Clone/update Introspector (includes PR #63 for recursive covenant)
if [ ! -d /tmp/introspector ]; then
  echo "Cloning Introspector..."
  git clone --depth 1 https://github.com/ArkLabsHQ/introspector.git /tmp/introspector
else
  echo "Updating Introspector..."
  cd /tmp/introspector && git pull
fi

# 2. Clean slate
echo "Stopping existing services..."
docker compose -f /tmp/introspector/docker-compose.regtest.yml down 2>/dev/null || true
nigiri stop 2>/dev/null || true

# 3. Start nigiri (Bitcoin regtest + esplora). NO --ark — Introspector compose has its own arkd.
echo "Starting nigiri..."
nigiri start --ci

echo "Waiting for Bitcoin RPC..."
for i in $(seq 1 15); do
  nigiri rpc getblockcount >/dev/null 2>&1 && break
  sleep 2
done

# 4. Start Introspector stack (arkd + introspector + wallet + nbxplorer + postgres)
# First run builds from source (~2-5 min). Subsequent runs are fast.
echo "Starting Introspector stack..."
# Create override to ensure nbxplorer is healthy before arkd-wallet starts.
# Without this, arkd-wallet misses nbxplorer's Ready event (race condition in v0.9.0).
cat > /tmp/introspector/docker-compose.override.yml << 'OVERRIDE'
services:
  nbxplorer:
    healthcheck:
      test: ["CMD-SHELL", "test -f /datadir/btc_fully_synched"]
      interval: 3s
      timeout: 2s
      retries: 60
      start_period: 10s
  arkd-wallet:
    depends_on:
      nbxplorer:
        condition: service_healthy
OVERRIDE

docker compose -f /tmp/introspector/docker-compose.regtest.yml \
  -f /tmp/introspector/docker-compose.override.yml up -d

# 4a. Initialize arkd wallet (required on fresh tmpfs volumes).
# Wait for arkd admin API to be available.
echo "Waiting for arkd admin API..."
for i in $(seq 1 30); do
  status=$(curl -sf http://localhost:7071/v1/admin/wallet/status 2>/dev/null) && break
  sleep 2
done

# Create and unlock wallet if not initialized
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

# 5. Verify
echo ""
echo "=== Service Status ==="
echo "Bitcoin:      $(nigiri rpc getblockcount 2>/dev/null || echo 'FAILED')"
echo "Esplora:      $(curl -sf http://localhost:3000/api/blocks/tip/height 2>/dev/null || echo 'FAILED')"
echo "arkd:         $(curl -sf http://localhost:7070/v1/info 2>/dev/null | jq -r '.network' 2>/dev/null || echo 'FAILED')"
echo "Introspector: $(curl -sf http://localhost:7073/v1/info 2>/dev/null | jq -r '.version' 2>/dev/null || echo 'FAILED')"
echo ""
echo "=== Ready for tests ==="
echo "  npx tsx test/regtest/covenant-claim.ts"
echo "  npx tsx test/regtest/covenant-lifecycle.ts"
echo "  npx tsx test/regtest/covenant-pipeline.ts"

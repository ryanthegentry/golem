#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OVERRIDE_FILE="$SCRIPT_DIR/docker-compose.override.yml"

echo "=== Golem Regtest Teardown ==="
docker compose -f /tmp/introspector/docker-compose.regtest.yml -f "$OVERRIDE_FILE" down 2>/dev/null || \
  docker compose -f /tmp/introspector/docker-compose.regtest.yml down 2>/dev/null || true
nigiri stop 2>/dev/null || true
echo "Done."

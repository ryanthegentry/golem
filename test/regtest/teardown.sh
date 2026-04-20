#!/bin/bash
echo "=== Golem Regtest Teardown ==="
docker compose -f /tmp/introspector/docker-compose.regtest.yml \
  -f /tmp/introspector/docker-compose.override.yml down 2>/dev/null || \
  docker compose -f /tmp/introspector/docker-compose.regtest.yml down 2>/dev/null || true
nigiri stop 2>/dev/null || true
echo "Done."

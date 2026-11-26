# Stage 1: Build TypeScript frontend & export shared/gameplay-config.json
FROM node:22-slim AS web-builder
WORKDIR /app

COPY package.json package-lock.json tsconfig*.json ./
RUN npm ci --include=dev

COPY src ./src
COPY public ./public
COPY scripts/export-gameplay-config.mjs ./scripts/export-gameplay-config.mjs
RUN npm run build

# Stage 2: Build Rust backend with cached Cargo dependencies
FROM rust:1-slim-bookworm AS rust-builder
WORKDIR /app/server-rs

COPY server-rs/Cargo.toml server-rs/Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release --locked && \
    rm -rf src target/release/baron-pit-server* target/release/deps/baron_pit_server* target/release/.fingerprint/baron-pit-server*

COPY server-rs/src ./src
RUN touch src/main.rs && cargo build --release --locked && \
    grep -qa 'server_started' target/release/baron-pit-server

# Stage 3: Minimal production runtime (no Node.js or Rust toolchain)
FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN mkdir -p /app/data && chmod 777 /app/data

COPY --from=rust-builder /app/server-rs/target/release/baron-pit-server /app/baron-pit-server
COPY --from=web-builder /app/public /app/public
COPY --from=web-builder /app/shared/gameplay-config.json /app/shared/gameplay-config.json
COPY --from=web-builder /app/node_modules/three/build /app/node_modules/three/build
COPY --from=web-builder /app/node_modules/three/examples/jsm /app/node_modules/three/examples/jsm

RUN chmod 755 /app/baron-pit-server && \
    ldd /app/baron-pit-server && \
    ! ldd /app/baron-pit-server | grep -q "not found"

# Build-time smoke test inside the exact runtime image: proves the binary boots,
# stays alive, serves /healthz + /, logs server_started to stdout with empty stderr,
# and exits cleanly on SIGTERM.
RUN set -eu; \
    PORT=10000 /app/baron-pit-server >/tmp/smoke.out 2>/tmp/smoke.err & \
    PID=$!; \
    cleanup() { kill "$PID" 2>/dev/null || true; rm -f /tmp/smoke.out /tmp/smoke.err /app/data/rooms-snapshot.json /app/data/rooms-snapshot.json.tmp; }; \
    trap cleanup EXIT; \
    i=0; \
    while [ "$i" -lt 25 ]; do \
      if ! kill -0 "$PID" 2>/dev/null; then \
        echo "=== SERVER EXITED EARLY ==="; \
        cat /tmp/smoke.out /tmp/smoke.err; \
        exit 1; \
      fi; \
      if curl -fsS -H "Connection: close" http://127.0.0.1:10000/healthz >/dev/null 2>&1; then \
        break; \
      fi; \
      sleep 0.2; \
      i=$((i + 1)); \
    done; \
    if ! curl -fsS -H "Connection: close" http://127.0.0.1:10000/healthz; then \
      echo "=== HEALTHZ FAILED ==="; \
      cat /tmp/smoke.out /tmp/smoke.err; \
      exit 1; \
    fi; \
    echo ""; \
    curl -fsS -H "Connection: close" -o /dev/null http://127.0.0.1:10000/; \
    curl -fsS -H "Connection: close" -o /dev/null http://127.0.0.1:10000/three/build/three.module.js; \
    if ! grep -q "server_started" /tmp/smoke.out; then \
      echo "=== MISSING server_started ==="; \
      cat /tmp/smoke.out /tmp/smoke.err; \
      exit 1; \
    fi; \
    if [ -s /tmp/smoke.err ]; then \
      echo "=== UNEXPECTED STDERR ==="; \
      cat /tmp/smoke.err; \
      exit 1; \
    fi; \
    kill -TERM "$PID"; \
    wait "$PID"

ENV PORT=10000
EXPOSE 10000

CMD ["/app/baron-pit-server"]

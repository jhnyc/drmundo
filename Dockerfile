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
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release && \
    rm -rf src target/release/baron-pit-server* target/release/deps/baron_pit_server*

COPY server-rs/src ./src
RUN cargo build --release

# Stage 3: Minimal production runtime (no Node.js or Rust toolchain)
FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN mkdir -p /app/data

COPY --from=rust-builder /app/server-rs/target/release/baron-pit-server /app/baron-pit-server
COPY --from=web-builder /app/public /app/public
COPY --from=web-builder /app/shared/gameplay-config.json /app/shared/gameplay-config.json
COPY --from=web-builder /app/node_modules/three/build /app/node_modules/three/build
COPY --from=web-builder /app/node_modules/three/examples/jsm /app/node_modules/three/examples/jsm

ENV PORT=10000
EXPOSE 10000

CMD ["/app/baron-pit-server"]

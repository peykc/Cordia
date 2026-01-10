# Build stage - use slim image
FROM rust:1.75-slim as builder

# Install minimal build dependencies
RUN apt-get update && apt-get install -y \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy everything
COPY Cargo.toml ./
COPY src ./src

# Build for release
RUN cargo build --release

# Runtime stage
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    ca-certificates \
    gosu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the binary from builder
COPY --from=builder /app/target/release/signaling-server /app/signaling-server

# Copy entrypoint script
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Expose WebSocket port
EXPOSE 9001

# Set environment variables
ENV RUST_LOG=info
ENV PUID=1000
ENV PGID=1000

# Use entrypoint script
ENTRYPOINT ["/app/entrypoint.sh"]

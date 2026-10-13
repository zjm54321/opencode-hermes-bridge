# Required: oven/bun:1.4.2@sha256:<independently verified 64-hex digest>.
# No default, no existing dist, no floating-tag fallback.
ARG BUN_IMAGE
FROM ${BUN_IMAGE} AS build
ARG BUN_IMAGE
ARG SOURCE_REVISION
WORKDIR /build
RUN bun -e 'if (!/^oven\/bun:1\.4\.2@sha256:[a-f0-9]{64}$/.test(process.env.BUN_IMAGE ?? "") || !/^[a-f0-9]{40}$/.test(process.env.SOURCE_REVISION ?? "")) process.exit(1)' \
    && test "$(bun --version)" = "1.4.2"
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY src ./src
COPY mcp ./mcp
RUN bun build mcp/index.ts --target=bun --outdir=/image-app
COPY deploy/private-tunnel/volume-init.mjs deploy/private-tunnel/probe.mjs /image-app/

FROM ${BUN_IMAGE} AS runtime
ARG SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/zjm54321/opencode-hermes-bridge" \
      org.opencontainers.image.revision="${SOURCE_REVISION}"
WORKDIR /app
COPY --from=build --chown=10000:10000 /image-app/ /app/
ENV HOME=/tmp TMPDIR=/tmp
USER 10000:10000
ENTRYPOINT ["bun", "/app/index.js"]

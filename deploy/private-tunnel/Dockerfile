# Required: oven/bun:1.4.2@sha256:<independently verified 64-hex digest>.
# No default, no existing dist, no floating-tag fallback.
ARG BUN_IMAGE
FROM ${BUN_IMAGE} AS build
ARG BUN_IMAGE
WORKDIR /build
RUN bun -e 'if (!/^oven\/bun:1\.4\.2@sha256:[a-f0-9]{64}$/.test(process.env.BUN_IMAGE ?? "")) process.exit(1)' \
    && test "$(bun --version)" = "1.4.2"
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY src ./src
COPY mcp ./mcp
RUN bun build mcp/index.ts --target=bun --outdir=/image-app
COPY deploy/private-tunnel/volume-init.mjs deploy/private-tunnel/probe.mjs /image-app/
COPY LICENSE /image-app/LICENSE

FROM ${BUN_IMAGE} AS runtime
WORKDIR /app
COPY --from=build --chown=10000:10000 /image-app/ /app/
ENV HOME=/tmp TMPDIR=/tmp
USER 10000:10000
ENTRYPOINT ["bun", "/app/index.js"]

# Cross-language HTTP integration tests

Run from the project root:

```sh
nix develop --command bun run test:integration
```

These tests use the real TypeScript `Bridge`, native fetch, and Python production
HTTP/service/SQLite boundaries. The test-only `companion/tests/http_fixture.py`
injects **EchoRunner**, not Hermes or a real model. Prompt delivery is collected at
the V2-shaped callback boundary: this is **not** evidence of real Hermes attachment
understanding or automatic delivery/rendering in a running OpenCode host UI.

Three bounded scenarios cover byte-preserving PNG/text/PDF/ZIP transfer and private
output hashes, data URLs and explicit upload roots, local acceptance before HTTP,
outbox restart with an unrecorded acknowledgement, repeated-ID 202 versus conflict
409, session isolation, sanitized 401, and recovery after executor failure.
Read-only SQLite job/history queries plus unchanged artifact mtimes provide basic
evidence that repeated submissions did not rerun the executor. They do not prove
exactly-once prompt delivery; the documented queue/persist crash window remains.

Every invocation creates an isolated directory under `/tmp/opencode`, a random
token only in the owned child environment, and an ephemeral loopback port.
Readiness and polling are bounded. Cleanup disposes clients, sends SIGINT with
SIGTERM/SIGKILL fallback only to its own child, and removes only its own temporary
directory. No real model credentials, host configuration, or debug endpoint is used.
Fixture bytes are generated using the Python standard library (1×1 PNG with CRCs,
UTF-8 text, a PDF with correct xref offsets, and a ZIP with a verified member).

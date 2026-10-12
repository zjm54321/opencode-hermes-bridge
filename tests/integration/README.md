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

Three bounded scenarios cover:
1. Input rejection of ordinary files (TXT/PDF/ZIP rejected before HTTP submission), byte-preserving PNG transfer across three input shapes (data URLs, explicit upload roots, and raw base64) with private output hashes (0600 file / 0700 dir), local acceptance before HTTP, outbox restart with an unrecorded acknowledgement (preventing POST replay via postAttempted), server idempotency via manual duplicate POST (202 without rerun) versus conflict 409, session isolation, and verification that bridge conversation history remains empty.
2. Sanitized HTTP 401 authentication rejection: creates no server job, halts automatic retry, and notifies the session once.
3. Sanitized worker execution failure: error is delivered, while a subsequent request on the same thread succeeds cleanly with empty legacy history.

Read-only SQLite job/history queries plus unchanged artifact mtimes provide basic
evidence that manual duplicate submissions did not rerun the executor. They do not prove
exactly-once prompt delivery; the documented queue/persist crash window remains.

Every invocation creates an isolated directory under `/tmp/opencode`, a random
token only in the owned child environment, and an ephemeral loopback port.
Readiness and polling are bounded. Cleanup disposes clients, sends SIGINT with
SIGTERM/SIGKILL fallback only to its own child, and removes only its own temporary
directory. No real model credentials, host configuration, or debug endpoint is used.
Fixture bytes are generated using the Python standard library (1×1 PNG with CRCs,
UTF-8 text, a PDF with correct xref offsets, and a ZIP with a verified member).

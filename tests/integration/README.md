# Bounded cross-language checks

```sh
nix develop --offline --no-update-lock-file --command bun test tests/unit
nix develop --offline --no-update-lock-file --command bun run test:integration
```

Two integration flows use native fetch and production Python HTTP/service/SQLite:

1. **HTTP admission and recovery:** unauthorized POST creates no job; authorized
   PNG + PDF snapshots survive source mutation and a lost real 202. An identical
   UUID returns 202, conflicting content returns 409. Restart recovers by GET only;
   original bytes become a session-bound, cached `Tool.Result` without chat history.
   This uses the test-only EchoRunner, not a model.
2. **Native file workflow:** PNG + original ZIP travel through the real
   `GatewayRunner`; the actual `hermes_file_plugin` downloads and publishes the ZIP
   over production asset HTTP. Only the native Gateway/runtime/model is fake.
   Evidence checks multimodal PNG input, one native submission, unchanged ZIP
   bytes, private local files, and result reads after restart without resubmission
   or redownload. It does not claim that a real model understood either file.

Seven unit scenarios cover SDK registration/permissions and formal results;
durable intent/unknown outcomes/scope-bound GET recovery; unbound legacy outboxes;
bounded waits/cancellation; local upload boundaries; raw transfer integrity and
non-overwriting private output; representative configuration/wire limits. Legacy
scope and cancellation remain separate to make these safety failures identifiable.
MIME/status/input-shape matrices and repeated echo/failure/restart cases were
removed rather than hidden under fewer test names. File transfer and restart
recovery remain supported product paths.

The shared harness is also used by MCP tests and is unchanged. Fixtures bind an
ephemeral loopback port, use generated test credentials and files under
`/tmp/opencode`, and clean up only their own child processes/directories. No remote
model, private credential, running host UI, or deployment is exercised. SQLite
rows and cached file timestamps are evidence of these tested transitions, not an
exactly-once guarantee across arbitrary server crashes.

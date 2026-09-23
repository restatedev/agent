# MCP configuration and credentials

MCP is configured by the operator on the core process through
`MCP_SERVERS_JSON`. Unset configuration means no MCP servers. The optional UI
can enable or disable configured connectors for an agent; it cannot add servers
or accept credential values.

```sh
export MCP_SERVERS_JSON='[
  {"id":"public-docs","type":"http","url":"https://docs.example.com/mcp","protocol":"stateless"},
  {"id":"workspace","type":"http","url":"https://workspace.example.com/mcp","protocol":"stateful","tokenEnv":"WORKSPACE_MCP_TOKEN"}
]'
export WORKSPACE_MCP_TOKEN=your-server-token
```

These example URLs are placeholders. Choose `stateless` for handshake-free
2026-07-28 servers or `stateful` for supported 2025-era Streamable HTTP servers.
There is no automatic protocol downgrade. A server can use a pre-issued bearer
token; endpoints that require interactive OAuth are outside this example.

## Recorded configuration

`session/mcp-config.ts` validates a strict array of at most 32 servers with
unique IDs, HTTP(S) URLs without embedded username/password, and optional
environment-variable references. A `tokenEnv` must be an uppercase name ending
in `_MCP_TOKEN`, so a typo or copied entry cannot forward an unrelated process
secret such as `OPENAI_API_KEY` to an MCP endpoint.

Do not put secrets in endpoint URLs, including query strings. The URL and the
`tokenEnv` name are not secret: they are recorded in every turn snapshot and
returned to UI clients by `Agent.toolCatalog`.
Malformed configuration produces a generic error without echoing the input.
A turn cannot start while the configuration is malformed. If that happens when
a finished turn would start its queued successor, the finished outcome is still
recorded and the queued input stays pending; it opens the next turn that starts
after the configuration is fixed.

At turn start the configuration is read inside a durable effect. Its **reference
metadata**, not token values, is part of the turn snapshot. Effective tool grants
are also snapshotted. Configured connectors default to enabled; explicit agent
selections and `mcpDefault: "disabled"` narrow access. Children freeze their
inherited grants and do not automatically acquire future connectors.

## HTTP boundary

Inside discovery and tool HTTP effects, `resolveMcpToken`:

1. Checks that the current operator configuration still contains the same
   server ID, URL, protocol and credential reference as the turn snapshot.
2. Resolves the referenced environment variable, if present.
3. Supplies the value to the MCP transport only.

A missing credential fails before sending an anonymous request. A changed or
removed connector fails with a safe configuration error; start a new turn to
use the changed metadata. Rotating the value under the same environment name
is permitted. Process caches are partitioned by a token fingerprint so rotated
tokens do not share authenticated catalog/session entries.

Successful recorded HTTP results replay without another HTTP request. If an
unfinished effect has to execute again, it uses the environment at execution
time. Authentication failures become tool observations; they do not suspend
for login or retry indefinitely. Discovery, which is a read, retries other
failures up to three times with a short backoff inside its effect, then marks
the server unavailable for that turn with a sanitized warning. Stateful connections are released at turn end
and discarded after failed calls.

## What may be recorded

Credentials must not enter handler arguments, state, signals, model context,
run names or returned credential values. Provider exceptions are sanitized
inside the HTTP effect **before** its result is journaled, including exceptions
that echo request headers. Tests inspect the serialized journal for synthetic
token leakage and verify no new HTTP request on replay.

Actual MCP catalog and tool response payloads are recorded and may reach model
context. This is not a general-purpose payload redactor: a remote server that
returns secret content can put that content in the result. Configure trusted
servers and treat their descriptions/results as untrusted model input.

The application secrets package was removed because there is no longer stored
OAuth state, refresh token, PKCE material, browser cookie or access proof to
encrypt. Restate and the process environment remain inside the local operator's
trust boundary.

## Tool execution

Discovery snapshots the tool schema and remote name used for invocation.
Model names are namespaced by server; name normalization has deterministic
collision handling. Tool search loads permitted schemas on demand. PTC uses
the same permitted dispatcher and guardrail evaluation as direct calls.

Calls carry an `Idempotency-Key` based on `turnId:toolCallId`. MCP does not
standardize deduplication; a crash between remote completion and recording the
result can repeat a side effect. The HTTP effect disables eager automatic
retries. See [tools](tools.md#mcp-tools) for result projection.

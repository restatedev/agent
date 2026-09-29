# Configuration

What the agent is — its models and context window, base instructions and
built-in tools — is set in code, in `packages/libs/core/src/agent-config.ts`. Each tool is one
module in `src/tools/`, written with `defineAgentTool` from `src/tools-api.ts`;
adding one is a new module and a line in that config. A tool carries its own
prompt guidance (`instructions`), which reaches the model only in turns where
the tool is offered. See [tools](tools.md#built-in-tools).

## Environment

The agent service reads these environment variables:

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` | The API key of each provider the configured models use; see below |
| `MCP_SERVERS_JSON` | MCP servers the agents may use; see below |
| `SANDBOX_PROVIDER` | `local` (default) or `modal`, which also needs `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` |
| `MODAL_APP_NAME`, `MODAL_SANDBOX_NAMESPACE`, `MODAL_SANDBOX_IMAGE`, `MODAL_SANDBOX_TIMEOUT_MS` | Optional Modal settings; see [sandboxes](sandboxes.md) |
| `AGENT_MODEL_MAX_OUTPUT_TOKENS` | Output budget per model call, 1024–64000 (default 32000) |
| `RESTATE_ADMIN_URL`, `RESTATE_ADMIN_TOKEN` | Admin API used to discover dynamic tools |

## Models

`agentConfig.models` names three models, as `provider:model`: the agent
model, the guardrail model and the compactor. The provider is `openai`,
`anthropic` or `google`, and the three may differ:

```ts
models: {
  agent: "anthropic:claude-sonnet-5",
  guardrail: "openai:gpt-5.6-terra",
  compactor: "google:gemini-3.8-flash",
},
```

Only the providers in use need an API key. Every call asks for low reasoning,
and each provider maps that to its own setting. When the agent model changes,
set `context.windowTokens` to its context window.

A turn keeps the model it started with, because its working messages carry
that provider's reasoning and tool-call data. Running turns finish on the
version they started on, so a change applies to new turns. Switching between
turns is safe: the transcript is provider-neutral, and each turn rebuilds its
model messages from it.

To add another provider, add it to `PROVIDERS` in `src/model/provider.ts`.

## MCP servers

MCP servers are configured by the operator on the agent service, not by
agents or clients. Clients can only switch configured servers on or off per
agent.

```sh
export MCP_SERVERS_JSON='[{"id":"example","type":"http","url":"https://mcp.example.com/mcp","protocol":"stateful","tokenEnv":"EXAMPLE_MCP_TOKEN"}]'
export EXAMPLE_MCP_TOKEN=your-server-token
```

- `protocol` is `stateless` for 2026-07-28 servers or `stateful` for
  2025-era Streamable HTTP servers.
- `tokenEnv` names the environment variable holding a bearer token and must
  end in `_MCP_TOKEN`. Omit it for public servers.
- The token is read only inside the HTTP call. It never enters handler
  inputs, state or the journal. The URL and variable name are not secret.
- Tool results are recorded and shown to the model, so only configure
  servers you trust.

[MCP configuration](mcp-configuration.md) covers rotation and failures.

## Reference UI

`packages/apps/web`, see [`env.example`](../packages/apps/web/env.example):

| Variable | Purpose |
| --- | --- |
| `RESTATE_INGRESS_URL` | Restate ingress for the UI server (default `http://localhost:8080`) |
| `RESTATE_AUTH_TOKEN` | Bearer token for an authenticated ingress |
| `APP_PUBLIC_URL` | Browser origin when the UI sits behind a proxy; its host becomes the only accepted Host |
| `APP_ALLOWED_HOSTS` | Comma-separated extra Host values to accept, for proxies that rewrite Host |

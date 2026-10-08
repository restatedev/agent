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
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY` | The API key of each provider the configured models use; see [models](#models) |
| `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY` | The server for `openai-compatible` models, and its key if it needs one |
| `MCP_SERVERS_JSON` | MCP servers the agents may use; see below |
| `SANDBOX_PROVIDER` | `local` (default) or `modal`, which also needs `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` |
| `MODAL_APP_NAME`, `MODAL_SANDBOX_NAMESPACE`, `MODAL_SANDBOX_IMAGE`, `MODAL_SANDBOX_TIMEOUT_MS` | Optional Modal settings; see [sandboxes](sandboxes.md) |
| `AGENT_MODEL`, `GUARDRAIL_MODEL`, `COMPACTOR_MODEL` | Override the agent, guardrail and compactor models, as `provider:model`; see [models](#models) |
| `AGENT_MODEL_MAX_OUTPUT_TOKENS` | Output budget per model call, 1024–64000 (default 32000) |
| `RESTATE_ADMIN_URL`, `RESTATE_ADMIN_TOKEN` | Admin API used to discover dynamic tools |
| `CALLBACK_BASE_URL` | Restate ingress as callers of `createCallback` URLs reach it (default `http://localhost:8080`) |

## Models

`agentConfig.models` names three models, as `provider:model`: the agent
model, the guardrail model and the compactor. The three may use different
providers:

| Provider | Models from | Needs |
| --- | --- | --- |
| `openai` | OpenAI | `OPENAI_API_KEY` |
| `anthropic` | Anthropic | `ANTHROPIC_API_KEY` |
| `google` | Google Gemini | `GOOGLE_GENERATIVE_AI_API_KEY` |
| `xai` | xAI Grok | `XAI_API_KEY` |
| `deepseek` | DeepSeek | `DEEPSEEK_API_KEY` |
| `openai-compatible` | Any server with the OpenAI chat completions API | `OPENAI_COMPATIBLE_BASE_URL`, and `OPENAI_COMPATIBLE_API_KEY` if the server needs one |

```ts
models: {
  agent: "anthropic:claude-sonnet-5",
  guardrail: "openai:gpt-5.6-terra",
  compactor: "google:gemini-3.8-flash",
},
```

Each can also be set from the environment without editing the code:
`AGENT_MODEL`, `GUARDRAIL_MODEL` and `COMPACTOR_MODEL` override the agent,
guardrail and compactor models, and an unset or empty variable keeps the
default from `agent-config.ts`. The service reads them at startup.

```sh
export AGENT_MODEL=anthropic:claude-sonnet-5
export COMPACTOR_MODEL=google:gemini-3.8-flash
```

Only the providers in use need an API key. Every call asks for low reasoning,
and each provider maps that to its own setting. When the agent model changes,
set `context.windowTokens` to its context window.

`openai-compatible` runs open models: on your own hardware with Ollama, vLLM
or LM Studio, or hosted by a router such as OpenRouter or Together.
Everything after the first colon is the server's model name, so Ollama's
`qwen3:32b` is `openai-compatible:qwen3:32b`:

```sh
export OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1   # Ollama
```

The server must support tool calls and JSON-schema structured output, which
the guardrails use. Small open models follow the tool protocol less reliably
than frontier ones, so try the agent with the model before relying on it.

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

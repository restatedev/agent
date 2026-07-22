// Restate admission, retry, and cancellation boundary for full agent model
// calls. Provider-specific inference remains in model.ts.

import {createHash} from "node:crypto";
import {Opts, SendOpts, TerminalError} from "@restatedev/restate-sdk";
import {
  type Future,
  handlerRequest,
  InterruptedError,
  invocation,
  type Operation,
  run,
  scope,
  service,
  signal,
} from "@restatedev/restate-sdk-gen";
import type {ModelMessage} from "ai";
import {
  AGENT_MODEL,
  completeAgent,
  type ModelResult,
  type ModelStreamChunk,
  streamAgent,
  type ToolManifest,
} from "./model.js";

type ModelRequest = {
  messages: ModelMessage[];
  tools: ToolManifest[];
};

type StreamingModelRequest = ModelRequest & {
  sourceInvocationId: string;
  signalName: string;
};

export type SourceNext<T> =
  | {type: "next"; value: T}
  | {type: "done"}
  | {type: "aborted"};

export type ModelSource = {
  next(): Operation<SourceNext<ModelStreamChunk>>;
};

const MODEL_SCOPE = "openai";
const MODEL_STREAM = "model-stream";

// The main model call is a service so Restate can apply scope-based concurrency
// control before the expensive provider request starts.
export const ModelGateway = service({
  name: "ModelGateway",
  handlers: {
    *complete({messages, tools}: ModelRequest): Operation<ModelResult> {
      return yield* run(({signal}) => completeAgent(messages, tools, signal), {
        name: "agent-model",
        retry: {
          maxAttempts: 4,
          initialInterval: 500,
          maxInterval: 5_000,
          exponentiationFactor: 2,
        },
      });
    },

    *completeStreaming({
      messages,
      tools,
      sourceInvocationId,
      signalName,
    }: StreamingModelRequest): Operation<void> {
      const source = yield* durableSource((signal) =>
        streamAgent(messages, tools, signal),
      );

      try {
        while (true) {
          const next = yield* source.next();
          invocation(sourceInvocationId)
            .signal<SourceNext<ModelStreamChunk>>(signalName)
            .resolve(next);
          if (next.type !== "next") {
            return;
          }
        }
      } catch (error) {
        invocation(sourceInvocationId)
          .signal<SourceNext<ModelStreamChunk>>(signalName)
          .reject(
            error instanceof TerminalError
              ? error
              : error instanceof Error
                ? error.message
                : String(error),
          );
        throw error;
      }
    },
  },
  options: {
    handlers: {
      complete: {ingressPrivate: true},
      completeStreaming: {ingressPrivate: true},
    },
  },
});

function agentLimitKey(agentId: string): string {
  const agent = createHash("sha256").update(agentId).digest("hex").slice(0, 24);
  return `${AGENT_MODEL}/${agent}`;
}

// Only the agent loop goes through the scoped gateway. The `openai` scope is
// the provider-wide budget; the two limit-key levels are model and agent.
export function* callModel(
  agentId: string,
  messages: ModelMessage[],
  tools: ToolManifest[],
): Operation<ModelResult> {
  const call = scope(MODEL_SCOPE)
    .client(ModelGateway)
    .complete(
      {messages, tools},
      Opts.from({limitKey: agentLimitKey(agentId), name: "agent-model"}),
    );
  const invocation = yield* call.invocation;
  try {
    return yield* call;
  } catch (error) {
    if (error instanceof InterruptedError) {
      invocation.cancel();
    }
    throw error;
  }
}

// Start a scoped streaming model invocation and expose its signal queue as a
// pull-based source. This is intentionally not wired into the agent loop yet.
export function* callModelStreaming(
  agentId: string,
  messages: ModelMessage[],
  tools: ToolManifest[],
): Operation<ModelSource> {
  yield* scope(MODEL_SCOPE)
    .sendClient(ModelGateway)
    .completeStreaming(
      {
        messages,
        tools,
        sourceInvocationId: handlerRequest().id,
        signalName: MODEL_STREAM,
      },
      SendOpts.from({
        limitKey: agentLimitKey(agentId),
        name: "agent-model-stream",
      }),
    );

  return {
    next: () => signal<SourceNext<ModelStreamChunk>>(MODEL_STREAM),
  };
}

// Wrap a process-local, non-resumable stream. Every pull is journaled. During
// replay the recorded prefix is returned, then the first unrecorded pull says
// `aborted` because the original provider stream no longer exists.
function* durableSource<T>(
  source: (signal: AbortSignal) => AsyncGenerator<T>,
): Operation<{next(): Future<SourceNext<T>>}> {
  const controller = new AbortController();
  let stream: AsyncGenerator<T> | undefined;

  async function create(): Promise<void> {
    stream = source(controller.signal);
  }

  async function next({signal}: {signal: AbortSignal}): Promise<SourceNext<T>> {
    if (!stream) {
      return {type: "aborted"};
    }
    if (signal.aborted) {
      controller.abort();
    }
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, {once: true});
    try {
      const result = await stream.next();
      return result.done ? {type: "done"} : {type: "next", value: result.value};
    } catch (error) {
      throw new TerminalError(`model stream failed: ${String(error)}`);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  yield* run(create, {name: "model-stream-create"});
  return {
    next: () => run(next, {name: "model-stream-next"}),
  };
}

import {runHandler} from "./harness.mjs";

// Real generator handlers, isolated state and recorded RPCs; no live services.
export function context(
  key,
  initial = {},
  call = () => {
    throw new Error("Unexpected blocking RPC");
  },
) {
  const state = new Map(Object.entries(structuredClone(initial)));
  const sends = [],
    calls = [],
    signals = [],
    cancelled = [];
  let real, sequence;
  const ctx = {
    key,
    request: () => ({
      id: "inv-test",
      attemptCompletedSignal: new AbortController().signal,
    }),
    get: (name) =>
      real.run(`get-${sequence++}`, () =>
        structuredClone(state.get(name) ?? null),
      ),
    set: (name, value) => state.set(name, structuredClone(value)),
    clear: (name) => state.delete(name),
    genericSend: (opts) => {
      sends.push(opts);
      return {
        invocationId: real.run(
          `send-${sequence++}`,
          () => `send-${sends.length}`,
        ),
      };
    },
    genericCall: (opts) => {
      calls.push(opts);
      return Object.assign(
        real.run(`call-${sequence++}`, () => call(opts)),
        {
          invocationId: real.run(
            `call-id-${sequence++}`,
            () => `call-${calls.length}`,
          ),
        },
      );
    },
    invocation: (id) => ({
      signal: (name) => ({resolve: (value) => signals.push({id, name, value})}),
    }),
    cancel: (id) => cancelled.push(id),
    resolveAwakeable: (id, value) => signals.push({id, value}),
    run: (name, action) => real.run(name, action),
    // Awakeables never complete and timers fire at once, so a wait always
    // ends at its timeout.
    awakeable: () => real.awakeable(),
    sleep: (_duration, name) =>
      real.run(name ?? `sleep-${sequence++}`, () => null),
    date: {now: () => real.run(`date-${sequence++}`, () => 1700000000000)},
  };
  async function invoke(handler, input) {
    const {output} = await runHandler(async (actual) => {
      real = actual;
      sequence = 0;
      try {
        return {result: (await handler(ctx, input)) ?? null};
      } catch (error) {
        return {error: error.message};
      }
    });
    if (output.error) throw new Error(output.error);
    return output.result;
  }
  return {invoke, state, sends, calls, signals, cancelled};
}

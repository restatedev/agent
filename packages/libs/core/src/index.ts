// Public API: the generic durable-streaming helper. The core is deliberately
// source-agnostic — it wraps *any* non-replayable stream (an LLM completion, a
// queue, a sensor feed) so each value pulled is journaled. The example supplies
// its own stream (see the example's model.ts).
export type {DurableSource, Next} from "./durable_source";
export {durableSource} from "./durable_source";

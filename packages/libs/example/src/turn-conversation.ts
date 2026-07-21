// Turn is the per-turn detailed conversation: a VirtualObject keyed by the
// turn's invocation id. As a turn runs, it appends each streamed chunk and each
// tool call/result here — the "inside the run" detail — kept entirely separate
// from the Agent's general conversation. Query `history` with a turn id to
// replay exactly what one turn did.

import {
  type Operation,
  object,
  schemas,
  sharedState,
  state,
} from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {type Message, MessageSchema, type TurnState} from "./types";

export const Turn = object({
  name: "Turn",
  handlers: {
    // Append one detailed message to this turn's conversation.
    append: schemas(
      {input: MessageSchema, output: z.void()},
      function* (entry): Operation<void> {
        const history = (yield* state<TurnState>().get("history")) ?? [];
        history.push(entry);
        state<TurnState>().set("history", history);
      },
    ),

    // Read this turn's detailed conversation.
    history: schemas(
      {input: z.void(), output: z.array(MessageSchema)},
      function* (): Operation<Message[]> {
        return (yield* sharedState<TurnState>().get("history")) ?? [];
      },
    ),
  },
  options: {
    handlers: {
      history: {shared: true},
    },
  },
});

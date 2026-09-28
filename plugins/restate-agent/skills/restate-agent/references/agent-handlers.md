# Agent handlers, transcript events and the UI

Background: `docs/architecture.md` (state owners) and `docs/protocol.md`
(every handler and its wire shape).

## Where state lives

| Object | Key | Owns |
| --- | --- | --- |
| `Agent` | `agentId` | Active turn, queued input, profile (instructions, guardrails, tool grants), memories, approvals, schedules, children, notification watermarks |
| `AgentSession` | `agentId` | Canonical transcript, conversation summary, sandbox ref; runs `doTurn` |

Only exclusive handlers write state. A turn in `AgentSession` changes
`Agent` state only by calling an `Agent` handler.

## Feed the agent from outside

Before adding a handler, check the existing entry points:

- `ask`, `steer`, `interrupt` for a person in the conversation.
- `deliver({source, sourceId?, message, whenBusy, coalesce?})` for an
  external producer (a webhook, a queue consumer, another service). It
  routes with an explicit busy policy (`queue`, `steer`, `interrupt`), and
  `coalesce` drops a duplicate while the same source is queued or active.
- `createSchedule` for durable timers that deliver a message later.

## Add an Agent handler

1. **Contract.** Add it to `AgentDefinition` in
   `packages/libs/types/src/services.ts`, with Zod schemas from
   `packages/libs/types/src/index.ts`:

   ```ts
   archive: iface.schemas({input: ArchiveRequestSchema, output: z.boolean()}),
   ```

2. **Implementation.** Put it in the module that owns the concern
   (`agent/*.ts`), typed with `AgentHandlers`, and state its precondition
   with a guard from `agent/guards.ts`:

   ```ts
   export const handlers: AgentHandlers<"archive"> = {
     *archive({reason}) {
       yield* requireDirectAccess(); // live, top-level agent
       ...
       yield* notifications.publish("profile"); // wake watching clients
       return true;
     },
   };
   ```

   | Caller | Guard |
   | --- | --- |
   | A client (UI, ingress) | `requireDirectAccess()` |
   | A tool in the active turn | take `turnId`; `requireTurnTool(turnId, "toolName", denied)` or `activeTurn.accepting(turnId)` |
   | Anything, read-only | none; make it shared |

3. **Options.** Register it in `agent/service.ts`: spread the module's
   `handlers`, and give it retention plus `shared(...)` for a reader or
   `internal(...)` (`ingressPrivate`) for a callback only the turn, other
   agents or the Agent itself may call.

4. **Client.** For an external handler, add a method to `AgentClient` in
   `packages/libs/client/src/index.ts`, wrapped in `invoke(...)` so HTTP
   errors become `AgentClientError`.

5. **UI.** The browser reaches Restate only through the Next.js proxy. Add
   the operation to `MUTATIONS` (POST, body validated by its schema) or
   `READS` (GET) in `packages/apps/web/src/server/operations.ts`; the
   browser client derives its types from those tables.

6. **Docs and tests.** Add the handler to `docs/protocol.md`, and add a
   protocol test (`test/protocol.test.mjs`).

Deadlock rule: an exclusive handler must never wait on a call that comes
back to an exclusive handler of the same key. That is why `Agent` starts
`doTurn` with a one-way send (`agent/active-turn.ts`) and the turn can then
call `Agent` freely, and why long waits run in shared handlers (`watch`).

## Add a transcript event

1. Add the variant to `ConversationEventSchema` in
   `packages/libs/types/src/index.ts`.
2. Decide explicitly whether the model sees it: add the type to the switch
   in `isDerivedConversationEvent` (`src/internal-types.ts`). Derived
   events are client status only; the others are projected into model
   context.
3. For a model-visible event, project it in `session/context.ts` and
   handle it in `model/compactor.ts`.
4. Render it in the web transcript (`packages/apps/web/src/transcript-entries.ts`).

Never rewrite an existing entry to explain later routing; append a new
event.

## Notifications

Clients do not poll data. They watch `Agent.watch({afterRevision})` and
re-read whatever topic changed (`history`, `profile`, `approvals`,
`schedules`). A module that writes a topic publishes it with
`notifications.publish(topic)`. Notifications carry no data. A new topic is
a new key in `AgentNotificationTopicSchema` and in the snapshot versions.

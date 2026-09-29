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

- `ask`, `steer` and `interrupt`, for a person in the conversation.
- `deliver`, for an external producer such as a webhook, a queue consumer
  or another service. Its input is
  `{source, sourceId?, message, whenBusy, interruptReason?, coalesce?}`.
  - `whenBusy` is the busy policy: `queue`, `steer` or `interrupt`.
  - `coalesce` skips the delivery while one with the same `source` and
    `sourceId` is queued or part of the active turn. Without a `sourceId`,
    nothing is skipped.
- `createSchedule`, for durable timers that deliver a message later.

`references/agent-controller.md` has the full routing table.

## Add an Agent handler

1. **Contract.** Add it to `AgentDefinition` in
   `packages/libs/types/src/services.ts`, with Zod schemas from
   `packages/libs/types/src/index.ts`:

   ```ts
   archive: iface.schemas({input: ArchiveRequestSchema, output: z.boolean()}),
   ```

2. **Implementation.** Put it in the module that owns the concern
   (`agent/*.ts`), typed with `AgentHandlers`. State its precondition with a
   guard from `agent/guards.ts`:

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

   `references/agent-controller.md#choose-handler-mode-and-access` says
   which guard fits which caller.

3. **Options.** Register it in `agent/service.ts`. Spread the module's
   `handlers`, and give the handler:
   - a retention policy from `retention.ts`;
   - `shared(...)` for a reader, or `internal(...)` (`ingressPrivate`) for
     a callback that only the turn, other agents or the Agent itself may
     call.

4. **Client.** For an external handler, add a method to the `AgentClient`
   interface in `packages/libs/client/src/index.ts`, and implement it in
   `createAgentClient`, wrapped in `invoke(...)` so HTTP errors become
   `AgentClientError`.

5. **UI.** The browser reaches Restate only through the Next.js proxy route
   `packages/apps/web/app/api/agent/[agentId]/[operation]/route.ts`, which
   `packages/apps/web/src/server/request-guard.ts` protects. Add the operation to `MUTATIONS`
   (POST, body validated by its schema) or `READS` (GET) in
   `packages/apps/web/src/server/operations.ts`. The browser client derives
   its types from those tables.

6. **Docs and tests.** Add the handler to `docs/protocol.md`. Test it in
   `test/local-agent.test.mjs`, which runs `Agent` handlers against
   in-memory state (`test/state-fixture.mjs`).

## Add a transcript event

1. Add the variant to `ConversationEventSchema` in
   `packages/libs/types/src/index.ts`.
2. Decide explicitly whether the model sees it: add the type to the switch
   in `isDerivedConversationEvent` (`internal-types.ts`). Derived events are
   client status only; the others are projected into model context.
3. For a model-visible event, add a case to the projection in
   `session/context.ts`. The compactor (`model/compactor.ts`) passes
   model-visible events through as they are.
4. Render it in the web transcript: a case in
   `packages/apps/web/src/transcript.tsx`, and an entry in `DETAIL_TYPES`
   (`transcript-entries.ts`) if it belongs inside a turn card.

Never rewrite an existing entry to explain later routing; append a new
event.

## Notifications

A module that writes a topic publishes it with
`notifications.publish(topic)`. Clients then re-read that topic.
`references/agent-controller.md#notify-clients-without-copying-state`
explains the protocol and what a new topic needs.

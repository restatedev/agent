# Building bigger applications from small handlers

Start with the smallest handler that works. Split out a new service when a
piece of work should be retried, observed, scaled, or owned independently.
Each pattern below uses only the blocks from the other references.

## Orchestrator and workers

One handler plans, fans out typed RPCs to workers, and combines the
results. Each worker is its own invocation, retried on its own. Cancelling
the orchestrator cancels the workers it is waiting on.

```ts
*generate({topic}) {
  const plan = yield* restate.client(planner).plan(topic);
  const findings = yield* restate.all(
    plan.questions.map((question) => restate.client(worker).research({question})),
  );
  return yield* restate.client(writer).write({topic, findings});
}
```

## Entity per key

Model each long-lived thing (a user, a cart, a chat session, a job) as a
virtual object keyed by its ID. One exclusive handler at a time mutates
state. Shared handlers report status. Other services talk to the entity
through `restate.client(entity, key)`.

## Saga: undo completed steps on failure

```ts
*book(trip: Trip) {
  const undo: Array<() => restate.Operation<unknown>> = [];
  try {
    const flight = yield* restate.client(flights, trip.id).reserve(trip.flight);
    undo.push(() => restate.client(flights, trip.id).cancel(flight.id));
    const hotel = yield* restate.client(hotels, trip.id).reserve(trip.hotel);
    undo.push(() => restate.client(hotels, trip.id).cancel(hotel.id));
    yield* restate.client(payments).charge({trip: trip.id, cents: trip.total});
  } catch (error) {
    if (error instanceof TerminalError) for (const step of undo.reverse()) yield* step();
    throw error;
  }
}
```

Only terminal errors trigger compensation. A transient error retries the
whole handler, and completed steps replay from the journal.

## Human in the loop

A long-running handler records a pending request in object state, then waits
on a signal or awakeable. A shared `status` handler exposes the request, and a
shared `approve` handler resolves it. The waiting handler holds no process
while it waits. Always clear the pending request in a `finally`.

## Pub/sub feed

An object keyed by topic keeps a list of subscriber awakeable IDs. `publish`
resolves each one. `subscribe` is shared, so waiting subscribers never block
publishers.

```ts
export const feed = restate.object({
  name: "Feed",
  handlers: {
    *publish(event: Event) {
      const ids = (yield* restate.state().get<string[]>("subscribers")) ?? [];
      for (const id of ids) restate.resolveAwakeable(id, event);
      restate.state().clear("subscribers");
    },
    *addSubscriber(id: string) {
      const ids = (yield* restate.state().get<string[]>("subscribers")) ?? [];
      restate.state().set("subscribers", [...ids, id]);
    },
    *subscribe() {
      const {id, promise} = restate.awakeable<Event>();
      restate.sendClient(feed, restate.handlerRequest().key!).addSubscriber(id);
      return yield* promise;
    },
  },
  options: {handlers: {subscribe: {shared: true}}},
});
```

A shared handler cannot write state, so `subscribe` registers itself with a
one-way send to the exclusive `addSubscriber`.

## Scheduled and recurring work

A handler that sends itself a delayed message keeps a durable schedule
without cron:

```ts
*tick() {
  yield* restate.run(() => pollInbox(), {name: "poll inbox"});
  restate.sendClient(poller, restate.handlerRequest().key!).tick(SendOpts.from({delay: {minutes: 5}}));
}
```

## Asynchronous job with a handle

Start work with `sendClient`, store the returned invocation ID, and give the
caller that ID. Later calls can `attach` for the result or `cancel` it.

## Anti-patterns

- A service that calls itself synchronously on the same object key, or two
  objects that call each other exclusively: this deadlocks.
- Returning before joining spawned tasks: the tasks are abandoned.
- Using state as a queue for a hot key: every call for that key is
  serialized. Split the key or use sends.
- Putting large blobs in state or journal entries: store a reference instead.

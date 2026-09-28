# Waiting durably

A suspended handler occupies no process. Restate wakes it when the thing it
waits for happens, even days later and after new versions ship.

## Timers

```ts
yield* restate.sleep({hours: 24});
yield* restate.sleep(500); // milliseconds
```

Combine a timer with `restate.select` for timeouts (see `composition.md`).

## Awakeables: wait for any external system

An awakeable is a one-shot durable callback. Hand its ID to someone else,
then wait; whoever holds the ID completes it.

```ts
*requestApproval(doc: string) {
  const {id, promise} = restate.awakeable<boolean>();
  yield* restate.run(() => notifyReviewer(doc, id), {name: "notify reviewer"});
  return yield* promise; // suspends until resolved
}
```

Complete it from another handler with
`restate.resolveAwakeable(id, true)` or
`restate.rejectAwakeable(id, "reason")`, or over HTTP with
`POST <ingress>/restate/awakeables/<id>/resolve`.

## Signals: send a value to a specific invocation

Signals are named and target an invocation ID. They fit controls such as
steer, interrupt, and approve, which a shared handler delivers to a
long-running exclusive handler.

```ts
// Inside the long-running handler:
const decision = yield* restate.signal<boolean>("approval");

// From a shared handler that knows the invocation ID:
restate.invocation(invocationId).signal("approval").resolve(true);
```

Store the running invocation's ID in state
(`restate.handlerRequest().id`) so shared handlers can find it:

```ts
*doTurn(message: string) {
  restate.state().set("active", restate.handlerRequest().id);
  try {
    // ... long-running work that listens for signals ...
  } finally {
    restate.state().clear("active");
  }
},
*interrupt(reason: string) {                 // shared handler
  const id = yield* restate.sharedState().get<string>("active");
  if (!id) return false;
  restate.invocation(id).signal("interrupt").resolve(reason);
  return true;
},
```

## Workflow promises

Inside a workflow, `restate.workflowPromise(name)` is a durable promise keyed
by the workflow ID. The `run` handler waits on it, and a shared handler
resolves it.

```ts
export const signup = restate.workflow({
  name: "Signup",
  handlers: {
    *run(email: string) {
      const secret = restate.rand().uuidv4();
      yield* restate.run(() => sendLink(email, secret), {name: "send link"});
      const clicked = yield* restate.workflowPromise<string>("link-clicked").get();
      return clicked === secret;
    },
    *click(secret: string) {
      yield* restate.workflowPromise<string>("link-clicked").resolve(secret);
    },
  },
});
```

`peek()` reads the promise without waiting. Unlike an awakeable, a workflow
promise can be resolved before anyone waits on it.

## Which one?

| Waiting for                                                 | Use                                                |
| ----------------------------------------------------------- | -------------------------------------------------- |
| Time                                                        | `restate.sleep`                                    |
| An external system that calls back with an ID               | `restate.awakeable`                                |
| A control message for a known running invocation            | `restate.signal` + `invocation(id).signal(name)`   |
| An event inside a workflow, possibly before the wait starts | `restate.workflowPromise`                          |
| Another handler's result                                    | `restate.client(...)` or `invocation(id).attach()` |

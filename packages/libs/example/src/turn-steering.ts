// Turn-scoped steering inbox. One background fiber drains the durable signal
// queue into a transient FIFO; a resettable channel announces when the FIFO
// changes from empty to non-empty.

import {
  allSettled,
  channel,
  type Future,
  gen,
  type Operation,
  signal,
  spawn,
} from "@restatedev/restate-sdk-gen";
import {type SteeringSignal, TURN_SIGNALS} from "./types.js";

export function createSteeringInbox() {
  const queue: SteeringSignal[] = [];
  let available = channel<void>();
  let stopped = false;

  const receiver = spawn(
    gen(function* () {
      while (true) {
        queue.push(yield* signal<SteeringSignal>(TURN_SIGNALS.steering));
        yield* available.send();
      }
    }),
  );

  function resetWhenEmpty(): void {
    if (queue.length === 0) {
      available = channel<void>();
    }
  }

  return {
    get empty(): boolean {
      return queue.length === 0;
    },

    get ready(): Future<void> {
      return available.receive;
    },

    pop(): SteeringSignal | undefined {
      const steering = queue.shift();
      if (steering) {
        resetWhenEmpty();
      }
      return steering;
    },

    drain(): SteeringSignal[] {
      if (queue.length === 0) {
        return [];
      }
      const steering = queue.splice(0);
      resetWhenEmpty();
      return steering;
    },

    *stop(reason: unknown): Operation<void> {
      if (stopped) {
        return;
      }
      stopped = true;
      receiver.interrupt(reason);
      yield* allSettled([receiver]);
    },
  };
}

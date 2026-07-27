// Turn-scoped steering inbox. One background fiber drains the durable signal
// queue into a transient FIFO; a resettable channel announces when the FIFO
// changes from empty to non-empty.

import {
  channel,
  type Future,
  gen,
  signal,
  spawn,
} from "@restatedev/restate-sdk-gen";
import {type SteeringSignal, TURN_SIGNALS} from "./types.js";

export function createSteeringInbox() {
  const queue: SteeringSignal[] = [];
  let notification = channel<void>();

  spawn(
    gen(function* receiveSteering() {
      while (true) {
        const steering = yield* signal<SteeringSignal>(TURN_SIGNALS.steering);
        if (queue.push(steering) === 1) {
          yield* notification.send();
        }
      }
    }),
  );

  return {
    get ready(): Future<void> {
      return notification.receive;
    },

    drain(): SteeringSignal[] {
      if (queue.length === 0) {
        return [];
      }
      const steering = queue.splice(0);
      notification = channel<void>();
      return steering;
    },
  };
}

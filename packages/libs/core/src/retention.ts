// Completed-invocation retention only; active journals and VO state are unaffected.
export const noRetention = {journalRetention: 0, idempotencyRetention: 0};

export const coordinationRetention = {
  journalRetention: 0,
  idempotencyRetention: {hours: 1},
};

export const executionRetention = {
  journalRetention: {hours: 1},
  idempotencyRetention: {hours: 1},
};

export const askRetention = {
  journalRetention: {minutes: 10},
  idempotencyRetention: {minutes: 10},
};

export const interactionRetention = {
  journalRetention: 0,
  idempotencyRetention: {minutes: 10},
};

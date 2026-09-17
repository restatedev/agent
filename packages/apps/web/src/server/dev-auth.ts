import type {UserIdentity} from "@restate-agents/types";

const IDENTITY: UserIdentity = {
  userId: "dev-user",
  issuer: "urn:restate:development",
  subject: "dev-user",
  displayName: "Development User",
  email: "developer@example.test",
};

/** Server configuration only; never accept a caller-selected identity. */
export function developmentIdentity(env = process.env): UserIdentity | null {
  if (env.AUTH_DEV_BYPASS !== "true") return null;
  if (env.NODE_ENV !== "development" && env.NODE_ENV !== "test")
    throw new Error(
      "AUTH_DEV_BYPASS is only allowed in development or test; disable it in production.",
    );
  return {...IDENTITY};
}

/** Register once per BFF process, coalescing concurrent requests and retrying failures. */
export function developmentIdentityLoader(
  register: (identity: UserIdentity) => PromiseLike<void>,
) {
  let registration: Promise<void> | undefined;
  return async () => {
    const identity = developmentIdentity();
    if (!identity) return null;
    registration ??= Promise.resolve()
      .then(() => register(identity))
      .catch((error) => {
        registration = undefined;
        throw error;
      });
    await registration;
    return identity;
  };
}

// Browser-facing request checks for the local UI proxy. Kept free of
// "server-only" and SDK imports so they can be unit-tested directly.

export class UiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "UiRequestError";
  }
}

/**
 * The origin this UI is served from. Without APP_PUBLIC_URL only a loopback
 * Host is trusted.
 *
 * Every route, reads included, must pass this check. A DNS-rebinding page
 * (attacker.example re-resolved to 127.0.0.1) is same-origin with itself, so
 * the browser lets it read responses and sends no cross-origin Origin header
 * on GET. Its Host header still names the attacker's domain, which is what
 * this rejects.
 */
export function trustedOrigin(request: Request): string {
  const expected = new URL(process.env.APP_PUBLIC_URL ?? request.url);
  // Next.js can reconstruct request.url with localhost even when the browser
  // uses 127.0.0.1. Host retains the address the browser actually requested.
  if (!process.env.APP_PUBLIC_URL) {
    expected.host = request.headers.get("host") ?? expected.host;
    // The default UI is local. Do not let an arbitrary Host header redefine
    // the trusted origin when a domain is pointed at the loopback listener.
    if (!["localhost", "127.0.0.1", "[::1]"].includes(expected.hostname))
      throw new UiRequestError(403, "Untrusted local UI host");
  }
  return expected.origin;
}

/** The UI is a local operator tool. Reject cross-origin browser writes. */
export function requireSameOrigin(request: Request) {
  if (request.headers.get("origin") !== trustedOrigin(request))
    throw new UiRequestError(403, "Cross-origin action rejected");
}

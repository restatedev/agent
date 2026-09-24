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

const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

/** Normalizes a Host header the way the browser's origin would spell it. */
function parseHost(host: string, protocol: string) {
  try {
    return new URL(`${protocol}//${host}`);
  } catch {
    throw new UiRequestError(400, "Invalid Host header");
  }
}

/**
 * The origin this UI is served from: APP_PUBLIC_URL when set, otherwise the
 * loopback address the browser used.
 *
 * Every route, reads included, must pass this check. A DNS-rebinding page
 * (attacker.example re-resolved to our address) is same-origin with itself,
 * so the browser lets it read responses and sends no cross-origin Origin
 * header on GET. Its Host header still names the attacker's domain, which is
 * what this rejects: behind a proxy the Host must be the public one (or one
 * listed in APP_ALLOWED_HOSTS, for proxies that rewrite it), locally it must
 * be a loopback name.
 */
export function trustedOrigin(request: Request): string {
  const publicUrl = process.env.APP_PUBLIC_URL;
  if (publicUrl) {
    const expected = new URL(publicUrl);
    const host = parseHost(
      request.headers.get("host") ?? "",
      expected.protocol,
    ).host;
    const allowed = (process.env.APP_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    if (host !== expected.host && !allowed.includes(host))
      throw new UiRequestError(403, "Untrusted UI host");
    return expected.origin;
  }
  // Next.js can reconstruct request.url with localhost even when the browser
  // uses 127.0.0.1. Host retains the address the browser actually requested.
  const fallback = new URL(request.url);
  const actual = parseHost(
    request.headers.get("host") ?? fallback.host,
    fallback.protocol,
  );
  if (!LOOPBACK_HOSTNAMES.includes(actual.hostname))
    throw new UiRequestError(403, "Untrusted local UI host");
  return actual.origin;
}

/** The UI is a local operator tool. Reject cross-origin browser writes. */
export function requireSameOrigin(request: Request) {
  if (request.headers.get("origin") !== trustedOrigin(request))
    throw new UiRequestError(403, "Cross-origin action rejected");
}

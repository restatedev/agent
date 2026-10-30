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

/** Extra Host values a rewriting proxy may send, from APP_ALLOWED_HOSTS. */
function allowedProxyHosts() {
  return (process.env.APP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function allowUntrustedHosts() {
  return process.env.APP_ALLOW_UNTRUSTED_HOSTS === "true";
}

function validateAllowedHost(expectedUrl: string, request: Request) {
  const expected = new URL(expectedUrl);
  const allowedHosts = [expected.host, ...allowedProxyHosts()];

  const {host} = parseHost(
    request.headers.get("host") ?? "",
    expected.protocol,
  );

  if (!allowUntrustedHosts() && !allowedHosts.includes(host)) {
    throw new UiRequestError(403, "Untrusted UI host");
  }

  return expected.origin;
}

function validateLoopback(request: Request) {
  const actual = new URL(request.url);
  // Next.js can reconstruct request.url with localhost even when the browser
  // uses 127.0.0.1. Host retains the address the browser actually requested.
  const parsed = parseHost(
    request.headers.get("host") ?? actual.host,
    actual.protocol,
  );

  if (!allowUntrustedHosts() && !LOOPBACK_HOSTNAMES.includes(parsed.hostname)) {
    throw new UiRequestError(403, "Untrusted local UI host");
  }

  return parsed.origin;
}

/**
 * The origin this UI is served from: APP_PUBLIC_URL when set, otherwise the
 * request's Host and protocol (restricted to loopback by default).
 *
 * Every route, reads included, must pass this check. A DNS-rebinding page
 * (attacker.example re-resolved to our address) is same-origin with itself,
 * so the browser lets it read responses and sends no cross-origin Origin
 * header on GET. Its Host header still names the attacker's domain, which is
 * what this rejects: behind a proxy the Host must be the public one (or one
 * listed in APP_ALLOWED_HOSTS, for proxies that rewrite it); locally it must
 * be a loopback name. APP_ALLOW_UNTRUSTED_HOSTS=true bypasses these Host
 * restrictions (disabling DNS-rebinding protection), not write Origin checks.
 */
export function trustedOrigin(request: Request): string {
  const publicUrl = process.env.APP_PUBLIC_URL;

  if (publicUrl) {
    return validateAllowedHost(publicUrl, request);
  }

  return validateLoopback(request);
}

/** The UI is a local operator tool. Reject cross-origin browser writes. */
export function requireSameOrigin(request: Request) {
  if (request.headers.get("origin") !== trustedOrigin(request)) {
    throw new UiRequestError(403, "Cross-origin action rejected");
  }
}

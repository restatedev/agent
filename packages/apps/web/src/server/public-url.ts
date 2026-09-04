import "server-only";

function firstForwardedValue(value: string | null): string | undefined {
  return value?.split(",", 1)[0]?.trim() || undefined;
}

/** Builds a URL using the public origin reported by a trusted reverse proxy. */
export function publicUrl(request: Request, pathname: string): URL {
  const requestUrl = new URL(request.url);
  const forwardedHost = firstForwardedValue(
    request.headers.get("x-forwarded-host"),
  );
  const forwardedProtocol = firstForwardedValue(
    request.headers.get("x-forwarded-proto"),
  );

  if (
    forwardedHost &&
    (forwardedProtocol === "http" || forwardedProtocol === "https")
  ) {
    try {
      return new URL(pathname, `${forwardedProtocol}://${forwardedHost}`);
    } catch {
      // Fall back to the request URL when proxy headers are malformed.
    }
  }

  return new URL(pathname, requestUrl);
}

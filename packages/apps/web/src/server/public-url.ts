import "server-only";
import {appOrigin} from "./user-auth";
/** The configured origin is authoritative, including behind a tunnel/proxy. */
export function publicUrl(_request: Request, pathname: string): URL {
  return new URL(pathname, appOrigin());
}

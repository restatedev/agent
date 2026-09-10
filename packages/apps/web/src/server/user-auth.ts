import "server-only";
import {createHash, randomBytes, timingSafeEqual} from "node:crypto";
import {openSecret, sealSecret} from "@restate-agents/secrets";
import {EncryptedSecretSchema} from "@restate-agents/types";
import {CodeChallengeMethod, OAuth2Client} from "google-auth-library";
import {cookies} from "next/headers";
import {NextResponse} from "next/server";
import {agentClient, BffError, userClient, userSessionClient} from "./restate";

const SESSION_COOKIE = "restate-session";
const LOGIN_COOKIE = "restate-login";
const SESSION_TTL = 7 * 24 * 60 * 60;
const LOGIN_TTL = 10 * 60;
const GOOGLE_HOSTED_DOMAIN = "restate.dev";
export function appOrigin(): string {
  const url = new URL(process.env.APP_PUBLIC_URL ?? "http://localhost:3000");
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw new BffError(500, "APP_PUBLIC_URL must be an origin");
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:")
    throw new BffError(500, "APP_PUBLIC_URL must use HTTPS in production");
  return url.origin;
}
function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: appOrigin().startsWith("https:"),
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function sessionKey(token: string): string {
  // Pre-restriction sessions must not bypass the verified Workspace login.
  // Bind the lookup key, not just the cookie name (which a caller can change).
  return hash(
    JSON.stringify(["google-workspace", GOOGLE_HOSTED_DOMAIN, token]),
  );
}
function google() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET)
    throw new BffError(
      503,
      "Configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable Sign in with Google",
    );
  return new OAuth2Client({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${appOrigin()}/api/auth/callback`,
  });
}
export function requireSameOrigin(request: Request): void {
  if (request.headers.get("origin") !== appOrigin())
    throw new BffError(403, "Cross-origin action rejected");
}
function same(left: string, right: string): boolean {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function tokenExchangeError(error: unknown): BffError {
  // Never return/log the SDK error: it can contain the authorization code,
  // client secret, request headers, or tokens. Only recognize fixed error codes.
  const code = (error as {response?: {data?: {error?: unknown}}} | null)
    ?.response?.data?.error;
  if (code === "invalid_client")
    return new BffError(
      503,
      "Google rejected the OAuth client (invalid_client). Check that GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET belong to the same Web application OAuth client, then restart the BFF.",
    );
  if (code === "invalid_grant")
    return new BffError(
      400,
      "Google rejected the login code (invalid_grant). It may have expired or already been used. Start a fresh login; do not refresh the callback page.",
    );
  if (code === "redirect_uri_mismatch")
    return new BffError(
      503,
      "Google rejected the callback URL (redirect_uri_mismatch). Register APP_PUBLIC_URL/api/auth/callback on the configured Google OAuth client.",
    );
  return new BffError(
    502,
    "Google token exchange failed. Check the BFF's connection to oauth2.googleapis.com and its Google OAuth client configuration, then start a fresh login.",
  );
}
export async function currentUser() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const sessionId = sessionKey(token),
    session = await userSessionClient(sessionId).read();
  return session
    ? {userId: session.userId, sessionId, client: userClient(session.userId)}
    : null;
}
export async function requireUser() {
  const user = await currentUser();
  if (!user) throw new BffError(401, "Sign in with Google to continue");
  return user;
}
export async function authorizedAgent(agentId: string) {
  const user = await requireUser();
  if (!(await user.client.ownsAgent(agentId)))
    throw new BffError(404, "Agent not found");
  return {user, client: agentClient(agentId)};
}
export async function startGoogleLogin(): Promise<NextResponse> {
  const client = google();
  const {codeVerifier, codeChallenge} =
    await client.generateCodeVerifierAsync();
  const state = randomBytes(32).toString("base64url"),
    nonce = randomBytes(32).toString("base64url");
  const flow = sealSecret(
    JSON.stringify({
      state,
      nonce,
      codeVerifier,
      expiresAt: Date.now() + LOGIN_TTL * 1000,
    }),
    ["google-login", appOrigin()],
  );
  const response = NextResponse.redirect(
    client.generateAuthUrl({
      scope: ["openid", "email", "profile"],
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      access_type: "online",
      prompt: "select_account",
      hd: GOOGLE_HOSTED_DOMAIN,
    }),
  );
  response.cookies.set(LOGIN_COOKIE, flow, cookieOptions(LOGIN_TTL));
  return response;
}
export async function finishGoogleLogin(
  request: Request,
): Promise<NextResponse> {
  const value = (await cookies()).get(LOGIN_COOKIE)?.value;
  if (!value) throw new BffError(400, "Login expired; sign in again");
  let flow: {
    state: string;
    nonce: string;
    codeVerifier: string;
    expiresAt: number;
  };
  try {
    flow = JSON.parse(
      openSecret(EncryptedSecretSchema.parse(value), [
        "google-login",
        appOrigin(),
      ]),
    );
  } catch {
    throw new BffError(
      400,
      "Cannot read the login cookie. APP_SECRET_KEY or APP_PUBLIC_URL may have changed. Start a fresh login.",
    );
  }
  const parameters = new URL(request.url).searchParams;
  if (
    flow.expiresAt <= Date.now() ||
    !same(parameters.get("state") ?? "", flow.state) ||
    parameters.has("error")
  )
    throw new BffError(400, "Login state is invalid or expired");
  const code = parameters.get("code");
  if (!code) throw new BffError(400, "Missing login code");
  const client = google();
  // Google tokens remain in BFF memory; only verified identity enters Restate.
  const {tokens} = await client
    .getToken({code, codeVerifier: flow.codeVerifier})
    .catch((error: unknown) => {
      throw tokenExchangeError(error);
    });
  if (!tokens.id_token)
    throw new BffError(400, "Google did not return an ID token");
  const ticket = await client
    .verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    })
    .catch(() => {
      throw new BffError(
        502,
        "Google ID-token verification failed. Check the BFF's access to Google's signing certificates, its system clock, and GOOGLE_CLIENT_ID, then start a fresh login.",
      );
    });
  const identity = ticket.getPayload();
  if (
    !identity?.sub ||
    !identity.email ||
    !identity.email_verified ||
    !same((identity as unknown as {nonce?: string}).nonce ?? "", flow.nonce)
  )
    throw new BffError(400, "Google identity verification failed");
  // The authorization URL's hd parameter is only a UI hint. Enforce the
  // signed claim after verifyIdToken; an email suffix is not Workspace proof.
  if (identity.hd !== GOOGLE_HOSTED_DOMAIN)
    throw new BffError(
      403,
      "Sign in with a restate.dev Google Workspace account",
    );
  const allowed = (process.env.GOOGLE_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length && !allowed.includes(identity.email.toLowerCase()))
    throw new BffError(403, "This account is not allowed to sign in");
  const issuer = "https://accounts.google.com" as const;
  const userId = hash(JSON.stringify([issuer, identity.sub]));
  try {
    await userClient(userId).register({
      userId,
      issuer,
      subject: identity.sub,
      email: identity.email,
      displayName: identity.name ?? identity.email,
    });
  } catch {
    throw new BffError(
      503,
      "Google identity verified, but saving the user in Restate failed. Check RESTATE_INGRESS_URL and the User service deployment.",
    );
  }
  const old = (await cookies()).get(SESSION_COOKIE)?.value;
  const token = randomBytes(32).toString("base64url");
  try {
    if (old && /^[A-Za-z0-9_-]{43}$/.test(old))
      await userSessionClient(sessionKey(old)).revoke();
    await userSessionClient(sessionKey(token)).create(
      userId,
      Date.now() + SESSION_TTL * 1000,
    );
  } catch {
    throw new BffError(
      503,
      "Google identity verified, but creating the browser session in Restate failed. Check RESTATE_INGRESS_URL and the UserSession service deployment.",
    );
  }
  const response = NextResponse.redirect(appOrigin());
  response.cookies.set(SESSION_COOKIE, token, cookieOptions(SESSION_TTL));
  response.cookies.set(LOGIN_COOKIE, "", cookieOptions(0));
  return response;
}
export async function logout(request: Request): Promise<NextResponse> {
  requireSameOrigin(request);
  const user = await currentUser();
  if (user) await userSessionClient(user.sessionId).revoke();
  const response = NextResponse.redirect(appOrigin(), 303);
  response.cookies.set(SESSION_COOKIE, "", cookieOptions(0));
  return response;
}

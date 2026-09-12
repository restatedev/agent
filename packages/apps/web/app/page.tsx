import {currentUser} from "../src/server/user-auth";
import {UserWorkspace} from "../src/user-workspace";
export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{agent?: string | string[]}>;
}) {
  // Server Components cannot set cookies. The first API request renews an
  // expired lease; normal page and API reads both validate fresh cookies locally.
  const user = await currentUser({renewCookie: false});
  if (!user)
    return (
      <main className="login-page">
        <section>
          <p className="eyebrow">Restate Agents</p>
          <h1>Your agents. Your tools.</h1>
          <p>
            Sign in with your restate.dev Google account to manage your agents
            and connected accounts.
          </p>
          <a className="button primary" href="/api/auth/login">
            Sign in with Google
          </a>
          <small>
            We request your name and verified email address—not access to your
            Gmail inbox.
          </small>
        </section>
      </main>
    );
  const profile = await user.client.profile();
  const requested = (await searchParams).agent;
  return (
    <UserWorkspace
      key={profile.identity.userId}
      initialUser={profile}
      initialAgentId={typeof requested === "string" ? requested : undefined}
    />
  );
}

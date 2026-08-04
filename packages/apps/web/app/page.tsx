import {App} from "../src/app";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{agent?: string | string[]}>;
}) {
  const requestedAgent = (await searchParams).agent;
  const initialAgentId =
    typeof requestedAgent === "string" && requestedAgent.trim()
      ? requestedAgent.trim()
      : "demo";

  return <App initialAgentId={initialAgentId} />;
}

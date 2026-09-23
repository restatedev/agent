import {App} from "../src/app";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{agent?: string | string[]}>;
}) {
  const requested = (await searchParams).agent;
  const agentId =
    typeof requested === "string" && requested.trim()
      ? requested.trim().slice(0, 256)
      : "demo";
  return <App key={agentId} initialAgentId={agentId} />;
}

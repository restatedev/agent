// HTTP-only adapter. The built-in tool calls this inside its journaled run.
import {TerminalError} from "@restatedev/restate-sdk";
import {z} from "zod";

const SearchResponseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z
        .url()
        .max(2_048)
        .refine((value) => {
          const url = new URL(value);
          return (
            ["http:", "https:"].includes(url.protocol) &&
            !url.username &&
            !url.password
          );
        }),
      content: z.string(),
    }),
  ),
});

export async function searchWeb(
  {query, maxResults}: {query: string; maxResults: number},
  signal: AbortSignal,
) {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Tavily-Access-Mode": "keyless",
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      search_depth: "basic",
      auto_parameters: false,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
    }),
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    // Do not forward arbitrary provider error text into the model as instructions.
    if ([429, 432, 433].includes(response.status)) {
      throw new TerminalError(
        "Tavily keyless search limit reached. Try again later; no search results were retrieved.",
      );
    }
    const message = `Tavily keyless search is unavailable (HTTP ${response.status}).`;
    if (response.status >= 500) throw new Error(message);
    throw new TerminalError(message);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new TerminalError("Tavily returned an empty response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_000_000) {
        throw new TerminalError("Tavily response exceeded the 1 MB limit.");
      }
      chunks.push(value);
    }
  } finally {
    // Cleanup must not replace a read failure (including turn cancellation).
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new TerminalError("Tavily returned invalid JSON.");
  }
  const parsed = SearchResponseSchema.safeParse(json);
  if (!parsed.success)
    throw new TerminalError("Tavily returned an invalid search response.");
  return {
    query,
    results: parsed.data.results.slice(0, maxResults).map((result) => ({
      title: result.title.slice(0, 300),
      url: result.url,
      snippet: result.content.slice(0, 1_500),
    })),
  };
}

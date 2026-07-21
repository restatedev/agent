import {LLMChunk} from "./agent_framework";

export async function* llmFetch(prompt: string): AsyncGenerator<LLMChunk> {
  yield {type: "text", content: "Let me check that. "};
  yield {type: "tool_call", name: "get_weather", args: {city: "Paris"}};
  yield {type: "text", content: "It's 22°C and sunny."};
}







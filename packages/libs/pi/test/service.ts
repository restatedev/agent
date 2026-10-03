// Test endpoint: a Pi host with a scripted faux model and a tool that kills
// the process the first time it runs (when PI_CRASH_MARKER names a file that
// does not exist yet).

import {existsSync, writeFileSync} from "node:fs";

import {Type} from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {createModels} from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import * as restate from "@restatedev/restate-sdk";

import {createPiHost} from "../src/index.js";

const crashMarker = process.env.PI_CRASH_MARKER;

const crashy = defineTool({
  name: "crashy",
  description: "Does one step of work",
  parameters: Type.Object({}),
  execute: async () => {
    if (crashMarker && !existsSync(crashMarker)) {
      writeFileSync(crashMarker, String(process.pid));
      process.exit(1);
    }
    return {content: [{type: "text", text: "crashy ran"}]};
  },
});
const Test = defineExtension({name: "test", tools: [crashy]});
const registry = createRegistry();
registry.install(Test);

// Replies by looking at the transcript, so a restarted process answers the
// same way: "use tool" asks for crashy, a tool result is acknowledged, and
// anything else is echoed.
const reply: FauxResponseFactory = (context) => {
  const last = context.messages.findLast((m) => m.role !== "system");
  if (last?.role === "toolResult") {
    const text = last.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("");
    return fauxAssistantMessage(`after tool: ${text}`);
  }
  const text =
    last?.role === "user"
      ? typeof last.content === "string"
        ? last.content
        : last.content.map((c) => (c.type === "text" ? c.text : "")).join("")
      : "";
  if (text.includes("use tool"))
    return fauxAssistantMessage(fauxToolCall("crashy", {}), {
      stopReason: "toolUse",
    });
  return fauxAssistantMessage(`echo: ${text}`);
};
const faux = fauxProvider();
faux.setResponses(Array.from({length: 10_000}, () => reply));
const models = createModels();
models.setProvider(faux.provider);

const {controller, pump} = createPiHost({
  name: "Pi",
  models,
  registry,
  agent: {model: {provider: "faux", modelId: "faux-1"}, extensions: [Test]},
  sliceMs: 2_000,
  onReport: (error) => console.error("pi report", error),
});

restate.serve({
  services: [controller, pump],
  port: Number(process.env.PORT ?? 9080),
});

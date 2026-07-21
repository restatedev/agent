// Server entrypoint: registers the example agents with Restate.
// The framework lives in `agent_framework.ts` (API) and `service.ts` (runtime);
// the agents themselves are defined in `example_agents.ts`.

import {serve} from "@restatedev/restate-sdk";
import {exampleAgents} from "./example_agents";
import {makeAgentObject} from "./service";

serve({
  services: exampleAgents.map(makeAgentObject),
});

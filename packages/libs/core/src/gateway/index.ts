/** Model gateway service and the inference contract consumed by sessions. */

export {compactConversation} from "./compactor.js";
export type {
  GuardrailApproval,
  GuardrailDecision,
  ModelResult,
  ProposedAction,
  ToolCall,
  ToolManifest,
} from "./model.js";
export {
  callContextReducer,
  callGuardrailModel,
  callModel,
  ModelGateway,
} from "./service.js";

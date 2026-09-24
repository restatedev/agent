import type {AgentProfile} from "@restate-agents/types";
import {Globe, Plus, Save, Settings2, ShieldCheck, Trash2} from "lucide-react";
import {useState} from "react";

import type {UiAgentClient} from "./agent-client";
import {AgentToolsPanel} from "./agent-tools-panel";
import type {Notify} from "./format";
import {Switch} from "./switch";
import type {SaveProfile} from "./use-agent";

type Guardrail = AgentProfile["guardrails"][number];

/** Edits a local draft of the guardrail list; nothing saves until Save. */
function GuardrailEditor({
  guardrails,
  onChange,
}: {
  guardrails: Guardrail[];
  onChange: (guardrails: Guardrail[]) => void;
}) {
  function update(index: number, patch: Partial<Guardrail>) {
    const next = guardrails.slice();
    next[index] = {...guardrails[index], ...patch};
    onChange(next);
  }

  function remove(index: number) {
    onChange(guardrails.filter((_, row) => row !== index));
  }

  function add() {
    onChange([...guardrails, {id: "", rule: ""}]);
  }

  return (
    <div className="guardrail-editor">
      {guardrails.map((guardrail, index) => (
        // The inputs are fully controlled, so position is a safe identity. The
        // ID is not: it changes as the user types, which would remount the row
        // and drop focus on every keystroke.
        // oxlint-disable-next-line react/no-array-index-key
        <div className="guardrail-row" key={index}>
          <input
            aria-label="Guardrail ID"
            className="guardrail-id"
            onChange={(event) => update(index, {id: event.target.value})}
            placeholder="id"
            value={guardrail.id}
          />
          <input
            aria-label="Guardrail policy"
            onChange={(event) => update(index, {rule: event.target.value})}
            placeholder="Natural-language policy…"
            value={guardrail.rule}
          />
          <button
            aria-label={`Remove guardrail ${guardrail.id || index + 1}`}
            className="icon-button danger"
            onClick={() => remove(index)}
            type="button"
          >
            <Trash2 />
          </button>
        </div>
      ))}
      <button className="button ghost small" onClick={add} type="button">
        <Plus /> Add guardrail
      </button>
    </div>
  );
}

/** The Context tab: tool access, web search, instructions and guardrails. */
export function ProfilePanel({
  client,
  profile,
  notify,
  saveProfile,
}: {
  client: UiAgentClient;
  profile?: AgentProfile;
  notify: Notify;
  saveProfile: SaveProfile;
}) {
  // Unedited fields follow the live profile; a draft exists only while the
  // user has unsaved changes.
  const [instructionsDraft, setInstructionsDraft] = useState<string>();
  const [guardrailsDraft, setGuardrailsDraft] = useState<Guardrail[]>();
  const [savingWebSearch, setSavingWebSearch] = useState(false);
  const instructions = instructionsDraft ?? profile?.instructions ?? "";
  const guardrails = guardrailsDraft ?? profile?.guardrails ?? [];
  const instructionsDirty = instructionsDraft !== undefined;

  async function saveWebSearch(enabled: boolean) {
    setSavingWebSearch(true);
    const state = enabled ? "enabled" : "disabled";
    await saveProfile(
      {webSearchEnabled: enabled},
      `Web search ${state} for future turns`,
    );
    setSavingWebSearch(false);
  }

  async function saveInstructions() {
    const trimmed = instructions.trim();
    const message = trimmed ? "Instructions saved" : "Instructions cleared";
    const saved = await saveProfile({instructions: trimmed || null}, message);
    if (saved) {
      setInstructionsDraft(undefined);
    }
  }

  async function saveGuardrails() {
    const next = guardrails.filter(({id, rule}) => id.trim() || rule.trim());
    if (next.some(({id, rule}) => !id.trim() || !rule.trim())) {
      notify("Every guardrail needs both an id and a policy", true);
      return;
    }
    const message = next.length
      ? `${next.length} guardrail(s) saved`
      : "Guardrails cleared";
    const saved = await saveProfile({guardrails: next}, message);
    if (saved) {
      setGuardrailsDraft(undefined);
    }
  }

  return (
    <div className="settings-sections">
      <AgentToolsPanel
        client={client}
        profile={profile}
        saveProfile={saveProfile}
        notify={notify}
      />
      <section className="settings-section">
        <div className="section-heading">
          <div>
            <Globe />
            <span>
              <strong>Web search</strong>
              <small>Tavily · free keyless access</small>
            </span>
          </div>
          <Switch
            label="Web search"
            checked={profile?.webSearchEnabled ?? true}
            describedBy="web-search-description"
            disabled={!profile || savingWebSearch}
            onChange={(enabled) => void saveWebSearch(enabled)}
          />
        </div>
        <p className="section-copy" id="web-search-description">
          Search queries are sent to Tavily. No API key needed; free access is
          rate-limited. Changes apply from the next turn.
        </p>
      </section>
      <section className="settings-section">
        <div className="section-heading">
          <div>
            <Settings2 />
            <span>
              <strong>Instructions</strong>
              <small>Agent instructions</small>
            </span>
          </div>
        </div>
        <textarea
          onChange={(event) => setInstructionsDraft(event.target.value)}
          placeholder="Prefer concise answers and metric units."
          rows={4}
          value={instructions}
        />
        <div className="inline-actions">
          <button
            className="button primary small"
            onClick={() => void saveInstructions()}
            type="button"
          >
            <Save /> Save
          </button>
          <button
            className="button ghost small"
            disabled={!instructionsDirty}
            onClick={() => setInstructionsDraft(undefined)}
            type="button"
          >
            Revert
          </button>
        </div>
      </section>

      <section className="settings-section">
        <div className="section-heading">
          <div>
            <ShieldCheck />
            <span>
              <strong>Guardrails</strong>
              <small>Runtime policy gates</small>
            </span>
          </div>
          <button
            className="button primary small"
            onClick={() => void saveGuardrails()}
            type="button"
          >
            <Save /> Save
          </button>
        </div>
        <p className="section-copy">
          Natural-language policies evaluated before tool batches or responses
          are published.
        </p>
        <GuardrailEditor
          guardrails={guardrails}
          onChange={setGuardrailsDraft}
        />
      </section>
    </div>
  );
}

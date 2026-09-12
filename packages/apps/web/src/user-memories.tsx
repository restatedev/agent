"use client";
import {Brain, Trash2} from "lucide-react";
import {useState} from "react";
import {useUser} from "./user-context";
import {userClient} from "./user-client";

export function UserMemories() {
  const {profile, refresh} = useUser();
  const [deleting, setDeleting] = useState<string>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function remove(key: string) {
    if (
      deleting ||
      !window.confirm(
        `Delete memory “${key}” for all your agents? This removes it from shared memory, not from existing conversations or turns already in progress.`,
      )
    )
      return;
    setDeleting(key);
    setError("");
    setNotice("");
    try {
      const removed = await userClient.deleteMemory(key);
      setNotice(
        removed
          ? "Memory deleted for all your agents."
          : "This memory was already deleted.",
      );
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(undefined);
    }
  }

  return (
    <main className="account-pane memories-pane">
      <p className="eyebrow">Your profile</p>
      <h1>Memories</h1>
      <p>
        Preferences, projects and useful context shared across all your agents.
        Ask any agent to remember or correct something, or delete a memory here.
      </p>
      <p className="section-copy">
        Deleting a memory stops it being included in future turns. It does not
        erase existing conversation history or change a turn already in
        progress.
      </p>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {profile.memories.length ? (
        <div className="user-memory-list" aria-label="Shared memories">
          {profile.memories.map((memory) => (
            <article className="user-memory-card" key={memory.key}>
              <div>
                <h2>{memory.key}</h2>
                <p>{memory.content}</p>
              </div>
              <button
                type="button"
                className="icon-button danger"
                aria-label={`Delete memory ${memory.key}`}
                title={`Delete memory ${memory.key}`}
                disabled={deleting !== undefined}
                onClick={() => void remove(memory.key)}
              >
                <Trash2 size={17} />
              </button>
            </article>
          ))}
        </div>
      ) : (
        <div className="memories-empty">
          <Brain size={30} />
          <h2>Nothing remembered yet</h2>
          <p>
            Ask an agent to remember a preference or something you’re working
            on.
          </p>
        </div>
      )}
    </main>
  );
}

# README video: a real session

A real recording of the reference agent, in three acts:

1. **An ordinary turn.** A casual request for a weekend plan. The model
   writes a program whose three web searches run at once and is steered
   while it works. The agent has a guardrail that makes file writes wait for
   a person, so saving `lisbon.md` asks for approval in the UI's Approvals
   panel, and the script approves it.
2. **A fleet of sub-agents.** The agent hands four cities to four
   sub-agents, which research at the same time. Each child is a whole agent,
   so the script opens each child's own page, read-only, in a 2×2 grid, then
   returns to the parent's combined answer.
3. **Kill it mid-turn.** A follow-up waits on a 30-second durable timer. The
   service is killed with `kill -9`, started again, and Restate replays the
   turn's journal, so the turn reads the file back and answers.

The script records the whole thing unattended, so it can be recorded again
when the UI or the runtime changes.

| File | Does |
| --- | --- |
| `record.mjs` | Runs the scenario: starts, kills and restarts the core service, types into the web UI, polls the turn's journal from the Admin API, and captures frames of the stage |
| `director.html` | The 1920×1080 stage: the web UI, the service terminal, the journal panel, captions and title cards |
| `cdp.mjs` | A tiny Chrome DevTools Protocol client (Node 22+, no npm packages) |
| `encode.sh` | Turns the captured frames into `out/agent-demo.mp4` |

Everything on screen comes from the running system except the titles,
captions and the highlight on the Approve button before it is clicked: the UI is streamed from its own tab, the terminal shows the
service's real log lines, and the journal panel is `sys_journal`. The quiet
stretches (model calls after the steer, the service down, the timer
running) play faster, shown by the badge in the header.

The web UI renders 800 CSS pixels wide, its one-column layout, zoomed in so
the text stays legible. To fit the frame, the script crops off the agent
picker, injects one rule that shortens the conversation pane, and slides
the view down to the Approvals panel while a decision is pending.

## Record

You need Docker (or `restate-server`), Google Chrome, ffmpeg, and an
`OPENAI_API_KEY`. Start from a fresh Restate server, so the agent ID `demo`
is new:

```sh
pnpm build
docker run -d --name video-restate --rm -p 8080:8080 -p 9070:9070 \
  -e RESTATE_EXPERIMENTAL_ENABLE_PROTOCOL_V7=true docker.restate.dev/restatedev/restate:latest

# Register the service once, then stop it: record.mjs starts it on camera.
(cd packages/libs/core && node dist/app.js) &
curl localhost:9070/deployments --json '{"uri":"http://host.docker.internal:9080"}'
kill %1

# The web UI.
(cd packages/apps/web && npx next start --hostname 127.0.0.1) &

AGENT_ID=demo node .misc/video/record.mjs      # about two minutes
.misc/video/encode.sh                          # out/agent-demo.mp4
```

With `restate-server` instead of Docker, register `http://localhost:9080`.

## Check it

Look at frames before using a take, for example one every three seconds:

```sh
ffmpeg -i .misc/video/out/agent-demo.mp4 -vf fps=1/3 /tmp/frames/%02d.png
```

Check that each ask went through at once (the prompt must not sit in the
composer), that the steer landed while the turn ran (the script stops if it
did not), that each approval showed its card before the click, that all four
sub-agent tiles filled and finished, that the
kill happened while only the timer was open, that the
journal marks only finished steps as replayed, and that the Restate UI scene
shows the 30-second `sleep` row. The model's wording differs between takes,
so read its answers too.

A take runs about two minutes. If it runs much longer, look for leftover
headless Chrome processes (`pgrep -f readme-video-chrome`): they slow the UI
down enough to delay the ask.

## Put it in the README

GitHub plays an MP4 inline only from a `user-attachments` URL: drag
`agent-demo.mp4` into the README editor on github.com (or into a PR
comment) and use the URL it inserts. A committed `.mp4` file only renders as
a link. The README uses it under the intro; replace that URL when you record
a new take.

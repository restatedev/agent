# Generates the timeline-style README animations: lanes, a playhead that
# sweeps left to right, and events that appear as the playhead reaches them.
# Usage: python3 .misc/animations/timeline.py [output dir] [animation name ...]
# With no names it writes every animation; see ANIMATIONS at the bottom.
import os
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO, "docs", "images")
ONLY = sys.argv[2:]
HOLD_END = 93  # everything stays visible until here, then fades before the loop

THEME = """
:root { --bg:#ffffff; --ink:#1b1f24; --muted:#59636e; --stroke:#d0d7de; --lane:#f6f8fa;
  --ok:#1a7f37; --ok-bg:#dafbe1; --bad:#cf222e; --bad-bg:#ffebe9; --warn:#9a6700; --warn-bg:#fff8c5;
  --user:#f6f8fa; --model:#f3efff; --tool:#eaf4ff; --reply:#fff4e8; --accent:#8250df; --tool-bar:#54aeff; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#0d1117; --ink:#e6edf3; --muted:#9198a1; --stroke:#30363d; --lane:#161b22;
    --ok:#3fb950; --ok-bg:#12261e; --bad:#f85149; --bad-bg:#2d1214; --warn:#d29922; --warn-bg:#2b2111;
    --user:#161b22; --model:#1f1935; --tool:#0f2238; --reply:#2a1c0e; --accent:#a371f7; --tool-bar:#388bfd; }
}
svg { background: var(--bg); }
text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; fill: var(--ink); }
.lane { fill: var(--lane); }
.lane-label { font-size: 13px; font-weight: 600; fill: var(--muted); }
.lane-sub { font-size: 11.5px; fill: var(--muted); }
.chip rect { stroke: var(--stroke); }
.chip.user rect { fill: var(--user); }
.chip.model rect { fill: var(--model); }
.chip.tool rect { fill: var(--tool); }
.chip.reply rect { fill: var(--reply); }
.chip.ok rect { fill: var(--ok-bg); stroke: var(--ok); }
.chip.bad rect { fill: var(--bad-bg); stroke: var(--bad); }
.chip.warn rect { fill: var(--warn-bg); stroke: var(--warn); }
.chip-t { font-size: 12.5px; font-weight: 600; }
.chip-s { font-size: 12px; fill: var(--muted); }
.bar { transform-box: fill-box; transform-origin: 0 50%; }
.bar.tool { fill: var(--tool-bar); }
.bar.ok { fill: var(--ok); }
.bar.wait { fill: none; stroke: var(--warn); stroke-width: 2; stroke-dasharray: 6 5; }
.bar.bad { fill: var(--bad); }
.chip.code rect { fill: var(--lane); stroke: var(--accent); }
.chip.code .chip-t { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 500; font-size: 12px; }
.chip.code .chip-s { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.mark.accent { fill: var(--accent); }
.msg.user { fill: var(--muted); }
.msg.assistant { fill: var(--tool-bar); }
.summary rect { fill: var(--model); stroke: var(--accent); }
.bracket { fill: none; stroke: var(--accent); stroke-width: 1.5; }
.row-label { font-size: 13px; font-weight: 600; fill: var(--muted); }
.bar.idle { fill: none; stroke: var(--muted); stroke-width: 2; stroke-dasharray: 6 5; }
.bar-t { font-size: 12px; font-weight: 600; }
.bar-t.on-bar { fill: #ffffff; }
.mark { font-size: 13px; font-weight: 700; }
.mark.bad { fill: var(--bad); }
.mark.ok { fill: var(--ok); }
.playhead { stroke: var(--accent); stroke-width: 2; opacity: 0; }
.caption { font-size: 15px; }
.axis { font-size: 11.5px; fill: var(--muted); }
.break { fill: none; stroke: var(--muted); stroke-width: 1.5; }
"""


class Animation:
    def __init__(self, width, height, seconds, playhead_end, x0=170, x1=975):
        self.width = width
        self.height = height
        self.seconds = seconds
        self.playhead_end = playhead_end
        self.x0 = x0
        self.x1 = x1
        self.css = []
        self.body = []
        self.names = []
        self.counter = 0
        self.hidden = []  # class names hidden in the final (static) frame

    def x(self, p):
        """Timeline x for animation percentage p, where the playhead is at p."""
        return self.x0 + (self.x1 - self.x0) * p / self.playhead_end

    def fresh(self, prefix):
        self.counter += 1
        name = "%s%d" % (prefix, self.counter)
        self.names.append(name)
        return name

    def keyframes(self, name, frames):
        rules = " ".join("%s { %s }" % frame for frame in frames)
        self.css.append("@keyframes %s { %s }" % (name, rules))

    def appear_at(self, name, p):
        self.keyframes(name, [
            ("0%%, %.2f%%" % max(p - 0.01, 0), "opacity: 0"),
            ("%.2f%%, %d%%" % (p + 1.2, HOLD_END), "opacity: 1"),
            ("%d%%, 100%%" % (HOLD_END + 5), "opacity: 0"),
        ])

    def visible_between(self, name, a, b):
        frames = []
        if a > 0:
            frames.append(("0%%, %.2f%%" % (a - 0.01), "opacity: 0"))
            frames.append(("%.2f%%" % (a + 0.8), "opacity: 1"))
        else:
            frames.append(("0%", "opacity: 1"))
        if b <= 100:
            frames.append(("%.2f%%" % (b - 0.8), "opacity: 1"))
            frames.append(("%.2f%%, 100%%" % b, "opacity: 0"))
            self.hidden.append(name)
        else:
            frames.append(("100%", "opacity: 1"))
        self.keyframes(name, frames)

    # Drawing -----------------------------------------------------------

    def lane(self, y, h, label, sub=None):
        self.body.append('<rect class="lane" x="16" y="%d" width="%d" height="%d" rx="10"/>'
                         % (y, self.width - 32, h))
        label_y = y + h / 2 + (0 if sub else 5)
        self.body.append('<text class="lane-label" x="32" y="%d">%s</text>' % (label_y, label))
        if sub:
            self.body.append('<text class="lane-sub" x="32" y="%d">%s</text>' % (label_y + 16, sub))

    def chip(self, p, y, width, kind, title, sub=None, height=None):
        """An event chip whose left edge sits where the playhead is at p."""
        name = self.fresh("e")
        self.appear_at(name, p)
        height = height or (44 if sub else 30)
        x = self.x(p)
        self.body.append('<g class="chip %s %s">' % (kind, name))
        self.body.append('<rect x="%.1f" y="%d" width="%d" height="%d" rx="8"/>' % (x, y, width, height))
        title_y = y + (19 if sub else 20)
        self.body.append('<text class="chip-t" x="%.1f" y="%d">%s</text>' % (x + 10, title_y, title))
        if sub:
            self.body.append('<text class="chip-s" x="%.1f" y="%d">%s</text>' % (x + 10, y + 36, sub))
        self.body.append("</g>")

    def bar(self, p_start, p_end, y, kind, label=None, label_on_bar=False, height=14):
        """A bar that grows in step with the playhead from p_start to p_end."""
        name = self.fresh("g")
        self.keyframes(name, [
            ("0%%, %.2f%%" % max(p_start - 0.01, 0), "opacity: 0; transform: scaleX(0.001)"),
            ("%.2f%%" % p_start, "opacity: 1; transform: scaleX(0.001)"),
            ("%.2f%%, %d%%" % (p_end, HOLD_END), "opacity: 1; transform: scaleX(1)"),
            ("%d%%, 100%%" % (HOLD_END + 5), "opacity: 0; transform: scaleX(1)"),
        ])
        x_start = self.x(p_start)
        width = self.x(p_end) - x_start
        self.body.append('<rect class="bar %s %s" x="%.1f" y="%d" width="%.1f" height="%d" rx="%d"/>'
                         % (kind, name, x_start, y, width, height, height / 2))
        if label:
            label_name = self.fresh("e")
            self.appear_at(label_name, p_start + 1)
            if label_on_bar:
                self.body.append('<text class="bar-t on-bar %s" x="%.1f" y="%d">%s</text>'
                                 % (label_name, x_start + 10, y + height / 2 + 4, label))
            else:
                self.body.append('<text class="bar-t %s" x="%.1f" y="%d">%s</text>'
                                 % (label_name, x_start, y - 6, label))

    def mark(self, p, y, kind, text):
        name = self.fresh("e")
        self.appear_at(name, p)
        self.body.append('<text class="mark %s %s" x="%.1f" y="%d">%s</text>' % (kind, name, self.x(p) + 2, y, text))

    def axis_label(self, p, y, text):
        name = self.fresh("e")
        self.appear_at(name, p)
        self.body.append('<text class="axis %s" x="%.1f" y="%d">%s</text>' % (name, self.x(p), y, text))

    def time_break(self, p, y0, y1, label):
        """A zig-zag across all lanes marking compressed time."""
        name = self.fresh("e")
        self.appear_at(name, p)
        x = self.x(p)
        points = []
        y = y0
        step = 0
        while y < y1:
            points.append("%.1f,%d" % (x + (5 if step % 2 else -5), y))
            y += 10
            step += 1
        self.body.append('<g class="%s"><polyline class="break" points="%s"/>'
                         '<text class="axis" x="%.1f" y="%d" text-anchor="middle">%s</text></g>'
                         % (name, " ".join(points), x, y0 - 8, label))

    def playhead(self, y0, y1):
        name = "playhead"
        self.names.append(name)
        travel = self.x1 - self.x0
        end = self.playhead_end
        self.keyframes(name, [
            ("0%", "opacity: 1; transform: translateX(0px)"),
            ("%d%%" % end, "opacity: 1; transform: translateX(%.1fpx)" % travel),
            ("%d%%, 100%%" % (end + 3), "opacity: 0; transform: translateX(%.1fpx)" % travel),
        ])
        self.body.append('<line class="playhead" x1="%d" y1="%d" x2="%d" y2="%d"/>' % (self.x0, y0, self.x0, y1))

    def captions(self, y, phases):
        for text, a, b in phases:
            name = self.fresh("cap")
            self.visible_between(name, a, b)
            self.body.append('<text class="caption %s" x="24" y="%d">%s</text>' % (name, y, text))

    def write(self, filename, aria):
        animations = "\n".join(
            ".%s { animation: %s %ds linear infinite; }" % (n, n, self.seconds, ) for n in self.names
        )
        # The static frame (no animation, or reduced motion) is the finished
        # timeline with the last caption.
        static_hidden = ", ".join("." + n for n in self.hidden)
        style = THEME + (static_hidden + " { opacity: 0; }\n" if static_hidden else "")
        style += "\n".join(self.css) + "\n" + animations + "\n"
        style += "@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }\n"
        svg = (
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="%d" height="%d" '
            'role="img" aria-label="%s">\n<style>%s</style>\n%s\n</svg>\n'
        ) % (self.width, self.height, self.width, self.height, aria, style, "\n".join(self.body))
        with open("%s/%s" % (OUT_DIR, filename), "w") as f:
            f.write(svg)


def steering():
    a = Animation(1000, 400, 16, 86)
    a.lane(20, 64, "Client")
    a.lane(94, 64, "Agent", "controller")
    a.lane(168, 164, "Turn", "AgentSession")

    a.chip(2, 34, 150, "user", "ask", "Plan a Berlin trip")
    a.chip(4, 108, 110, "ok", "turn started")

    a.chip(6, 178, 116, "model", "model step", "2 tool calls")
    a.bar(14, 26, 250, "tool", "getWeather")
    a.mark(26, 262, "ok", "✓")
    a.bar(14, 46, 294, "tool", "webSearch: flights")
    a.mark(46, 306, "ok", "✓")

    a.chip(30, 34, 170, "user", "steer", "Only direct flights")
    a.chip(32, 108, 90, "ok", "steered")
    a.chip(32, 178, 130, "warn", "steering signal", "queued for next step")

    a.chip(48, 178, 138, "model", "model step", "sees tools + steer")
    a.bar(57, 70, 294, "tool", "webSearch: direct only")
    a.mark(70, 306, "bad", "✕")

    a.chip(69, 34, 100, "user", "interrupt")
    a.chip(71, 108, 110, "ok", "interrupted")
    a.chip(73, 178, 112, "reply", "summary", "what got done")

    a.playhead(20, 332)
    a.captions(372, [
        ("A turn is running: one model step, then its tool calls in parallel.", 0, 29),
        ("Steering is answered at once. It reaches the next model step, and no running tool is cancelled.", 29, 67),
        ("An interrupt cancels unfinished work, and the turn ends with a summary of what it did.", 67, 101),
    ])
    a.write("steer-interrupt.svg",
            "Animation: while a turn runs tools in parallel, the client steers it and the controller answers "
            "at once; the steering reaches the next model step without cancelling tools; an interrupt cancels "
            "the remaining tool and the turn ends with a summary.")


def durable_wait():
    a = Animation(1000, 360, 18, 86)
    a.lane(20, 72, "Turn", "AgentSession")
    a.lane(102, 72, "Process", "agent service")
    a.lane(184, 72, "Approver", "a person")

    a.axis_label(0.5, 272, "Mon 16:02")
    a.chip(1, 34, 126, "model", "model step", "deploy to prod?")
    a.chip(16, 34, 128, "warn", "guardrail", "needs approval")
    a.chip(18, 198, 150, "user", "approval request", "turn-7 · deploy")
    a.bar(31, 62, 50, "wait", "waiting for approval, durably")

    a.bar(0, 30, 124, "ok", "running", label_on_bar=True)
    a.bar(31, 62, 124, "idle", "suspended: no process, only state")
    a.chip(42, 142, 124, "tool", "new version v2")
    a.bar(63, 86, 124, "ok", "resumed", label_on_bar=True)

    a.time_break(54, 24, 256, "")
    a.axis_label(46, 272, "≈ 1 day later")
    a.chip(59, 198, 100, "ok", "approve", "Tue 09:14")
    a.axis_label(62.5, 272, "Tue 09:14")

    a.chip(64, 34, 104, "tool", "deploy", "runs now")
    a.chip(76.5, 34, 96, "reply", "reply", "deployed ✓")

    a.playhead(20, 256)
    a.captions(318, [
        ("A guardrail requires a person to approve the deploy before it runs.", 0, 30),
        ("The turn suspends: no process, only state. New versions can ship while it waits.", 30, 62),
        ("When the approval arrives a day later, the turn resumes exactly where it waited.", 62, 101),
    ])
    a.write("durable-wait.svg",
            "Animation: a guardrail requires approval; the turn suspends and holds no process for about a day, "
            "while a new service version ships; when a person approves, the turn resumes, runs the deploy and replies.")


def sub_agents():
    a = Animation(1000, 400, 16, 86)
    a.lane(20, 64, "Client")
    a.lane(94, 86, "Parent turn", "agent demo")
    a.lane(190, 64, "Sub-agent", "berlin")
    a.lane(264, 64, "Sub-agent", "paris")

    a.chip(1, 34, 176, "user", "ask", "Compare Berlin and Paris")
    a.chip(5, 104, 140, "model", "model step", "2 × createSubAgent")
    a.bar(21, 51, 160, "wait", "waiting on both, durably")

    a.chip(21, 200, 148, "tool", "own history", "sandbox and memory")
    a.bar(38, 45, 228, "tool")
    a.chip(45.5, 207, 76, "reply", "answer")
    a.chip(21, 274, 148, "tool", "own history", "sandbox and memory")
    a.bar(38, 50, 302, "tool")
    a.chip(50.5, 281, 76, "reply", "answer")

    a.chip(28, 34, 110, "user", "ask", "Add Rome")
    a.chip(41, 38, 150, "ok", "queued for next turn")

    a.chip(52, 104, 128, "model", "model step", "compare answers")
    a.chip(66, 111, 70, "reply", "reply")
    a.chip(74, 104, 104, "warn", "next turn", "Add Rome")

    a.playhead(20, 328)
    a.captions(372, [
        ("The agent hands the work to two sub-agents, each with its own history, sandbox and memory.", 0, 27),
        ("While the parent turn waits, its controller still answers. A new message is queued.", 27, 52),
        ("The answers come back as tool results, and the queued message starts the next turn.", 52, 101),
    ])
    a.write("sub-agents.svg",
            "Animation: a parent turn creates two sub-agents that work in parallel while it waits durably; "
            "a new client message is queued meanwhile; the answers return as tool results and the queued "
            "message starts the next turn.")


def programmatic_tool_calls():
    a = Animation(1000, 400, 16, 86)
    a.lane(20, 64, "Model")
    a.lane(94, 176, "Program", "QuickJS guest")
    a.lane(280, 56, "Model context")

    a.chip(1, 34, 140, "model", "model step", "writes a program")
    a.bar(1, 9, 308, "tool", "program")
    a.chip(9, 104, 300, "code", "const cities = [4 cities]",
           "Promise.all(cities.map(getWeather))")

    rows = [("Berlin", 38), ("Paris", 42), ("Rome", 37), ("Oslo", 44)]
    for n, (city, end) in enumerate(rows):
        y = 158 + n * 24
        a.mark(21.5, y + 14, "accent", "✓")
        a.bar(24, end, y, "tool", "getWeather(%s)" % city, label_on_bar=True, height=18)

    a.chip(45, 104, 200, "code", "return", "{warmest: 'Rome', 21°C}")
    a.bar(45, 50, 308, "tool", "result")
    a.axis_label(52, 320, "the 4 raw tool results never enter it")

    a.chip(56, 34, 160, "model", "model step", "reads 1 small result")
    a.chip(75.5, 41, 80, "reply", "reply")

    a.playhead(20, 336)
    a.captions(372, [
        ("For work that needs many tool calls, the model writes one small JavaScript program.", 0, 20),
        ("Each tool call the program makes passes the guardrails (✓) and is journaled, and they run in parallel.", 20, 45),
        ("Only the compact result goes back to the model: one model step instead of four.", 45, 101),
    ])
    a.write("programmatic-tool-calls.svg",
            "Animation: the model writes a JavaScript program that calls getWeather for four cities in "
            "parallel inside a QuickJS guest, each call checked by the guardrails; only the compact result "
            "returns to the model context.")


def compaction():
    a = Animation(1000, 300, 16, 86)
    pitch, size, x0 = 22, 16, 40
    log_y, context_y = 64, 214
    summarized, recent = 24, 8

    def square(x, y, index, name):
        kind = "user" if index % 2 == 0 else "assistant"
        a.body.append('<rect class="msg %s %s" x="%d" y="%d" width="%d" height="%d" rx="4"/>'
                      % (kind, name, x, y, size, size))

    a.body.append('<text class="row-label" x="%d" y="50">Conversation log · append-only</text>' % x0)
    a.body.append('<text class="row-label" x="%d" y="200">What the model sees</text>' % x0)

    # First 32 messages: in the log, and in the model context until compaction.
    for i in range(summarized + recent):
        p = 2 + i
        name = a.fresh("e")
        a.appear_at(name, p)
        square(x0 + i * pitch, log_y, i, name)
        name = a.fresh("e")
        a.visible_between(name, p, 47)
        square(x0 + i * pitch, context_y, i, name)

    # Compaction: brackets over the summarized prefix and the verbatim tail.
    name = a.fresh("e")
    a.appear_at(name, 37)
    x_end = x0 + (summarized - 1) * pitch + size
    a.body.append('<g class="%s"><path class="bracket" d="M %d 88 v 6 H %d v -6"/>'
                  '<text class="axis" x="%d" y="110">summarized in the background, after the turn</text></g>'
                  % (name, x0, x_end, x0))
    name = a.fresh("e")
    a.appear_at(name, 40)
    x_tail = x0 + summarized * pitch
    a.body.append('<g class="%s"><path class="bracket" d="M %d 88 v 6 H %d v -6"/>'
                  '<text class="axis" x="%d" y="110">8 most recent stay verbatim</text></g>'
                  % (name, x_tail, x_tail + (recent - 1) * pitch + size, x_tail))

    name = a.fresh("e")
    a.appear_at(name, 48)
    a.body.append('<g class="summary %s"><rect x="%d" y="%d" width="130" height="24" rx="6"/>'
                  '<text class="chip-t" x="%d" y="%d">summary of 1–24</text></g>'
                  % (name, x0, context_y - 4, x0 + 10, context_y + 13))
    context_x = x0 + 140
    for k in range(recent):
        name = a.fresh("e")
        a.appear_at(name, 49 + k * 0.5)
        square(context_x + k * pitch, context_y, summarized + k, name)

    # Later messages are appended to the log and follow the tail in context.
    for j in range(8):
        index = summarized + recent + j
        p = 58 + j * 3
        name = a.fresh("e")
        a.appear_at(name, p)
        square(x0 + index * pitch, log_y, index, name)
        name = a.fresh("e")
        a.appear_at(name, p)
        square(context_x + (recent + j) * pitch, context_y, index, name)

    a.captions(272, [
        ("Every message is appended to the conversation log, and the model sees all of it.", 0, 36),
        ("After a turn, older messages are summarized in the background. The 8 most recent stay verbatim.", 36, 57),
        ("The log is never rewritten. Later turns build on the summary plus the recent messages.", 57, 101),
    ])
    a.write("compaction.svg",
            "Animation: messages are appended to the conversation log; after a turn the older 24 are "
            "summarized in the background while the 8 most recent stay verbatim; the log keeps growing, "
            "and the model context holds the summary plus recent messages.")


def schedules():
    a = Animation(1000, 330, 16, 86)
    a.lane(20, 64, "Restate", "timers")
    a.lane(94, 64, "Agent")
    a.lane(168, 64, "Process", "agent service")

    a.chip(1, 108, 170, "user", "createSchedule", "daily 08:00: weather")
    a.chip(20, 34, 100, "ok", "fire", "Mon 08:00")
    a.chip(22, 108, 110, "reply", "turn", "Berlin 12°C")

    a.time_break(36, 24, 232, "")
    a.axis_label(33, 250, "next day")

    a.bar(0, 42, 193, "ok", "running", label_on_bar=True)
    a.bar(42, 56, 193, "bad", "down: outage", label_on_bar=True)
    a.bar(56, 86, 193, "ok", "running", label_on_bar=True)
    a.chip(46, 34, 100, "warn", "fire", "Tue 08:00")
    a.chip(57, 108, 110, "ok", "delivered", "once it is back")

    a.time_break(70, 24, 232, "")
    a.axis_label(67, 250, "next day")
    a.chip(73, 34, 100, "ok", "fire", "Wed 08:00")
    a.chip(75, 108, 110, "reply", "turn", "Berlin 15°C")

    a.playhead(20, 232)
    a.captions(292, [
        ("A schedule delivers a message to the agent later, once or on a recurrence.", 0, 40),
        ("Its timers live in Restate. A firing while the service is down is delivered once it is back.", 40, 68),
        ("No cron and no separate scheduler: each firing starts a turn like any other message.", 68, 101),
    ])
    a.write("schedules.svg",
            "Animation: a daily schedule fires on Monday and starts a turn; on Tuesday it fires while the "
            "service is down and is delivered once the service is back; on Wednesday it fires again.")


def parallel_tool_calls():
    a = Animation(1000, 360, 16, 86)
    a.lane(20, 64, "Turn", "model steps")
    a.lane(94, 54, "Guardrails")
    a.lane(158, 128, "Tools")

    a.chip(1, 34, 124, "model", "model step", "3 tool calls")
    a.chip(15, 99, 150, "ok", "batch allowed", "one check, 3 calls")

    a.bar(26, 40, 190, "tool", "getWeather")
    a.mark(40, 202, "ok", "✓")
    a.bar(26, 52, 226, "tool", "webSearch")
    a.mark(52, 238, "ok", "✓")
    a.bar(26, 34, 262, "tool", "runCommand")
    a.mark(34, 274, "bad", "✕")
    a.axis_label(37, 274, "failed: reported to the model, the others keep running")

    a.chip(54, 34, 164, "model", "model step", "2 results + 1 error")
    a.chip(73, 41, 80, "reply", "reply")

    a.playhead(20, 286)
    a.captions(330, [
        ("One model response proposes three tool calls, and the guardrails check them as one batch.", 0, 25),
        ("They run concurrently. runCommand fails, and its error does not discard the other results.", 25, 53),
        ("The next model step sees both results and the error, and decides what to do.", 53, 101),
    ])
    a.write("parallel-tool-calls.svg",
            "Animation: one model step proposes three tool calls; the guardrails allow the batch in one check; "
            "the calls run concurrently, one fails and is reported as an error while the others finish; the "
            "next model step sees both results and the error, and replies.")


def background_operations():
    a = Animation(1000, 380, 16, 86)
    a.lane(20, 64, "Client")
    a.lane(94, 86, "Turn", "model steps")
    a.lane(190, 110, "Background", "pending operations")

    a.chip(1, 34, 214, "user", "ask", "Order laptops, remind me in 2 min")
    a.chip(3, 104, 150, "model", "model step", "humanApproval + sleep")

    a.bar(19, 57, 222, "wait", "humanApproval: waiting for a person")
    a.mark(57, 234, "bad", "✕")
    a.bar(19, 64, 266, "tool", "sleep 120s: durable timer")
    a.mark(64, 278, "ok", "✓")
    a.axis_label(19, 294, "both return pending at once")

    a.chip(20, 104, 150, "model", "model step", "answers, stays open")
    a.chip(37, 111, 100, "warn", "waiting on 2")
    a.chip(40, 34, 170, "user", "steer", "Cancel the order")
    a.chip(49, 104, 140, "model", "model step", "cancelOperation")
    a.chip(65, 104, 120, "model", "model step", "timer fired")
    a.chip(79, 111, 70, "reply", "reply")

    a.playhead(20, 300)
    a.captions(344, [
        ("An approval request and a timer return pending at once, then keep running in the background.", 0, 36),
        ("The turn waits for them without blocking. Steered to stop, the model calls cancelOperation.", 36, 63),
        ("A completion arrives as a message before the next model step, and the turn then finishes.", 63, 101),
    ])
    a.write("background-operations.svg",
            "Animation: the model starts a human approval request and a durable timer, both return pending "
            "at once and run in the background; the model answers and the turn waits on them; the client "
            "steers it to cancel, and the model cancels the approval with cancelOperation; the timer "
            "completes, the next model step sees it and the turn replies.")


def steering_detail():
    a = Animation(1000, 360, 16, 86)
    a.lane(20, 64, "Client")
    a.lane(94, 86, "Turn", "model steps")
    a.lane(190, 100, "Tools")

    a.chip(1, 34, 150, "user", "ask", "Find a Berlin hotel")
    a.chip(4, 110, 120, "model", "model step", "2 tool calls")

    a.bar(12, 34, 218, "tool", "webSearch")
    a.mark(34, 230, "ok", "✓")
    a.bar(12, 34, 262, "tool", "executeProgram")
    a.bar(34, 60, 262, "idle", "handed off, keeps running")
    a.mark(60, 274, "ok", "✓")

    a.chip(20, 34, 130, "user", "steer", "Under €150")
    a.chip(20.5, 110, 126, "warn", "steer waiting", "quick tools finish")
    a.chip(35, 110, 120, "model", "model step", "sees the steer")

    a.chip(46, 34, 130, "user", "steer", "Near the river")
    a.chip(49, 110, 116, "bad", "draft answer", "stale, replaced")
    a.chip(62.5, 110, 120, "model", "model step", "both steers")
    a.chip(76.5, 117, 80, "reply", "reply")

    a.playhead(20, 290)
    a.captions(330, [
        ("The turn runs a model step, then a quick search and a long program in parallel.", 0, 20),
        ("A steer arrives: quick tools finish, the long program moves to the background, and the next step sees the steer.", 20, 46),
        ("A steer that arrives while the answer is being written replaces it. The next step sees every steer.", 46, 101),
    ])
    a.write("steering.svg",
            "Animation: while a search and a long program run, the client steers; the search finishes, the "
            "program is handed off to the background, and the next model step sees the steer; a second steer "
            "arrives while the answer is being drafted, so the draft is replaced by a step that sees both steers.")


def async_compaction():
    a = Animation(1000, 330, 16, 86)
    a.lane(20, 64, "Client")
    a.lane(94, 64, "AgentSession", "exclusive handlers")
    a.lane(168, 64, "AgentSession", "shared handlers")

    a.chip(1, 34, 70, "user", "ask")
    a.bar(2, 19, 119, "ok", "turn 1", label_on_bar=True)
    a.chip(19.5, 108, 120, "warn", "reserve 1–24", "send compact()")

    a.chip(24, 34, 70, "user", "ask")
    a.bar(33, 58, 119, "ok", "turn 2 · previous context", label_on_bar=True)

    a.chip(33, 178, 104, "tool", "compact()", "reads 1–24")
    a.bar(45, 52, 193, "tool", "summarize")
    a.chip(52.5, 182, 150, "warn", "result sent", "queued behind turn 2")

    a.chip(59, 108, 120, "reply", "applyCompaction", "range matches ✓")
    a.chip(66, 34, 70, "user", "ask")
    a.bar(73, 86, 119, "ok", "turn 3 · summary", label_on_bar=True)

    a.playhead(20, 232)
    a.captions(292, [
        ("When a turn ends with a long log, it reserves the older messages and sends compact() one way.", 0, 23),
        ("compact() is a shared handler: it summarizes next to the running turn and never blocks it.", 23, 58),
        ("The summary is applied between turns, and only if the reserved range still matches.", 58, 101),
    ])
    a.write("async-compaction.svg",
            "Animation: turn 1 ends and reserves messages 1 to 24 for compaction; turn 2 starts at once while "
            "a shared compact handler summarizes them in parallel; the summary is applied between turns and "
            "turn 3 uses it.")


def in_process():
    a = Animation(1000, 400, 16, 86)
    box_css = (
        ".box { fill: var(--lane); stroke: var(--stroke); }\n"
        ".inner { fill: var(--bg); stroke: var(--stroke); }\n"
        ".box-t { font-size: 14px; font-weight: 600; }\n"
        ".stream { fill: var(--model); stroke: var(--accent); stroke-width: 1.5; }\n"
        ".packet { fill: var(--accent); }\n"
        ".pending { font-size: 12px; fill: var(--muted); }\n"
    )
    a.css.append(box_css)

    # Process on the left, Restate on the right, one stream between them.
    a.body.append('<rect class="box" x="16" y="20" width="520" height="300" rx="12"/>')
    a.body.append('<text class="box-t" x="36" y="46">Agent service process</text>')
    a.body.append('<rect class="inner" x="36" y="60" width="480" height="244" rx="10"/>')
    a.body.append('<text class="lane-label" x="52" y="84">doTurn · model calls and tools are in-process function calls</text>')
    a.body.append('<rect class="box" x="664" y="20" width="320" height="300" rx="12"/>')
    a.body.append('<text class="box-t" x="684" y="46">Restate</text>')
    a.body.append('<text class="lane-label" x="684" y="84">turn journal, persisted</text>')
    a.body.append('<rect class="stream" x="536" y="150" width="128" height="40" rx="6"/>')
    a.body.append('<text class="axis" x="600" y="140" text-anchor="middle">one open stream</text>')
    a.body.append('<text class="axis" x="600" y="210" text-anchor="middle">low-latency appends</text>')

    # (row label, start, done, journal entry label); entries land in completion order.
    rows = [
        ("model step · OpenAI", 3, 9, "model response"),
        ("getWeather()", 17, 22, "getWeather result"),
        ("webSearch()", 18, 32, "webSearch result"),
        ("runCommand() · sandbox", 19, 26, "runCommand result"),
        ("model step · OpenAI", 40, 47, "model response"),
        ("publish reply", 56, 60, "reply"),
    ]
    arrivals = sorted(done + 4 for _, _, done, _ in rows)
    for i, (label, start, done, entry) in enumerate(rows):
        y = 96 + i * 34
        name = a.fresh("e")
        a.appear_at(name, start)
        a.body.append('<g class="chip tool %s"><rect x="52" y="%d" width="300" height="28" rx="7"/>'
                      '<text class="chip-t" x="64" y="%d">%s</text></g>' % (name, y, y + 19, label))
        name = a.fresh("e")
        a.visible_between(name, start, done)
        a.body.append('<text class="pending %s" x="364" y="%d">running…</text>' % (name, y + 19))
        name = a.fresh("e")
        a.appear_at(name, done + 4)
        a.body.append('<text class="mark ok %s" x="364" y="%d">✓ journaled</text>' % (name, y + 19))

        # The append travels across the stream.
        name = a.fresh("e")
        a.keyframes(name, [
            ("0%%, %.2f%%" % (done - 0.01), "opacity: 0; transform: translateX(0px)"),
            ("%.2f%%" % done, "opacity: 1; transform: translateX(0px)"),
            ("%.2f%%" % (done + 3.5), "opacity: 1; transform: translateX(150px)"),
            ("%.2f%%, 100%%" % (done + 4), "opacity: 0; transform: translateX(150px)"),
        ])
        a.body.append('<circle class="packet %s" cx="524" cy="170" r="6"/>' % name)

        # Journal entry, numbered by arrival order.
        arrival = done + 4
        index = arrivals.index(arrival)
        ey = 96 + index * 34
        name = a.fresh("e")
        a.appear_at(name, arrival)
        a.body.append('<g class="chip ok %s"><rect x="684" y="%d" width="280" height="28" rx="7"/>'
                      '<text class="chip-t" x="696" y="%d">%d · %s</text></g>'
                      % (name, ey, ey + 19, index + 1, entry))

    a.captions(360, [
        ("doTurn runs the model calls and tools itself, in the process: no queue or service hop per step.", 0, 24),
        ("Each result is appended to the turn&#8217;s journal over one open, low-latency stream to Restate.", 24, 56),
        ("Entries land in completion order and are persisted, so a crash replays them instead of re-running.", 56, 101),
    ])
    a.write("in-process.svg",
            "Animation: inside the agent service process, doTurn runs a model call and three tools as "
            "in-process function calls; each result is appended over one open stream to the turn journal "
            "in Restate, in completion order.")


# Name -> generator. The name is what you pass on the command line; each
# generator writes docs/images/<file> (see its a.write call).
ANIMATIONS = {
    "steer-interrupt": steering,
    "in-process": in_process,
    "steering": steering_detail,
    "async-compaction": async_compaction,
    "durable-wait": durable_wait,
    "sub-agents": sub_agents,
    "programmatic-tool-calls": programmatic_tool_calls,
    "compaction": compaction,
    "schedules": schedules,
    "parallel-tool-calls": parallel_tool_calls,
    "background-operations": background_operations,
}

for animation_name, generate in ANIMATIONS.items():
    if not ONLY or animation_name in ONLY:
        generate()

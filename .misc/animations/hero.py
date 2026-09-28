# Generates docs/images/durable-turn.svg: an animated, looping illustration of
# a turn that crashes mid-way and resumes by replaying its journal.
# Usage: python3 .misc/animations/hero.py [output svg]
import os
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO, "docs", "images", "durable-turn.svg")
T = 16  # seconds per loop
HOLD_END = 93

cells = [
    ("user", "Weather in", "Berlin?"),
    ("model", "call 3 tools", "in parallel"),
    ("tool", "getWeather", "12°C, light rain"),
    ("tool", "webSearch", "5 results"),
    ("tool", "runCommand", "exit 0"),
    ("model", "final answer", ""),
    ("reply", "published", "to the log"),
]
appear = [3, 9, 15, 19, 23, 70, 77]
REPLAY_START, REPLAY_STEP = 52, 3
CRASH, RESTART = 31, 47
RECORDED = 5

W, H = 1000, 340
CW, GAP, X0, Y0, CH = 128, 8, 28, 150, 110


def cx(i):
    return X0 + i * (CW + GAP)


css, body = [], []


def kf(name, frames):
    rules = " ".join("%s { %s }" % f for f in frames)
    css.append("@keyframes %s { %s }" % (name, rules))


def show_from(name, p):
    # Hidden until p%, visible until HOLD_END, then fades before the loop restarts.
    kf(name, [
        ("0%%, %.2f%%" % (p - 0.01), "opacity: 0"),
        ("%.2f%%, %d%%" % (p + 1.5, HOLD_END), "opacity: 1"),
        ("%d%%, 100%%" % (HOLD_END + 5), "opacity: 0"),
    ])


def visible_between(name, a, b):
    frames = []
    if a > 0:
        frames.append(("0%%, %.2f%%" % (a - 0.01), "opacity: 0"))
        frames.append(("%.2f%%" % (a + 0.8), "opacity: 1"))
    else:
        frames.append(("0%", "opacity: 1"))
    if b <= 100:
        frames.append(("%.2f%%" % (b - 0.8), "opacity: 1"))
        frames.append(("%.2f%%, 100%%" % b, "opacity: 0"))
    else:
        frames.append(("100%", "opacity: 1"))
    kf(name, frames)


# Process status box.
body.append('<text class="label" x="28" y="44">Agent service process</text>')
body.append('<rect class="proc" x="28" y="56" width="300" height="46" rx="10"/>')
kf("proc", [
    ("0%%, %.1f%%" % (CRASH - 0.1), "fill: var(--ok-bg); stroke: var(--ok)"),
    ("%.1f%%, %.1f%%" % (CRASH + 0.5, RESTART - 0.1), "fill: var(--bad-bg); stroke: var(--bad)"),
    ("%.1f%%, 100%%" % (RESTART + 0.5), "fill: var(--ok-bg); stroke: var(--ok)"),
])
states = [
    ("running", "ok", 0, CRASH),
    ("crashed", "bad", CRASH, RESTART),
    ("restarted", "ok", RESTART, 101),
]
for n, (label, cls, a, b) in enumerate(states):
    name = "st%d" % n
    visible_between(name, a, b)
    icon = "●" if cls == "ok" else "✕"
    body.append(
        '<text class="state %s %s" x="48" y="85"><tspan class="dot">%s</tspan>  %s</text>'
        % (cls, name, icon, label)
    )

body.append('<text class="label" x="28" y="138">Turn journal, stored by Restate</text>')

# Journal cells: dashed placeholders plus animated fills.
for i, (kind, line1, line2) in enumerate(cells):
    x = cx(i)
    body.append('<rect class="slot" x="%d" y="%d" width="%d" height="%d" rx="10"/>' % (x, Y0, CW, CH))
    name = "c%d" % i
    show_from(name, appear[i])
    body.append('<g class="%s">' % name)
    body.append('<rect class="cell %s" x="%d" y="%d" width="%d" height="%d" rx="10"/>' % (kind, x, Y0, CW, CH))
    body.append('<text class="idx" x="%d" y="%d">%d · %s</text>' % (x + 12, Y0 + 24, i + 1, kind))
    body.append('<text class="line" x="%d" y="%d">%s</text>' % (x + 12, Y0 + 50, line1.replace("'", "&#8217;")))
    if line2:
        body.append('<text class="line muted" x="%d" y="%d">%s</text>' % (x + 12, Y0 + 70, line2))
    body.append("</g>")

# Replay cursor sweeping the recorded cells, and a "reused" badge on each.
shift = (RECORDED - 1) * (CW + GAP)
replay_end = REPLAY_START + REPLAY_STEP * (RECORDED - 1)
kf("cursor", [
    ("0%%, %.1f%%" % (REPLAY_START - 1), "opacity: 0; transform: translateX(0px)"),
    ("%.1f%%" % REPLAY_START, "opacity: 1; transform: translateX(0px)"),
    ("%.1f%%" % replay_end, "opacity: 1; transform: translateX(%dpx)" % shift),
    ("%.1f%%, 100%%" % (replay_end + 3), "opacity: 0; transform: translateX(%dpx)" % shift),
])
body.append(
    '<rect class="cursor" x="%d" y="%d" width="%d" height="%d" rx="12"/>'
    % (cx(0) - 4, Y0 - 4, CW + 8, CH + 8)
)
for i in range(RECORDED):
    name = "b%d" % i
    show_from(name, REPLAY_START + REPLAY_STEP * i + 0.5)
    x = cx(i) + 12
    body.append(
        '<g class="%s"><rect class="badge" x="%d" y="%d" width="66" height="20" rx="10"/>'
        '<text class="badge-t" x="%d" y="%d">✓ reused</text></g>'
        % (name, x, Y0 + CH - 30, x + 33, Y0 + CH - 16)
    )

# One caption per phase.
captions = [
    ("Each model response and tool result is recorded in the turn&#8217;s journal.", 0, CRASH),
    ("The process crashes in the middle of the turn. The journal is safe in Restate.", CRASH, RESTART + 4),
    ("After restart, Restate replays the journal: recorded results are reused, nothing runs twice.", RESTART + 4, 68),
    ("The turn continues from where it stopped and publishes its answer.", 68, 101),
]
for n, (text, a, b) in enumerate(captions):
    name = "cap%d" % n
    visible_between(name, a, b)
    body.append('<text class="caption %s" x="28" y="304">%s</text>' % (name, text))

names = (
    ["proc", "cursor"]
    + ["st%d" % i for i in range(len(states))]
    + ["c%d" % i for i in range(len(cells))]
    + ["b%d" % i for i in range(RECORDED)]
    + ["cap%d" % i for i in range(len(captions))]
)
animations = "\n".join(".%s { animation: %s %ds linear infinite; }" % (n, n, T) for n in names)

# Base styles are the final frame, so a static render (or reduced motion)
# shows the finished turn.
style = """
:root { --bg:#ffffff; --ink:#1b1f24; --muted:#59636e; --stroke:#d0d7de;
  --ok:#1a7f37; --ok-bg:#dafbe1; --bad:#cf222e; --bad-bg:#ffebe9;
  --user:#f6f8fa; --model:#f3efff; --tool:#eaf4ff; --reply:#fff4e8; --accent:#8250df; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#0d1117; --ink:#e6edf3; --muted:#9198a1; --stroke:#30363d;
    --ok:#3fb950; --ok-bg:#12261e; --bad:#f85149; --bad-bg:#2d1214;
    --user:#161b22; --model:#1f1935; --tool:#0f2238; --reply:#2a1c0e; --accent:#a371f7; }
}
svg { background: var(--bg); }
text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; fill: var(--ink); }
.label { font-size: 13px; font-weight: 600; fill: var(--muted); }
.proc { fill: var(--ok-bg); stroke: var(--ok); stroke-width: 1.5; }
.state { font-size: 15px; font-weight: 600; }
.state.ok .dot { fill: var(--ok); }
.state.bad, .state.bad .dot { fill: var(--bad); }
.st0, .st1 { opacity: 0; }
.slot { fill: none; stroke: var(--stroke); stroke-dasharray: 5 4; }
.cell { stroke: var(--stroke); }
.cell.user { fill: var(--user); }
.cell.model { fill: var(--model); }
.cell.tool { fill: var(--tool); }
.cell.reply { fill: var(--reply); }
.idx { font-size: 11.5px; font-weight: 600; fill: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
.line { font-size: 13px; }
.muted { fill: var(--muted); }
.cursor { fill: none; stroke: var(--accent); stroke-width: 2.5; opacity: 0; }
.badge { fill: var(--ok-bg); stroke: var(--ok); }
.badge-t { font-size: 11px; font-weight: 600; fill: var(--ok); text-anchor: middle; }
.caption { font-size: 15px; }
.cap0, .cap1, .cap2 { opacity: 0; }
""" + "\n".join(css) + "\n" + animations + """
@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
"""

aria = (
    "Animation: a turn records a user message, a model call and three tool results in its journal; "
    "the process crashes; after restart Restate replays the journal, reuses the recorded results, "
    "and the turn finishes with a final answer."
)
svg = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="%d" height="%d" role="img" aria-label="%s">\n'
    "<style>%s</style>\n%s\n</svg>\n"
) % (W, H, W, H, aria, style, "\n".join(body))

with open(OUT, "w") as f:
    f.write(svg)

#!/usr/bin/env bash
# Encodes the frames record.mjs wrote into an MP4 for GitHub.
# Usage: .misc/video/encode.sh [out dir]   (default: .misc/video/out)
# Frames arrive only when the stage repaints, so each one is held until the
# next; ffmpeg then resamples that to a constant 30 fps.
set -euo pipefail
out="${1:-$(dirname "$0")/out}"

node -e '
  const frames = require(process.argv[1] + "/frames.json");
  const lines = ["ffconcat version 1.0"];
  for (let i = 0; i < frames.length - 1; i++) {
    lines.push(`file frames/${frames[i].file}`, `duration ${(frames[i + 1].time - frames[i].time).toFixed(4)}`);
  }
  lines.push(`file frames/${frames.at(-1).file}`);
  require("fs").writeFileSync(process.argv[1] + "/frames.ffconcat", lines.join("\n") + "\n");
' "$out"

ffmpeg -y -loglevel error -f concat -safe 0 -i "$out/frames.ffconcat" \
  -vf "fps=30,format=yuv420p" -c:v libx264 -preset slow -crf 20 \
  -movflags +faststart "$out/kill-it-mid-turn.mp4"

ls -lh "$out/kill-it-mid-turn.mp4"

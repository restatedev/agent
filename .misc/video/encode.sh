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

# The frames are full-range JPEGs; convert to limited-range yuv420p at level
# 4.1, which every player handles (QuickTime shows a still for yuvj420p).
# Encode to a temporary file and rename it, so a player that has the old
# video open never reads a half-written one.
ffmpeg -y -loglevel error -f concat -safe 0 -i "$out/frames.ffconcat" \
  -vf "fps=30,scale=out_range=tv:out_color_matrix=bt709,format=yuv420p" \
  -c:v libx264 -preset slow -crf 20 -profile:v high -level:v 4.1 \
  -color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709 \
  -movflags +faststart "$out/agent-demo.tmp.mp4"
mv "$out/agent-demo.tmp.mp4" "$out/agent-demo.mp4"

ls -lh "$out/agent-demo.mp4"

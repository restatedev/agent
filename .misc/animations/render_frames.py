# Renders frames of an animated SVG at fixed times, in light and dark mode, by
# inlining it into HTML with every animation paused at a negative delay.
# Usage: python3 .misc/animations/render_frames.py <svg> <out dir> <seconds...>
# The window size is read from the SVG's width and height. Needs Google Chrome;
# set CHROME to its binary if it is not in the macOS default location.
import os
import re
import subprocess
import sys

svg_path, out_dir = sys.argv[1:3]
times = sys.argv[3:]
svg = open(svg_path).read()
width = re.search(r'<svg[^>]* width="(\d+)"', svg).group(1)
height = re.search(r'<svg[^>]* height="(\d+)"', svg).group(1)
base = os.path.splitext(os.path.basename(svg_path))[0]
chrome = os.environ.get("CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
os.makedirs(out_dir, exist_ok=True)

for scheme, flags in [
    ("light", ["--blink-settings=preferredColorScheme=1"]),
    ("dark", ["--force-dark-mode", "--blink-settings=preferredColorScheme=0"]),
]:
    for t in times:
        html = (
            "<html><body style='margin:0'><style>svg * { animation-play-state: paused !important; "
            "animation-delay: -%ss !important; }</style>%s</body></html>" % (t, svg)
        )
        page = "%s/%s.html" % (out_dir, base)
        with open(page, "w") as f:
            f.write(html)
        png = "%s/%s-%s-%s.png" % (out_dir, base, scheme, t)
        subprocess.run(
            [chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars", *flags,
             "--window-size=%s,%s" % (width, height), "--screenshot=%s" % png, "file://" + page],
            capture_output=True,
        )
        print(png)

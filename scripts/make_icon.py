#!/usr/bin/env python3
"""Draw build/icon.png (1024x1024): a flat teal rounded square with a white "C"
arc and a dot in its opening. Needs Pillow; only used when regenerating the icon."""
import math
from PIL import Image, ImageDraw

S = 4                      # supersample, then shrink for smooth edges
N = 1024 * S
TEAL = (31, 95, 91, 255)   # same teal as the app's accent
WHITE = (255, 255, 255, 255)

img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# macOS-style tile: 824px square inside the 1024 canvas
m = 100 * S
d.rounded_rectangle((m, m, N - m, N - m), radius=185 * S, fill=TEAL)

cx = cy = N // 2
mid_r = 255 * S            # centre line of the ring
thick = 90 * S
outer = mid_r + thick // 2
d.arc((cx - outer, cy - outer, cx + outer, cy + outer), start=40, end=320, fill=WHITE, width=thick)

# round caps on both ends of the arc
for ang in (40, 320):
    x = cx + mid_r * math.cos(math.radians(ang))
    y = cy + mid_r * math.sin(math.radians(ang))
    r = thick // 2
    d.ellipse((x - r, y - r, x + r, y + r), fill=WHITE)

# the companion: a dot sitting in the opening
dot_r = 54 * S
dx = cx + mid_r
d.ellipse((dx - dot_r, cy - dot_r, dx + dot_r, cy + dot_r), fill=WHITE)

img.resize((1024, 1024), Image.LANCZOS).save("build/icon.png")
print("wrote build/icon.png")

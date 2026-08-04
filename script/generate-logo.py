#!/usr/bin/env python
"""Generate the newhorse logo (horse-head mark) at all required sizes/formats.

Draws a stylized horse-head silhouette on a rounded-square badge with PIL and
writes: desktop resources/icons (png set, icon.ico, icns components), and the
app public favicons.
"""
import io
import os
import struct
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DESKTOP_ICONS = os.path.join(ROOT, "packages", "desktop", "resources", "icons")
APP_PUBLIC = os.path.join(ROOT, "packages", "app", "public")

BRAND = (34, 42, 66, 255)        # deep navy badge
MARK = (235, 239, 246, 255)      # near-white horse silhouette
ACCENT = (99, 122, 255, 255)     # accent for the muzzle/nostril detail

# Horse head side profile silhouette in a 0..100 coordinate space.
HORSE = [
    (56, 12), (50, 24), (30, 30), (16, 42), (8, 50), (4, 60), (14, 58),
    (24, 64), (34, 66), (46, 60), (56, 64), (66, 56), (74, 62), (78, 44),
    (72, 30), (66, 22), (62, 14),
]
EAR = [(56, 12), (50, 24), (60, 26), (62, 16)]


def render(size, mark_scale=0.62):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Rounded-square badge inset by a hair so edges are crisp.
    r = size // 5
    pad = max(2, size // 32)
    d.rounded_rectangle([pad, pad, size - pad, size - pad], radius=r, fill=BRAND)
    # Horse silhouette scaled/centered.
    cx = size / 2
    cy = size / 2
    s = size * mark_scale
    def pt(p):
        return (cx + (p[0] - 50) * s / 100, cy + (p[1] - 50) * s / 100)
    body = [pt(p) for p in HORSE]
    ear = [pt(p) for p in EAR]
    d.polygon(body, fill=MARK)
    d.polygon(ear, fill=MARK)
    # Nostril accent.
    d.ellipse([cx + s * -0.12, cy + s * 0.06, cx + s * -0.02, cy + s * 0.14], fill=ACCENT)
    return img


def save_png(img, path):
    img.save(path, "PNG")


def save_ico(img, path):
    # Single-size ICO from a 256px render.
    source = img if img.width >= 256 else render(256)
    source.resize((256, 256), Image.LANCZOS).save(path, "ICO", sizes=[(256, 256)])


def save_icns(base, sizes):
    # ICNS is a container of PNG chunks. ic07=128, ic08=256, ic09=512, ic10=1024.
    chunks = []
    for key, px in sizes:
        png = io.BytesIO()
        render(px).resize((px, px), Image.LANCZOS).save(png, "PNG")
        data = png.getvalue()
        chunks.append(key.encode("ascii") + struct.pack(">I", len(data) + 8) + data)
    body = b"".join(chunks)
    with open(base, "wb") as f:
        f.write(b"icns" + struct.pack(">I", len(body) + 8) + body)


def main():
    sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
    for px in sizes:
        save_png(render(px), os.path.join(DESKTOP_ICONS, f"{px}x{px}.png"))
    # The 2x variants the pipeline expects.
    save_png(render(128).resize((256, 256), Image.LANCZOS), os.path.join(DESKTOP_ICONS, "128x128@2x.png"))
    save_png(render(32).resize((64, 64), Image.LANCZOS), os.path.join(DESKTOP_ICONS, "64x64.png"))
    save_png(render(512), os.path.join(DESKTOP_ICONS, "icon.png"))
    save_ico(render(256), os.path.join(DESKTOP_ICONS, "icon.ico"))
    save_icns(os.path.join(DESKTOP_ICONS, "icon.icns"), [("ic07", 128), ("ic08", 256), ("ic09", 512), ("ic10", 1024)])
    # Windows Store square logos.
    for px in [30, 44, 71, 89, 107, 142, 150, 284, 310]:
        save_png(render(px), os.path.join(DESKTOP_ICONS, f"Square{px}x{px}Logo.png"))
    save_png(render(50), os.path.join(DESKTOP_ICONS, "StoreLogo.png"))
    save_png(render(128), os.path.join(DESKTOP_ICONS, "dock.png"))
    # App public favicons.
    save_png(render(16), os.path.join(APP_PUBLIC, "favicon-16x16.png"))
    save_png(render(32), os.path.join(APP_PUBLIC, "favicon-32x32.png"))
    save_png(render(96), os.path.join(APP_PUBLIC, "favicon-96x96.png"))
    save_png(render(96), os.path.join(APP_PUBLIC, "favicon-96x96-v3.png"))
    save_png(render(180), os.path.join(APP_PUBLIC, "apple-touch-icon.png"))
    save_png(render(180), os.path.join(APP_PUBLIC, "apple-touch-icon-v3.png"))
    save_ico(render(256), os.path.join(APP_PUBLIC, "favicon.ico"))
    save_ico(render(256), os.path.join(APP_PUBLIC, "favicon-v3.ico"))
    save_png(render(512), os.path.join(APP_PUBLIC, "social-share.png"))
    save_png(render(512), os.path.join(APP_PUBLIC, "social-share-zen.png"))
    # Write an SVG source too (used by index.html favicon.svg if referenced).
    with open(os.path.join(APP_PUBLIC, "favicon.svg"), "w") as f:
        f.write(_svg())
    with open(os.path.join(APP_PUBLIC, "favicon-v3.svg"), "w") as f:
        f.write(_svg())
    print("logo assets written")


def _svg():
    return """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="2" y="2" width="96" height="96" rx="20" fill="#222a42"/>
  <g fill="#ebeff6">
    <polygon points="56,12 50,24 30,30 16,42 8,50 4,60 14,58 24,64 34,66 46,60 56,64 66,56 74,62 78,44 72,30 66,22 62,14"/>
    <polygon points="56,12 50,24 60,26 62,16"/>
  </g>
  <ellipse cx="44" cy="60" rx="5" ry="4" fill="#637aff"/>
</svg>"""


if __name__ == "__main__":
    main()

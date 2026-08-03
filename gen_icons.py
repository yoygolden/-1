#!/usr/bin/env python
# 生成 SwimTrack 应用图标（卡通泳池蓝 + 白色波浪 + 气泡）
import math
from PIL import Image, ImageDraw, ImageFilter

OUT = "icons"

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

TOP = (56, 189, 248)     # #38bdf8
BOTTOM = (2, 132, 199)   # #0284c7
WHITE = (255, 255, 255)

def gradient(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = img.load()
    for y in range(size):
        t = y / (size - 1)
        col = lerp(TOP, BOTTOM, t)
        for x in range(size):
            px[x, y] = (col[0], col[1], col[2], 255)
    return img

def round_mask(size, radius_ratio=0.22):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    r = int(size * radius_ratio)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    return mask

def wave(draw, size, baseline, amp, wl, alpha, width=0):
    # 填充式波浪带：上沿为正弦，下沿到底部
    pts = []
    steps = 120
    for i in range(steps + 1):
        x = i / steps * size
        y = baseline + amp * math.sin((i / steps) * wl * 2 * math.pi)
        pts.append((x, y))
    pts.append((size, size))
    pts.append((0, size))
    draw.polygon(pts, fill=WHITE + (alpha,))

def bubbles(draw, size, specs):
    for (cx, cy, r, a) in specs:
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=WHITE + (a,))

def make_icon(size, rounded):
    img = gradient(size)
    d = ImageDraw.Draw(img)

    # 三道白色波浪（中心区域，留出安全边距）
    margin = size * 0.12
    top = size * 0.40
    wave(d, size, top, size * 0.05, 1.0, 230)
    wave(d, size, top + size * 0.13, size * 0.055, 1.3, 150)
    wave(d, size, top + size * 0.26, size * 0.06, 0.8, 90)

    # 气泡
    bubbles(d, size, [
        (size * 0.74, size * 0.22, size * 0.045, 200),
        (size * 0.84, size * 0.34, size * 0.030, 170),
        (size * 0.20, size * 0.24, size * 0.035, 180),
        (size * 0.30, size * 0.35, size * 0.022, 150),
    ])

    # 轻微高光（左上柔光）
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([0, 0, size * 0.7, size * 0.7], fill=(255, 255, 255, 38))
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.18))
    img = Image.alpha_composite(img, glow)

    if rounded:
        mask = round_mask(size)
        img.putalpha(mask)
    return img

import os
os.makedirs(OUT, exist_ok=True)
make_icon(192, rounded=True).save(f"{OUT}/icon-192.png")
make_icon(512, rounded=True).save(f"{OUT}/icon-512.png")
make_icon(512, rounded=False).save(f"{OUT}/icon-maskable-512.png")  # 全幅，内容居中在安全区
make_icon(180, rounded=False).save(f"{OUT}/apple-touch-icon.png")    # iOS 不需要透明圆角
print("icons generated:", os.listdir(OUT))

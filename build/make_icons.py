#!/usr/bin/env python3
"""从 build/logo-source.png 生成应用图标和应用内标识。

源图是品牌方给的 1254×1254 透明 PNG，里面有三个元素：
  - 左上：大号 W 标识（展示用）
  - 右上：白色圆角卡片 + W（应用图标）
  - 右下：紧凑 W（应用内标识）

本脚本只做裁切、留白和缩放，不重绘、不变形。需要 Pillow：
  python3 build/make_icons.py
"""
from pathlib import Path

from PIL import Image

here = Path(__file__).resolve().parent
src = Image.open(here / "logo-source.png").convert("RGBA")

# 应用图标：白色圆角卡片，四周留 7% 空白
card = src.crop((858, 276, 1183, 601))
canvas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
inner = card.resize((int(1024 * 0.86), int(1024 * 0.86)), Image.LANCZOS)
canvas.paste(inner, ((1024 - inner.width) // 2, (1024 - inner.height) // 2), inner)
canvas.save(here / "icon.png")
canvas.save(here / "icon.ico", sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])

# 应用内标识：右下角紧凑 W，透明底，正方形化后缩到 256
mark = src.crop((870, 730, 1200, 990))
mark = mark.crop(mark.getbbox())
pad = int(max(mark.size) * 0.06)
side = max(mark.size) + pad * 2
sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
sq.paste(mark, ((side - mark.width) // 2, (side - mark.height) // 2), mark)
sq.resize((256, 256), Image.LANCZOS).save(here.parent / "renderer" / "logo.png")

print("build/icon.png, build/icon.ico, renderer/logo.png 已更新")

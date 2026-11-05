"""1024 黑白圆角方图标，无文字。运行：python3 build/make_icon.py"""
from PIL import Image, ImageDraw

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角方，留出一点透明边，系统缩放时边缘干净
d.rounded_rectangle((48, 48, S - 49, S - 49), radius=210, fill=(0, 0, 0, 255))

# 左：请求。白底黑线
d.rounded_rectangle((196, 292, 494, 732), radius=40, fill=(255, 255, 255, 255))
for i, w in enumerate((168, 120, 196, 96)):
    y = 372 + i * 74
    d.rounded_rectangle((232, y, 232 + w, y + 18), radius=9, fill=(0, 0, 0, 255))

# 右：响应。黑底白框白线
d.rounded_rectangle((530, 292, 828, 732), radius=40, outline=(255, 255, 255, 255), width=16)
for i, w in enumerate((150, 200, 110, 170)):
    y = 372 + i * 74
    d.rounded_rectangle((566, y, 566 + w, y + 18), radius=9, fill=(255, 255, 255, 255))

img.save("build/icon.png")
img.resize((512, 512), Image.Resampling.LANCZOS).save("build/icon512.png")
img.save(
    "build/icon.ico",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("icon.png", img.size, "icon.ico")

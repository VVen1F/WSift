from PIL import Image, ImageDraw, ImageFilter

S = 1024
half = 412.0          # 内容 824
n = 5.0
cx = cy = S / 2

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
px = img.load()

# squircle 主体
for y in range(S):
    for x in range(S):
        dx = abs((x - cx) / half); dy = abs((y - cy) / half)
        if dx ** n + dy ** n <= 1.0:
            t = (y - (cy - half)) / (2 * half)
            px[x, y] = (int(56 - 26 * t), int(58 - 26 * t), int(64 - 28 * t), 255)

body = img.copy()
d = ImageDraw.Draw(body)

# 内部窗口
x0, y0, x1, y1 = 244, 340, 780, 684
d.rounded_rectangle((x0, y0, x1, y1), radius=30, fill=(255, 255, 255, 16))
d.rounded_rectangle((x0, y0, x1, y1), radius=30, outline=(255, 255, 255, 46), width=2)

mid = (x0 + x1) // 2
pad = 20

# 左：亮色请求面板
d.rounded_rectangle((x0 + pad, y0 + pad, mid - 10, y1 - pad), radius=16, fill=(250, 250, 252, 244))
for i, (w, a) in enumerate(((196, 235), (152, 170), (118, 120), (168, 96))):
    yy = y0 + 62 + i * 46
    d.rounded_rectangle((x0 + pad + 26, yy, x0 + pad + 26 + w, yy + 11), radius=5, fill=(24, 26, 32, a))

# 右：暗色响应面板
d.rounded_rectangle((mid + 10, y0 + pad, x1 - pad, y1 - pad), radius=16, fill=(255, 255, 255, 22))
for i, (w, a) in enumerate(((150, 190), (188, 120), (128, 90), (170, 70))):
    yy = y0 + 62 + i * 46
    d.rounded_rectangle((mid + 36, yy, mid + 36 + w, yy + 11), radius=5, fill=(255, 255, 255, a))

# 一处强调色：左面板顶部的细条
d.rounded_rectangle((x0 + pad + 26, y0 + 36, x0 + pad + 26 + 72, y0 + 42), radius=3, fill=(232, 131, 58, 230))

# 投影
shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
sd = ImageDraw.Draw(shadow)
sd.rounded_rectangle((186, 214, 838, 866), radius=196, fill=(0, 0, 0, 70))
shadow = shadow.filter(ImageFilter.GaussianBlur(34))

out = Image.alpha_composite(shadow, body)
out.save("build/icon.png")
out.resize((512, 512), Image.LANCZOS).save("build/icon512.png")
print("ok")

from PIL import Image
import os, glob

files = sorted(glob.glob('screenshots/emu_*.png'))
print("Found screenshots:", files)
if not files:
    files = sorted(glob.glob('screenshots/*.png'))
    print("Fallback:", files)

for f in files[-2:]:
    print("\n=====", f, "=====")
    im = Image.open(f)
    print("size", im.size, "mode", im.mode)
    im2 = im.convert('RGB')
    px = im2.load()
    w, h = im2.size
    for gy in range(5):
        y = int(h * gy / 4)
        row = []
        for gx in range(8):
            x = int(w * gx / 7)
            row.append(px[x, y])
        print("y=%d" % y, row)
    img_small = im2.resize((64, 64))
    colors = img_small.getcolors(64*64)
    print("distinct colors in 64x64:", len(colors))
    gray = im2.convert('L')
    hist = gray.histogram()
    total = w*h
    dark = sum(hist[:80])/total
    bright = sum(hist[180:])/total
    print("dark fraction: %.3f, bright fraction: %.3f" % (dark, bright))

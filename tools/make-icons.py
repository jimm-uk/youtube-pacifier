"""Make the extension's icons from a line drawing (no dependencies).

  python3 tools/make-icons.py SOURCE.png   # new drawing -> mark.png + icons
  python3 tools/make-icons.py              # rebuild icons from mark.png

SOURCE is dark lines on a light background (8-bit PNG; convert a JPEG
first, e.g. `sips -s format png in.jpeg --out in.png` on macOS). Outputs,
in extension/icons/:
  mark.png         the drawing as a transparent mask, used by the portal
  icon{16,32,48,128}.png  the drawing in light grey on a dark rounded square
"""
import struct
import sys
import zlib
from pathlib import Path

ICONS = Path(__file__).resolve().parent.parent / "extension" / "icons"
MARK = ICONS / "mark.png"
MARK_SIZE = 256
BG, FG = (38, 38, 36), (231, 229, 224)


# --- minimal PNG read/write -----------------------------------------------

def read_png(path):
    data = Path(path).read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    pos, idat, w = 8, b"", None
    while pos < len(data):
        n, kind = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + n]
        if kind == b"IHDR":
            w, h, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", body)
            assert depth == 8 and interlace == 0, "need 8-bit, non-interlaced"
        elif kind == b"IDAT":
            idat += body
        pos += 12 + n
    bpp = {0: 1, 2: 3, 4: 2, 6: 4}[ctype]
    raw, stride = zlib.decompress(idat), w * bpp
    rows, prev, i = [], bytearray(stride), 0
    for _ in range(h):
        f, line = raw[i], bytearray(raw[i + 1:i + 1 + stride])
        i += 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b, c = prev[x], prev[x - bpp] if x >= bpp else 0
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + b) & 255
            elif f == 3: line[x] = (line[x] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(line)
        prev = line
    return w, h, bpp, ctype, rows


def write_png(path, size, rgba):
    raw = b"".join(b"\x00" + bytes(rgba[y * size * 4:(y + 1) * size * 4]) for y in range(size))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    Path(path).write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
                           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


# --- image helpers (alpha planes as lists of floats 0..1) ------------------

def ink_alpha(path):
    """Dark lines -> opaque, light background -> transparent."""
    w, h, bpp, ctype, rows = read_png(path)
    out = []
    for row in rows:
        for x in range(w):
            if ctype in (0, 4):
                lum, a = row[x * bpp], (row[x * bpp + 1] if ctype == 4 else 255)
            else:
                r, g, b = row[x * bpp:x * bpp + 3]
                lum, a = 0.299 * r + 0.587 * g + 0.114 * b, (row[x * bpp + 3] if ctype == 6 else 255)
            ink = min(1.0, max(0.0, (255 - lum - 40) / 160))   # soft threshold
            out.append(ink * a / 255)
    return w, h, out


def crop_square(w, h, a, margin=0.08):
    xs = [i % w for i, v in enumerate(a) if v > 0.25]
    ys = [i // w for i, v in enumerate(a) if v > 0.25]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    side = int(max(x1 - x0, y1 - y0) * (1 + 2 * margin)) + 1
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    out = []
    for y in range(cy - side // 2, cy - side // 2 + side):
        for x in range(cx - side // 2, cx - side // 2 + side):
            out.append(a[y * w + x] if 0 <= x < w and 0 <= y < h else 0.0)
    return side, out


def resample(side, a, size):
    """Area-average downsample of a square plane."""
    out, k = [], side / size
    for ty in range(size):
        y0, y1 = int(ty * k), max(int(ty * k) + 1, int((ty + 1) * k))
        for tx in range(size):
            x0, x1 = int(tx * k), max(int(tx * k) + 1, int((tx + 1) * k))
            tot = sum(a[y * side + x] for y in range(y0, min(y1, side)) for x in range(x0, min(x1, side)))
            out.append(tot / ((min(y1, side) - y0) * (min(x1, side) - x0)))
    return out


def dilate(size, a, r):
    """Thicken lines by r pixels (round brush)."""
    if r <= 0:
        return a
    offs = [(dx, dy) for dy in range(-r, r + 1) for dx in range(-r, r + 1) if dx * dx + dy * dy <= r * r + r]
    return [max(a[(y + dy) * size + x + dx] for dx, dy in offs if 0 <= x + dx < size and 0 <= y + dy < size)
            for y in range(size) for x in range(size)]


# --- outputs ----------------------------------------------------------------

def make_mark(source):
    w, h, a = ink_alpha(source)
    side, sq = crop_square(w, h, a)
    m = resample(side, sq, MARK_SIZE)
    write_png(MARK, MARK_SIZE, [v for px in m for v in (0, 0, 0, round(px * 255))])
    print("wrote", MARK)


def load_mark():
    w, h, bpp, ctype, rows = read_png(MARK)
    assert ctype == 6 and w == h
    return w, [row[x * 4 + 3] / 255 for row in rows for x in range(w)]


def make_icon(size, side, mark):
    ss = 4                                   # supersampling
    n = size * ss
    inner = 0.88 if size <= 16 else 0.80     # share of the square the drawing fills
    d = round(n * inner)
    m = resample(side, mark, d)
    # Lines must stay visible at 16/32 px: thicken towards ~1.3 px.
    m = dilate(d, m, {16: 2, 32: 2, 48: 1}.get(size, 0))
    off = (n - d) // 2
    r = n * 0.22
    rgba = []
    for py in range(size):
        for px in range(size):
            cov = ink = 0.0
            for sy in range(ss):
                for sx in range(ss):
                    x, y = px * ss + sx + 0.5, py * ss + sy + 0.5
                    dx, dy = max(r - x, 0, x - (n - r)), max(r - y, 0, y - (n - r))
                    if dx * dx + dy * dy <= r * r:
                        cov += 1
                        mx, my = int(x) - off, int(y) - off
                        if 0 <= mx < d and 0 <= my < d:
                            ink += min(1.0, m[my * d + mx])
            if cov:
                t = ink / cov
                rgba += [round(BG[i] + (FG[i] - BG[i]) * t) for i in range(3)] + [round(cov / ss / ss * 255)]
            else:
                rgba += [0, 0, 0, 0]
    write_png(ICONS / f"icon{size}.png", size, rgba)
    print("wrote", ICONS / f"icon{size}.png")


if __name__ == "__main__":
    ICONS.mkdir(parents=True, exist_ok=True)
    if len(sys.argv) > 1:
        make_mark(sys.argv[1])
    side, mark = load_mark()
    for s in (16, 32, 48, 128):
        make_icon(s, side, mark)

"""Draw the extension's icons (no dependencies): a soft play symbol on a
dark rounded square. Run: python3 tools/make-icons.py"""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
BG, FG = (38, 38, 36), (231, 229, 224)


def png(size):
    ss = 4  # supersampling for smooth edges
    n = size * ss
    r = n * 0.22
    # Play triangle, optically centred
    ax, ay = n * 0.38, n * 0.28
    bx, by = n * 0.38, n * 0.72
    cx, cy = n * 0.74, n * 0.50

    def inside_rr(x, y):
        dx = max(r - x, 0, x - (n - r))
        dy = max(r - y, 0, y - (n - r))
        return dx * dx + dy * dy <= r * r

    def inside_tri(x, y):
        def s(px, py, qx, qy):
            return (x - qx) * (py - qy) - (px - qx) * (y - qy)
        d1, d2, d3 = s(ax, ay, bx, by), s(bx, by, cx, cy), s(cx, cy, ax, ay)
        return not ((d1 < 0 or d2 < 0 or d3 < 0) and (d1 > 0 or d2 > 0 or d3 > 0))

    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    x, y = px * ss + sx + 0.5, py * ss + sy + 0.5
                    if inside_rr(x, y):
                        c = FG if inside_tri(x, y) else BG
                        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; acc[3] += 255
            k = ss * ss
            a = acc[3] / k
            row += bytes([int(acc[0] / max(1, acc[3] / 255)), int(acc[1] / max(1, acc[3] / 255)),
                          int(acc[2] / max(1, acc[3] / 255)), int(a)])
        rows.append(bytes(row))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b""))


OUT.mkdir(parents=True, exist_ok=True)
for s in (16, 32, 48, 128):
    (OUT / f"icon{s}.png").write_bytes(png(s))
    print("wrote", OUT / f"icon{s}.png")

// 生成 Ezlearn 图标（.ico，含 16/32/48/256 四种尺寸）：深蓝圆角方块 + 白色 "E"。纯代码绘制，不依赖图片文件。
import fs from 'node:fs';

const BG = [0x2f, 0x5d, 0x8a];
const FG = [0xff, 0xff, 0xff];

function inside(x, y) {
  // 坐标都在 0..1 之间；返回 0 = 透明，1 = 底色，2 = 字
  const m = 0.04;
  const r = 0.2;
  if (x < m || x > 1 - m || y < m || y > 1 - m) return 0;
  const cx = Math.min(Math.max(x, m + r), 1 - m - r);
  const cy = Math.min(Math.max(y, m + r), 1 - m - r);
  if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return 0;
  const inRect = (x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  if (inRect(0.3, 0.22, 0.43, 0.78) || inRect(0.3, 0.22, 0.72, 0.34) || inRect(0.3, 0.44, 0.66, 0.56) || inRect(0.3, 0.66, 0.72, 0.78)) return 2;
  return 1;
}

function image(size) {
  const ss = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = 0; let f = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const v = inside((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
        if (v) a++;
        if (v === 2) f++;
      }
      const t = a ? f / a : 0;
      const rgb = BG.map((b, i) => Math.round(b * (1 - t) + FG[i] * t));
      const row = size - 1 - y; // BMP 自下而上
      const o = (row * size + x) * 4;
      px[o] = rgb[2]; px[o + 1] = rgb[1]; px[o + 2] = rgb[0]; px[o + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(px.length, 20);
  const maskRow = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, px, Buffer.alloc(maskRow * size)]);
}

export function makeIcon(out) {
  const sizes = [16, 32, 48, 256];
  const imgs = sizes.map(image);
  const dir = Buffer.alloc(6 + 16 * sizes.length);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(sizes.length, 4);
  let offset = dir.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    dir.writeUInt8(s === 256 ? 0 : s, e);
    dir.writeUInt8(s === 256 ? 0 : s, e + 1);
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(imgs[i].length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += imgs[i].length;
  });
  fs.writeFileSync(out, Buffer.concat([dir, ...imgs]));
}

if (process.argv[2]) makeIcon(process.argv[2]);

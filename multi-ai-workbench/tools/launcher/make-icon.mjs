/**
 * 生成启动器图标 tools/launcher/app.ico（32x32，32 位带 Alpha）。
 *
 * 用 Node 而不是 PowerShell：ICO 是二进制格式，手写字节用 JS 的 Buffer 直观得多，
 * 也不会踩 PowerShell 5.1 那堆语法解析的坑。
 *
 * 图形：深色圆角底 + 三根品牌色柱子（DeepSeek 蓝紫 / 豆包 蓝绿 / Kimi 灰紫），
 * 一眼能认出是"三窗并发"。
 *
 * 用法： node tools/launcher/make-icon.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 32;
const RADIUS = 7;
const BG = [15, 19, 32];
/** 三根柱子的颜色 + 左右边界 */
const BARS = [
  { color: [91, 124, 250], from: 6, to: 11 },
  { color: [20, 184, 196], from: 13, to: 18 },
  { color: [139, 123, 216], from: 20, to: 25 },
];
const BAR_BOTTOM = 24;

const pixels = Buffer.alloc(SIZE * SIZE * 4);

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    // 圆角遮罩：把四个角切掉
    let alpha = 255;
    const nearestX = Math.min(Math.max(x, RADIUS), SIZE - 1 - RADIUS);
    const nearestY = Math.min(Math.max(y, RADIUS), SIZE - 1 - RADIUS);
    if (nearestX !== x || nearestY !== y) {
      const distance = Math.hypot(x - nearestX, y - nearestY);
      if (distance > RADIUS) alpha = 0;
    }

    let color = BG;
    for (let index = 0; index < BARS.length; index += 1) {
      const bar = BARS[index];
      const top = 7 + index * 3; // 左高右低的阶梯，像柱状图
      if (x >= bar.from && x <= bar.to && y >= top && y <= BAR_BOTTOM) color = bar.color;
    }

    // ICO 里的像素是自下而上、BGRA 顺序
    const offset = ((SIZE - 1 - y) * SIZE + x) * 4;
    pixels[offset] = color[2];
    pixels[offset + 1] = color[1];
    pixels[offset + 2] = color[0];
    pixels[offset + 3] = alpha;
  }
}

const andMask = Buffer.alloc(Math.ceil((SIZE * SIZE) / 8)); // 32 位图标用不到，但格式要求有

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type = icon
header.writeUInt16LE(1, 4); // 只放一张图

const entry = Buffer.alloc(16);
entry[0] = SIZE; // 宽
entry[1] = SIZE; // 高
entry[2] = 0; // 调色板颜色数（32 位图为 0）
entry[3] = 0; // reserved
entry.writeUInt16LE(1, 4); // color planes
entry.writeUInt16LE(32, 6); // bits per pixel
entry.writeUInt32LE(40 + pixels.length + andMask.length, 8);
entry.writeUInt32LE(22, 12); // 数据偏移 = 6 + 16

const bitmapInfo = Buffer.alloc(40);
bitmapInfo.writeUInt32LE(40, 0);
bitmapInfo.writeInt32LE(SIZE, 4);
bitmapInfo.writeInt32LE(SIZE * 2, 8); // 高度写 2 倍，是 ICO 的老约定
bitmapInfo.writeUInt16LE(1, 12);
bitmapInfo.writeUInt16LE(32, 14);
bitmapInfo.writeUInt32LE(pixels.length + andMask.length, 20);

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'app.ico');
fs.writeFileSync(out, Buffer.concat([header, entry, bitmapInfo, pixels, andMask]));
console.log(`已生成 ${out}（${fs.statSync(out).size} 字节）`);
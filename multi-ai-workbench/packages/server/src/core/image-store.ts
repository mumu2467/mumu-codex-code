/**
 * 图片落盘：把前端压缩后的 base64 data URL（或 multipart 上传的二进制）
 * 写成 <uploadDir>/<YYYY-MM-DD>/<id>.<ext>，并返回可直接访问的 /uploads URL。
 *
 * 设计取舍：图片只存 URL 不存进 DB，避免 DB 体积膨胀与 WS 带宽浪费。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { newId } from '../utils/ids.js';

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
};

export interface StoredImage {
  /** 可直接放进 <img src> 的站内路径，如 /uploads/2026-10-12/abc.webp */
  url: string;
  /** 服务器本地绝对路径，供 Playwright 做文件上传 */
  path: string;
  mime: string;
  size: number;
  name: string;
}

const DATA_URL_RE = /^data:([a-zA-Z0-9.+/-]+)(?:;[^,]*)?,(.*)$/s;

export class ImageStore {
  constructor(private readonly uploadDir: string) {}

  /** 解析并保存 data URL；非法输入直接抛错（路由层转 400） */
  async saveDataUrl(dataUrl: string, nameHint = 'image'): Promise<StoredImage> {
    const match = DATA_URL_RE.exec(dataUrl.trim());
    if (!match) throw new Error('图片格式非法：期望 data:image/...;base64,... 形式的 data URL');

    const mime = match[1]!.toLowerCase();
    const payload = match[2]!;
    if (!mime.startsWith('image/')) throw new Error(`不支持的内容类型：${mime}`);

    const isBase64 = /;base64/i.test(dataUrl.slice(0, dataUrl.indexOf(',')));
    const buffer = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
    return this.saveBuffer(buffer, mime, nameHint);
  }

  /**
   * 由站内 URL 反查本地文件（重试 / Playwright 重新上传时需要本地路径）。
   * URL 形如 /uploads/2026-10-12/xxx.png，非 /uploads 开头的（例如外链）返回 undefined。
   */
  fromUrl(url: string): StoredImage | undefined {
    if (!url.startsWith('/uploads/')) return undefined;
    const relative = url.slice('/uploads/'.length);
    // 防目录穿越：解析后必须仍在上传目录内
    const absolute = path.resolve(this.uploadDir, relative);
    if (!absolute.startsWith(path.resolve(this.uploadDir))) return undefined;
    const ext = path.extname(absolute).toLowerCase();
    const mime = Object.entries(MIME_EXT).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream';
    return {
      url: path.posix.join('/uploads', relative.split(path.sep).join('/')),
      path: absolute,
      mime,
      size: 0,
      name: path.basename(absolute),
    };
  }

  async saveBuffer(buffer: Buffer, mime: string, name: string): Promise<StoredImage> {
    const normalized = mime.toLowerCase().split(';')[0]!.trim();
    const ext = MIME_EXT[normalized] ?? '.bin';
    // 用本地日期分目录（toISOString 是 UTC，凌晨会与 UI 显示差一天）
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const dir = path.join(this.uploadDir, day);
    await fs.mkdir(dir, { recursive: true });

    const fileName = `${newId('img')}${ext}`;
    const absolute = path.join(dir, fileName);
    await fs.writeFile(absolute, buffer);

    return {
      // URL 一律用正斜杠，避免 Windows 反斜杠进入 HTML
      url: path.posix.join('/uploads', day, fileName),
      path: absolute,
      mime: normalized,
      size: buffer.byteLength,
      name: name || fileName,
    };
  }
}
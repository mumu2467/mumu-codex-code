/**
 * 图片压缩：拖拽/粘贴/选择进来的图片，统一在浏览器侧压到长边 <= 1568、
 * 输出 webp（不支持时回退 jpeg），再转成 data URL 发给后端。
 * 这样即使原图是 8MB 的手机照片，落到后端也只有几百 KB。
 */

export interface PendingImage {
  id: string;
  name: string;
  /** 压缩后的 data URL，直接可放进 <img src> 预览，也可直接发给后端 */
  dataUrl: string;
  /** 压缩后字节数 */
  size: number;
  originalSize: number;
  width: number;
  height: number;
}

export interface CompressOptions {
  /** 长边上限，默认 1568（多数多模态模型的最优输入尺寸附近） */
  maxEdge?: number;
  /** 编码质量，默认 0.82 */
  quality?: number;
}

const MAX_ACCEPTED_BYTES = 25 * 1024 * 1024;

function newId(): string {
  return `img_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/** data URL 的字节数（base64 部分换算） */
function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 0;
  const payload = dataUrl.slice(comma + 1);
  return Math.floor((payload.length * 3) / 4);
}

export async function compressImage(file: File, options: CompressOptions = {}): Promise<PendingImage> {
  const { maxEdge = 1568, quality = 0.82 } = options;

  if (!file.type.startsWith('image/')) {
    throw new Error(`「${file.name}」不是图片文件`);
  }
  if (file.size > MAX_ACCEPTED_BYTES) {
    throw new Error(`「${file.name}」超过 25MB，请先裁剪`);
  }

  const bitmap = await loadBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器不支持 canvas 2d，无法压缩图片');
  ctx.drawImage(bitmap, 0, 0, width, height);
  if ('close' in bitmap) bitmap.close();

  // 优先 webp；若浏览器不支持，toDataURL 会悄悄返回 png，此时改用 jpeg
  let dataUrl = canvas.toDataURL('image/webp', quality);
  if (!dataUrl.startsWith('data:image/webp')) {
    dataUrl = canvas.toDataURL('image/jpeg', quality);
  }

  return {
    id: newId(),
    name: file.name || 'pasted-image',
    dataUrl,
    size: dataUrlBytes(dataUrl),
    originalSize: file.size,
    width,
    height,
  };
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      /* 某些格式（如部分 HEIC）会失败，走 <img> 兜底 */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`无法解码图片「${file.name}」`));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 从粘贴事件里挑出图片文件 */
export function imageFilesFromClipboard(event: ClipboardEvent): File[] {
  const items = event.clipboardData?.items;
  if (!items) return [];
  const files: File[] = [];
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}

/** 从拖拽事件里挑出图片文件（含拖进来的文件目录浏览器已展开为文件列表） */
export function imageFilesFromDataTransfer(dt: DataTransfer): File[] {
  return Array.from(dt.files).filter((f) => f.type.startsWith('image/'));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
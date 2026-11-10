// 把 PDF 的某一页、或上传的图片，渲染成适合给视觉模型看的 JPEG（质量 85：字和下标都清楚，体积约为 PNG 的 1/4）。
// 安全：pdf.js 禁用 eval；输出尺寸有上限（防超大页面耗尽内存）；图片一律重新解码再编码，
// 不把原始字节（可能带 EXIF、GPS 等元数据或畸形数据）直接发给模型。
import { createRequire } from 'node:module';

export const IMAGE_TYPE = 'image/jpeg';
const JPEG_QUALITY = 85;

const require = createRequire(import.meta.url);
let canvasMod = null;
function canvasLib() {
  if (!canvasMod) canvasMod = require('@napi-rs/canvas');
  return canvasMod;
}

export const MAX_SIDE = 1568; // 长边像素：手写字够清楚，图片 token 也不会太多
const MAX_PIXELS = 1568 * 1568;

function fitScale(w, h, maxSide = MAX_SIDE) {
  let s = Math.min(maxSide / Math.max(w, h), 4);
  if (w * h * s * s > MAX_PIXELS) s = Math.sqrt(MAX_PIXELS / (w * h));
  return s;
}

/** 打开一份 PDF，返回 { pages, render(n) → JPEG Buffer, close() }。 */
export async function openPdf(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf), isEvalSupported: false, enableXfa: false, stopAtErrors: false, verbosity: 0,
  });
  const doc = await task.promise;
  const { createCanvas } = canvasLib();
  return {
    pages: doc.numPages,
    async render(n) {
      const page = await doc.getPage(n);
      try {
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: fitScale(base.width, base.height) });
        const canvas = createCanvas(Math.max(1, Math.ceil(vp.width)), Math.max(1, Math.ceil(vp.height)));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        // 连同批注层一起画：老师用 PDF 批注工具写的手写笔迹也要看得到
        await page.render({ canvas, canvasContext: ctx, viewport: vp, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
        return canvas.toBuffer('image/jpeg', JPEG_QUALITY);
      } finally {
        page.cleanup();
      }
    },
    close: () => task.destroy(),
  };
}

/** 上传的图片（PNG / JPEG）：缩到合适大小、去掉元数据，重新编码成 JPEG。 */
export async function normalizeImage(buf) {
  const { createCanvas, loadImage } = canvasLib();
  const img = await loadImage(buf);
  if (!img.width || !img.height) throw Object.assign(new Error('图片无法解码'), { status: 415 });
  const s = Math.min(1, fitScale(img.width, img.height));
  const canvas = createCanvas(Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s)));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toBuffer('image/jpeg', JPEG_QUALITY);
}

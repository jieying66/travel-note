// ============================================================
// 素材仓库（IndexedDB）
//
// 为什么不用 localStorage：它只有 5–10MB，一张手机照片就三五兆。
// IndexedDB 能存到几个 G，够一趟旅行的照片和视频。
//
// 存两份：
//   blobs  —— 原始文件（导出时用，保画质）
//   thumbs —— 缩略图（列表里显示，加载快、省内存）
//
// 照片会压到长边 1600px 再存缩略图；原图另存。
// 手机原图一张两千万像素，直接往界面上堆几张就把内存撑爆了。
// ============================================================

const DB_NAME = "travel-note";
const DB_VERSION = 1;
const STORE_BLOB = "blobs";
const STORE_THUMB = "thumbs";

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_BLOB)) db.createObjectStore(STORE_BLOB);
      if (!db.objectStoreNames.contains(STORE_THUMB)) db.createObjectStore(STORE_THUMB);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let req;
        try {
          req = fn(s);
        } catch (e) {
          reject(e);
          return;
        }
        // 一定要取 req.result，不能回退成 req 本身 ——
        // 数据不存在时 result 就是 undefined，而 req 对象是真值，
        // 回退会让调用方的 if (!blob) 判断永远不成立，坏对象被当成素材用。
        t.oncomplete = () => resolve(req ? req.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

export function putBlob(id, blob) {
  return tx(STORE_BLOB, "readwrite", (s) => s.put(blob, id));
}

/** 找不到时返回 undefined */
export function getBlob(id) {
  return tx(STORE_BLOB, "readonly", (s) => s.get(id));
}

export function putThumb(id, blob) {
  return tx(STORE_THUMB, "readwrite", (s) => s.put(blob, id));
}

/** 找不到时返回 undefined */
export function getThumb(id) {
  return tx(STORE_THUMB, "readonly", (s) => s.get(id));
}

export async function deleteMedia(id) {
  await tx(STORE_BLOB, "readwrite", (s) => s.delete(id));
  await tx(STORE_THUMB, "readwrite", (s) => s.delete(id));
}

/** 估算占用空间（浏览器给的是整站配额，够用来提示用户） */
export async function storageEstimate() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage: usage || 0, quota: quota || 0 };
  } catch {
    return null;
  }
}

export function formatBytes(n) {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ---------- 图片处理 ----------

/**
 * 读 EXIF 拍摄时间。
 * 只解析 JPEG 的 DateTimeOriginal，够用了 —— 安卓默认拍 JPEG。
 * 读不到返回 null，调用方回退到文件的 lastModified。
 */
export function readShotAt(file) {
  return new Promise((resolve) => {
    // 只读头部 128KB，EXIF 一定在这个范围内，避免整个文件进内存
    const slice = file.slice(0, 131072);
    const fr = new FileReader();
    fr.onload = () => {
      try {
        resolve(parseExifDate(new DataView(fr.result)));
      } catch {
        resolve(null);
      }
    };
    fr.onerror = () => resolve(null);
    fr.readAsArrayBuffer(slice);
  });
}

function parseExifDate(view) {
  if (view.byteLength < 4) return null;
  if (view.getUint16(0) !== 0xffd8) return null; // 不是 JPEG

  let offset = 2;
  while (offset + 4 < view.byteLength) {
    if (view.getUint8(offset) !== 0xff) break;
    const marker = view.getUint8(offset + 1);
    const size = view.getUint16(offset + 2);

    if (marker === 0xe1) {
      // APP1 段，检查 "Exif\0\0"
      const start = offset + 4;
      if (
        view.getUint32(start) === 0x45786966 &&
        view.getUint16(start + 4) === 0x0000
      ) {
        return readTiffDate(view, start + 6);
      }
    }
    if (marker === 0xda) break; // 到图像数据了
    offset += 2 + size;
  }
  return null;
}

function readTiffDate(view, tiffStart) {
  const endian = view.getUint16(tiffStart);
  const little = endian === 0x4949;
  const u16 = (o) => view.getUint16(o, little);
  const u32 = (o) => view.getUint32(o, little);

  if (u16(tiffStart + 2) !== 0x002a) return null;
  const ifd0 = tiffStart + u32(tiffStart + 4);

  // 先在 IFD0 找 ExifIFD 指针（0x8769）
  let exifIfd = null;
  const n0 = u16(ifd0);
  for (let i = 0; i < n0; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (u16(entry) === 0x8769) {
      exifIfd = tiffStart + u32(entry + 8);
      break;
    }
  }

  // DateTimeOriginal(0x9003) 在 ExifIFD；退而求其次用 IFD0 的 DateTime(0x0132)
  for (const [ifd, tag] of [
    [exifIfd, 0x9003],
    [ifd0, 0x0132],
  ]) {
    if (!ifd || ifd + 2 > view.byteLength) continue;
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const entry = ifd + 2 + i * 12;
      if (u16(entry) !== tag) continue;
      const len = u32(entry + 4);
      const valOff = len > 4 ? tiffStart + u32(entry + 8) : entry + 8;
      let s = "";
      for (let k = 0; k < Math.min(len, 20); k++) {
        const c = view.getUint8(valOff + k);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      // "2026:03:15 14:30:22"
      const m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
      if (m) {
        const [, y, mo, d, h, mi, se] = m.map(Number);
        return new Date(y, mo - 1, d, h, mi, se).getTime();
      }
    }
  }
  return null;
}

/**
 * 压缩图片。
 * maxEdge 是长边上限，超过就等比缩小；小于就原样返回（不放大、不重新编码）。
 * 用 createImageBitmap 而不是 <img>，它在后台线程解码，不阻塞界面。
 */
export async function compressImage(file, maxEdge = 1600, quality = 0.85) {
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return { blob: file, width: 0, height: 0 }; // 解不开就原样存，别丢用户数据
  }
  const { width: w, height: h } = bmp;
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));

  if (scale >= 1 && file.type === "image/jpeg") {
    bmp.close?.();
    return { blob: file, width: w, height: h };
  }

  const canvas = document.createElement("canvas");
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0, tw, th);
  bmp.close?.();

  const blob = await new Promise((res) =>
    canvas.toBlob(res, "image/jpeg", quality)
  );
  return { blob: blob || file, width: tw, height: th, origWidth: w, origHeight: h };
}

/** 视频首帧当封面。取不到就返回 null，界面显示占位。 */
export function videoThumb(file, maxEdge = 800) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "metadata";

    const done = (out) => {
      URL.revokeObjectURL(url);
      v.removeAttribute("src");
      resolve(out);
    };
    const timer = setTimeout(() => done(null), 8000); // 别无限等

    v.onloadeddata = () => {
      // 跳到 0.1 秒，避免某些视频首帧是黑的
      v.currentTime = Math.min(0.1, (v.duration || 1) / 10);
    };
    v.onseeked = () => {
      clearTimeout(timer);
      const w = v.videoWidth;
      const h = v.videoHeight;
      if (!w || !h) return done(null);
      const scale = Math.min(1, maxEdge / Math.max(w, h));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      canvas.getContext("2d").drawImage(v, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) =>
          done({ blob, width: w, height: h, duration: v.duration || 0 }),
        "image/jpeg",
        0.8
      );
    };
    v.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
    v.src = url;
  });
}

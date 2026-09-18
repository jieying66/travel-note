// ============================================================
// 导出给豆包
//
// 核心是顺序不能乱。两道保险：
//   1. 文件名带补零序号（01、02 … 10），不补零的话很多工具会把
//      第 10 张排到第 2 张前面 —— 这是最常见的顺序错乱原因。
//   2. 附一份文案文件，写清每张照片属于哪天、哪个地点、哪段想法。
//
// 按天分段导出，不是整趟一大包：
//   一是大压缩包在手机上下载容易断，
//   二是豆包这类工具对一次能放多少张照片通常有上限。
// ============================================================

import * as store from "./store.js";
import * as media from "./media.js";
import { STOP_TYPE, TRANSPORT, formatDateCN, stopTimeLabel } from "./model.js";
import { sheet, toast, ok, err, esc, h, button, busy } from "./ui.js";

/** 序号补零。位数按总数决定：99 个用两位，100 个用三位。 */
function pad(n, total) {
  const width = Math.max(2, String(total).length);
  return String(n).padStart(width, "0");
}

function safe(s) {
  return String(s || "")
    .replace(/[\/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, "")
    .slice(0, 20);
}

/** 打开导出面板 */
export function exportTrip(trip) {
  const s = sheet({ title: "导出给豆包" });

  const dayRows = trip.days
    .map((d) => {
      const stops = store.stopsOfDay(trip, d.id);
      const n = stops.reduce((a, x) => a + (x.media || []).length, 0);
      return { day: d, stops, count: n };
    })
    .filter((r) => r.count > 0 || r.stops.length > 0);

  const total = dayRows.reduce((a, r) => a + r.count, 0);

  if (!total) {
    s.body.appendChild(
      h("div", { class: "hint", style: "margin:0", text: "还没有照片或视频。先加些素材再导出。" })
    );
    return;
  }

  s.body.appendChild(
    h("div", {
      class: "hint",
      style: "margin:0 0 14px",
      text: `一共 ${total} 个素材。建议一天导一段，做出来的视频节奏更好，也不容易超出豆包的数量限制。`,
    })
  );

  // 整趟
  s.body.appendChild(
    row("整趟一次导完", `${total} 个素材`, async () => {
      s.close();
      await runExport(trip, null);
    })
  );

  // 按天
  for (const r of dayRows) {
    if (!r.count) continue;
    s.body.appendChild(
      row(
        `第 ${r.day.day} 天`,
        `${formatDateCN(r.day.date)} · ${r.stops.length} 个地点 · ${r.count} 个素材`,
        async () => {
          s.close();
          await runExport(trip, r.day.day);
        }
      )
    );
  }

  // 只要文案
  s.body.appendChild(
    row("只复制文案", "不含照片，直接粘贴到豆包", () => {
      const text = buildScript(trip, null);
      copyText(text);
      s.close();
    })
  );

  function row(title, desc, fn) {
    const b = h(
      "button",
      { class: "result", style: "padding:14px 4px" },
      h("div", { class: "nm", text: title }),
      h("div", { class: "ad", text: desc })
    );
    b.onclick = fn;
    return b;
  }
}

/**
 * 生成压缩包。
 * dayNum 传 null 是整趟，传数字是只导那一天。
 */
async function runExport(trip, dayNum) {
  const JSZip = window.JSZip;
  if (!JSZip) {
    err("打包库没加载成功");
    return;
  }

  const b = busy("正在打包…");
  try {
    const zip = new JSZip();
    const days = dayNum == null ? trip.days : trip.days.filter((d) => d.day === dayNum);

    // 先数总数，序号要用它决定补零位数
    let total = 0;
    for (const d of days) {
      for (const st of store.stopsOfDay(trip, d.id)) total += (st.media || []).length;
    }
    if (!total) {
      b.done();
      err("这一天还没有素材");
      return;
    }

    let seq = 0;
    let done = 0;
    const missing = [];

    for (const d of days) {
      const stops = store.stopsOfDay(trip, d.id);
      for (let si = 0; si < stops.length; si++) {
        const st = stops[si];
        const items = st.media || [];
        for (let mi = 0; mi < items.length; mi++) {
          const m = items[mi];
          seq++;
          b.set((done / total) * 100, `打包 ${done + 1} / ${total}`);

          const blob = await media.getBlob(m.id);
          if (!blob) {
            missing.push(`${st.name} 第${mi + 1}个`);
            continue;
          }

          // 文件名就是顺序保证：序号_第几天_第几站_地点名
          const ext = m.kind === "video" ? guessVideoExt(m) : "jpg";
          const fname =
            `${pad(seq, total)}_` +
            `D${pad(d.day, days.length)}` +
            `-${pad(si + 1, stops.length)}` +
            `_${safe(st.name)}` +
            `.${ext}`;

          zip.file(fname, blob);
          done++;
        }
      }
    }

    // 文案
    const script = buildScript(trip, dayNum);
    zip.file("文案.txt", script);
    zip.file("照片清单.txt", buildManifest(trip, dayNum, total));

    b.set(100, "正在压缩…");
    const out = await zip.generateAsync(
      { type: "blob", compression: "STORE" }, // 照片已压过，再压没意义还慢
      (meta) => b.set(Math.min(99, meta.percent), "正在压缩…")
    );

    const label = dayNum == null ? "全程" : `第${dayNum}天`;
    downloadBlob(out, `${safe(trip.name)}-${label}-${done}个素材.zip`);
    b.done();

    if (missing.length) {
      err(`有 ${missing.length} 个素材文件丢了，其余已导出`);
    } else {
      ok(`导出 ${done} 个素材`);
    }

    // 顺手把文案也放到剪贴板，省一步
    copyText(script, false);
    showAfterExport(label, done);
  } catch (e) {
    b.done();
    console.error(e);
    err("打包失败：" + e.message);
  }
}

function guessVideoExt(m) {
  const mime = String(m.mime || "");
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("quicktime")) return "mov";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("3gpp")) return "3gp";
  const dot = String(m.name || "").lastIndexOf(".");
  if (dot > 0) return m.name.slice(dot + 1).toLowerCase().slice(0, 5);
  return "mp4";
}

/**
 * 文案。给豆包读的，也给你自己核对顺序用。
 * 每个地点写清是第几天第几站、想法原文、对应哪几个文件。
 */
function buildScript(trip, dayNum) {
  const days = dayNum == null ? trip.days : trip.days.filter((d) => d.day === dayNum);
  const lines = [];

  lines.push(`《${trip.name}》`);
  lines.push(`${trip.startDate} 至 ${trip.endDate}`);
  if (trip.description) lines.push(trip.description);
  lines.push("");
  lines.push("─".repeat(28));
  lines.push("");

  let seq = 0;
  let total = 0;
  for (const d of days) {
    for (const st of store.stopsOfDay(trip, d.id)) total += (st.media || []).length;
  }

  for (const d of days) {
    const stops = store.stopsOfDay(trip, d.id);
    if (!stops.length) continue;

    lines.push(`【第 ${d.day} 天】${formatDateCN(d.date)}`);
    lines.push("");

    for (let si = 0; si < stops.length; si++) {
      const st = stops[si];
      const meta = STOP_TYPE[st.type] || STOP_TYPE.other;
      // 有时间就写在地点名前面，做视频时能体现节奏
      const tl = stopTimeLabel(st);
      const timePrefix = tl
        ? tl.kind === "range"
          ? `${tl.text}　`
          : `${tl.text} 开始　`
        : "";
      lines.push(`${si + 1}. ${timePrefix}${st.name}　${meta.icon}${meta.label}`);

      if (st.note) {
        lines.push(`   ${st.note.replace(/\n/g, "\n   ")}`);
      }

      const items = st.media || [];
      if (items.length) {
        const names = [];
        for (let mi = 0; mi < items.length; mi++) {
          seq++;
          const m = items[mi];
          const ext = m.kind === "video" ? guessVideoExt(m) : "jpg";
          names.push(
            `${pad(seq, total)}_D${pad(d.day, days.length)}-${pad(si + 1, stops.length)}_${safe(st.name)}.${ext}`
          );
        }
        lines.push(`   素材：${items.length} 个（${names[0]}${names.length > 1 ? ` … ${names[names.length - 1]}` : ""}）`);
      }

      // 到下一站怎么去的
      if (si + 1 < stops.length) {
        const seg = store.getSegment(trip, st.id, stops[si + 1].id);
        const t = TRANSPORT[seg?.transport] || TRANSPORT.car;
        lines.push(`   ↓ ${t.icon} ${t.label}`);
      }
      lines.push("");
    }
    lines.push("");
  }

  lines.push("─".repeat(28));
  lines.push("说明：照片文件名开头的数字就是顺序，按文件名排序即可。");
  lines.push("D 后面是第几天，横线后面是那天的第几站。");

  return lines.join("\n");
}

/** 一行一个文件的清单，方便核对 */
function buildManifest(trip, dayNum, total) {
  const days = dayNum == null ? trip.days : trip.days.filter((d) => d.day === dayNum);
  const rows = ["序号\t文件名\t第几天\t第几站\t地点\t安排时间\t拍摄时间"];
  let seq = 0;
  for (const d of days) {
    const stops = store.stopsOfDay(trip, d.id);
    for (let si = 0; si < stops.length; si++) {
      const st = stops[si];
      for (const m of st.media || []) {
        seq++;
        const ext = m.kind === "video" ? guessVideoExt(m) : "jpg";
        const fname = `${pad(seq, total)}_D${pad(d.day, days.length)}-${pad(si + 1, stops.length)}_${safe(st.name)}.${ext}`;
        rows.push(
          [
            pad(seq, total),
            fname,
            `第${d.day}天`,
            `第${si + 1}站`,
            st.name,
            stopTimeLabel(st)?.text || "",
            m.shotAt ? new Date(m.shotAt).toLocaleString("zh-CN") : "未知",
          ].join("\t")
        );
      }
    }
  }
  return rows.join("\n");
}

/** 复制到剪贴板。silent 时不弹提示。 */
export async function copyText(text, notify = true) {
  try {
    await navigator.clipboard.writeText(text);
    if (notify) ok("文案已复制，去豆包粘贴");
    return true;
  } catch {
    // 手机浏览器有时不给剪贴板权限，退回手动复制
    if (notify) showCopyFallback(text);
    return false;
  }
}

function showCopyFallback(text) {
  const s = sheet({ title: "手动复制文案" });
  const ta = h("textarea", { class: "textarea", style: "min-height:220px" });
  ta.value = text;
  s.body.appendChild(h("div", { class: "hint", style: "margin:0 0 8px", text: "长按全选复制" }));
  s.body.appendChild(ta);
  setTimeout(() => {
    ta.focus();
    ta.select();
  }, 300);
}

/** 导出完成后的下一步提示 */
function showAfterExport(label, count) {
  const s = sheet({ title: "导好了" });
  s.body.innerHTML = `
    <div style="line-height:1.85;color:var(--ink)">
      <b>${esc(label)}</b>，共 ${count} 个素材。文案已复制到剪贴板。
    </div>
    <div class="hint" style="margin-top:14px;line-height:1.85">
      <b style="color:var(--ink)">接下来：</b><br>
      1. 用文件管理器找到刚下载的压缩包，解压<br>
      2. 打开豆包，选照片时按<b>文件名排序</b>，全选<br>
      3. 文案直接长按粘贴<br><br>
      <b style="color:var(--ink)">如果豆包看不到解压出来的照片：</b><br>
      安卓有时不会把新解压的文件加进相册。用相册 App 的「扫描媒体库」，
      或者把照片移到「Pictures」文件夹再试。
    </div>
  `;
}

// app.js 里也有一份，这里独立引用避免循环依赖
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1500);
}

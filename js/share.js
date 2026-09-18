// ============================================================
// 生成发给家人的单文件网页
//
// 为什么是单个 HTML 文件而不是文件夹：
//   安卓浏览器打开本地网页时，读取旁边文件夹里的图片经常被安全策略拦掉。
//   照片直接嵌进 HTML（base64）最稳 —— 互传过去一个文件，点开就能看。
//
// 代价：
//   照片要压小（SHARE_MAX_EDGE），不是原图。
//   视频不嵌（一个视频几十兆，嵌几个就大到打不开），
//   改成显示封面 + 提示"这段视频在相册里"，视频本身单独互传。
//
// 生成的页面没有任何编辑按钮，纯阅读 —— 家人只看不改。
// ============================================================

import * as store from "./store.js";
import * as media from "./media.js";
import { STOP_TYPE, TRANSPORT, formatDateCN, stopTimeLabel } from "./model.js";
import { sheet, toast, ok, err, esc, h, button, busy, confirmSheet } from "./ui.js";
import { SHARE_MAX_EDGE } from "./config.js";

/** 单文件网页的体积上限提醒（超过这个手机打开会吃力） */
const SOFT_LIMIT = 60 * 1024 * 1024; // 60MB

export async function buildShareHtml(trip) {
  const stats = store.mediaStats(trip);
  const s = sheet({ title: "生成网页发给家人" });

  const dayRows = trip.days.map((d) => ({
    day: d,
    stops: store.stopsOfDay(trip, d.id),
  }));

  s.body.innerHTML = `
    <div class="hint" style="margin:0 0 14px;line-height:1.8">
      生成<b>一个 HTML 文件</b>，照片嵌在里面。用互传发过去，
      对方用手机浏览器点开就能看，不用装东西、不用联网。
    </div>
    <div class="field">
      <label>照片清晰度</label>
      <select class="select" id="q">
        <option value="1280">清晰（长边 1280，文件较大）</option>
        <option value="900" selected>适中（长边 900，推荐）</option>
        <option value="640">省空间（长边 640）</option>
      </select>
      <div class="hint">照片会压缩后嵌进网页。原图仍留在应用里，不受影响。</div>
    </div>
    <div class="hint" style="line-height:1.8;color:var(--ink-2)">
      ${stats.videos
        ? `<b style="color:var(--danger)">这趟有 ${stats.videos} 个视频。</b>
           视频太大没法嵌进网页，页面里只显示封面和提示。
           想让家人看视频，单独用互传发过去。<br><br>`
        : ""}
      共 ${trip.stops.length} 个地点 · ${stats.images} 张照片
    </div>
  `;

  const go = button("生成", "btn btn-primary");
  const cancel = button("取消", "btn");
  const foot = h("div", { class: "sheet-foot" }, cancel, go);
  s.el.appendChild(foot);

  cancel.onclick = () => s.close();
  go.onclick = async () => {
    const maxEdge = parseInt(s.body.querySelector("#q").value, 10) || 900;
    s.close();
    await generate(trip, dayRows, maxEdge);
  };
}

async function generate(trip, dayRows, maxEdge) {
  const b = busy("正在生成网页…");
  try {
    // 收集所有要嵌的照片
    const jobs = [];
    for (const r of dayRows) {
      for (const st of r.stops) {
        for (const m of st.media || []) {
          jobs.push({ stopId: st.id, m });
        }
      }
    }

    const dataUrls = new Map(); // mediaId → data URL
    let done = 0;
    let bytes = 0;

    for (const job of jobs) {
      b.set((done / Math.max(1, jobs.length)) * 90, `处理 ${done + 1} / ${jobs.length}`);
      done++;
      const { m } = job;
      try {
        if (m.kind === "video") {
          // 视频只嵌封面
          const t = await media.getThumb(m.id);
          if (t) {
            const url = await blobToDataUrl(t);
            dataUrls.set(m.id, url);
            bytes += url.length;
          }
          continue;
        }
        const blob = await media.getBlob(m.id);
        if (!blob) continue;
        const small = await media.compressImage(blob, maxEdge, 0.78);
        const url = await blobToDataUrl(small.blob);
        dataUrls.set(m.id, url);
        bytes += url.length;
      } catch (e) {
        console.warn("跳过一个素材", m.id, e);
      }
    }

    b.set(94, "正在拼装页面…");

    if (bytes > SOFT_LIMIT) {
      b.done();
      const goOn = await confirmSheet(
        "文件有点大",
        `生成的网页约 ${media.formatBytes(bytes)}，手机打开可能会卡。` +
          `建议选更低的清晰度，或者按天分开发。要继续吗？`,
        { okText: "继续生成" }
      );
      if (!goOn) return;
    }

    const html = renderShareDoc(trip, dayRows, dataUrls);
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });

    b.done();
    downloadBlob(blob, `${safe(trip.name)}.html`);
    showShareTips(trip, media.formatBytes(blob.size));
  } catch (e) {
    b.done();
    console.error(e);
    err("生成失败：" + e.message);
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/**
 * 拼出阅读版页面。
 * 排版偏画册：大图、想法配在图旁、一天一章。
 * 样式全内联，不依赖任何外部文件。
 */
export function renderShareDoc(trip, dayRows, dataUrls) {
  const parts = [];

  parts.push(`<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(trip.name)}</title>
<style>
:root{--paper:#faf7f2;--card:#fff;--ink:#26211a;--ink2:#6b6259;--ink3:#a09689;
--line:#e8e0d4;--accent:#d2691e;--sab:env(safe-area-inset-bottom,0px)}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);
font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
-webkit-font-smoothing:antialiased;padding-bottom:calc(40px + var(--sab))}
img{max-width:100%;display:block}
.wrap{max-width:640px;margin:0 auto;padding:0 18px}
.cover{padding:52px 18px 34px;text-align:center;background:linear-gradient(160deg,#f6ede1,#faf7f2)}
.cover h1{margin:0 0 8px;font-size:29px;font-weight:700;letter-spacing:-.02em}
.cover .dt{color:var(--ink2);font-size:14px}
.cover .desc{margin:16px auto 0;max-width:420px;color:var(--ink2);font-size:14px;line-height:1.8;text-align:left;
padding:14px 16px;background:rgba(255,255,255,.6);border-radius:12px}
.cover .st{margin-top:18px;font-size:12.5px;color:var(--ink3);font-variant-numeric:tabular-nums}
.day{margin:38px 0 0}
.day-h{display:flex;align-items:baseline;gap:10px;padding-bottom:11px;
border-bottom:1px solid var(--line);margin-bottom:20px}
.day-h b{font-size:21px;letter-spacing:-.02em}
.day-h span{font-size:13px;color:var(--ink2)}
.stop{margin-bottom:30px}
.stop-h{display:flex;align-items:flex-start;gap:9px;margin-bottom:9px}
.stop-h .ic{font-size:19px;flex-shrink:0;line-height:1.3}
.stop-h .nm{font-size:17px;font-weight:600;letter-spacing:-.01em;word-break:break-word}
.stop-h .ty{font-size:12px;color:var(--ink3);margin-top:1px}
.stop-h .tm{display:inline-flex;align-items:center;gap:7px;margin-bottom:6px;
padding:4px 11px 4px 9px;border-radius:7px;background:#fbeee2;border:1px solid #f0d9c2;
color:#b8551a;font-size:15.5px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.35}
.stop-h .tm b{font-size:11.5px;font-weight:500;color:var(--ink2);
padding-left:7px;border-left:1px solid #ecd5bd}
.note{padding:12px 14px;background:#f3eee6;border-radius:10px;font-size:14.5px;
line-height:1.85;white-space:pre-wrap;word-break:break-word;margin-bottom:11px}
.shots{display:flex;flex-direction:column;gap:9px}
.shots img{width:100%;border-radius:10px;background:#f3eee6}
.vid{position:relative;border-radius:10px;overflow:hidden;background:#f3eee6}
.vid img{opacity:.82}
.vid .tag{position:absolute;left:0;right:0;bottom:0;padding:9px 12px;
background:linear-gradient(to top,rgba(0,0,0,.72),transparent);
color:#fff;font-size:12.5px}
.vid .pl{position:absolute;inset:0;display:grid;place-items:center;
font-size:38px;color:rgba(255,255,255,.94);text-shadow:0 2px 12px rgba(0,0,0,.5)}
.vid.noimg{aspect-ratio:16/10;display:grid;place-items:center;color:var(--ink3);font-size:13px}
.leg{display:flex;align-items:center;gap:7px;margin:-16px 0 26px 3px;
font-size:12.5px;color:var(--ink2)}
.leg i{font-style:normal;padding:3px 11px;border:1px solid var(--line);
border-radius:20px;background:#f3eee6}
.foot{margin:52px 0 0;padding:22px 18px calc(30px + var(--sab));
text-align:center;color:var(--ink3);font-size:12px;border-top:1px solid var(--line)}
</style></head><body>`);

  // 封面
  const stats = store.mediaStats(trip);
  parts.push(`<div class="cover">
<h1>${esc(trip.name)}</h1>
<div class="dt">${esc(trip.startDate)} — ${esc(trip.endDate)} · ${trip.days.length} 天</div>
${trip.description ? `<div class="desc">${esc(trip.description)}</div>` : ""}
<div class="st">${trip.stops.length} 个地点 · ${stats.images} 张照片${
    stats.videos ? ` · ${stats.videos} 个视频` : ""
  }</div>
</div><div class="wrap">`);

  for (const r of dayRows) {
    if (!r.stops.length) continue;
    parts.push(`<div class="day"><div class="day-h">
<b>第 ${r.day.day} 天</b><span>${esc(formatDateCN(r.day.date))}</span></div>`);

    r.stops.forEach((st, si) => {
      const meta = STOP_TYPE[st.type] || STOP_TYPE.other;
      // 时间放地点名之上，家人一眼能看到几点出发、几点到
      const tl = stopTimeLabel(st);
      const timeHtml = tl
        ? `<div class="tm">🕐 ${esc(tl.text)}${
            tl.kind === "range"
              ? tl.duration
                ? `<b>${esc(tl.duration)}</b>`
                : ""
              : `<b>开始</b>`
          }</div>`
        : "";
      parts.push(`<div class="stop"><div class="stop-h">
<span class="ic">${meta.icon}</span>
<div style="flex:1">${timeHtml}<div class="nm">${si + 1}. ${esc(st.name)}</div>
<div class="ty">${meta.label}</div></div></div>`);

      if (st.note) parts.push(`<div class="note">${esc(st.note)}</div>`);

      const items = st.media || [];
      if (items.length) {
        parts.push(`<div class="shots">`);
        for (const m of items) {
          const url = dataUrls.get(m.id);
          if (m.kind === "video") {
            if (url) {
              parts.push(`<div class="vid"><img src="${url}" alt="">
<div class="pl">▶</div>
<div class="tag">视频${
                m.duration ? ` ${Math.round(m.duration)} 秒` : ""
              } · 在相册里看</div></div>`);
            } else {
              parts.push(`<div class="vid noimg">一段视频 · 在相册里看</div>`);
            }
          } else if (url) {
            parts.push(`<img src="${url}" alt="${esc(st.name)}" loading="lazy">`);
          }
        }
        parts.push(`</div>`);
      }
      parts.push(`</div>`);

      if (si + 1 < r.stops.length) {
        const seg = store.getSegment(trip, st.id, r.stops[si + 1].id);
        const t = TRANSPORT[seg?.transport] || TRANSPORT.car;
        parts.push(`<div class="leg"><i>${t.icon} ${t.label}</i></div>`);
      }
    });

    parts.push(`</div>`);
  }

  parts.push(`</div><div class="foot">旅行记 · ${esc(trip.name)}</div></body></html>`);
  return parts.join("");
}

function showShareTips(trip, size) {
  const s = sheet({ title: "网页生成好了" });
  s.body.innerHTML = `
    <div style="line-height:1.85">
      <b>${esc(safe(trip.name))}.html</b>　${esc(size)}
    </div>
    <div class="hint" style="margin-top:14px;line-height:1.9">
      <b style="color:var(--ink)">怎么发给家人：</b><br>
      1. 打开互传，选「文件」<br>
      2. 在下载目录找到这个 HTML 文件<br>
      3. 发过去<br>
      4. 对方收到后点开，选用<b>浏览器</b>打开<br><br>
      <b style="color:var(--ink)">有视频的话：</b><br>
      视频没有嵌进网页（太大）。想让家人看视频，
      在互传里另外选那几个视频发过去。<br><br>
      <b style="color:var(--ink)">下次更新：</b><br>
      重新生成一次再发过去就行，覆盖掉旧的。
    </div>
  `;
}

function safe(s) {
  return String(s || "旅行").replace(/[\/\\:*?"<>|]/g, "_").slice(0, 40);
}

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

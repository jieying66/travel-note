// ============================================================
// 主应用：路由、首页、行程页（时间轴 + 地图）
// ============================================================

import {
  STOP_TYPE, TRANSPORT, DEFAULT_TRANSPORT,
  formatDateCN, toDateStr, addDays, daysBetween,
  stopTimeLabel,
} from "./model.js";
import * as store from "./store.js";
import * as media from "./media.js";
import * as mapmod from "./map.js";
import { openStopSheet, openTransportSheet, pickFiles, openViewer } from "./stopEdit.js";
import { sheet, toast, ok, err, esc, h, button, confirmSheet, busy } from "./ui.js";
import { DEFAULT_AMAP_KEY } from "./config.js";
import { exportTrip } from "./export.js";
import { buildShareHtml } from "./share.js";

const pageEl = document.getElementById("page");
const titleEl = document.getElementById("title");

// 首次启动写入默认 key
if (!store.getSettings().amapKey && DEFAULT_AMAP_KEY) {
  store.saveSettings({ amapKey: DEFAULT_AMAP_KEY });
}

// 供 viewer 回调删除素材
window.__tnDeleteMedia = async (stopId, mediaId) => {
  const trip = currentTrip();
  if (!trip) return;
  await store.removeMediaFrom(trip, stopId, mediaId);
  ok("已删除");
  render();
};

// ---------- 路由 ----------

let view = { name: "home", tripId: null, tab: "plan", day: null };

function currentTrip() {
  return view.tripId ? store.getTrip(view.tripId) : null;
}

function go(next) {
  view = { ...view, ...next };
  const hash = view.name === "trip" ? `#/trip/${view.tripId}` : "#/";
  if (location.hash !== hash) {
    history.pushState(null, "", hash);
  }
  render();
}

function readHash() {
  const m = location.hash.match(/^#\/trip\/([\w]+)/);
  if (m && store.getTrip(m[1])) {
    // 换了一趟旅行就回到行程页；还是同一趟（前进后退）则保留当前标签，
    // 免得用户看地图时按了后退又被踢回行程页
    const sameTrip = view.name === "trip" && view.tripId === m[1];
    view = {
      name: "trip",
      tripId: m[1],
      tab: sameTrip ? view.tab || "plan" : "plan",
      day: null,
    };
  } else {
    view = { name: "home", tripId: null, tab: "plan", day: null };
  }
}

// popstate 管前进后退；hashchange 管直接改地址栏或点 hash 链接 ——
// 两者不互相触发，只听一个会让另一种导航静默失效。
window.addEventListener("popstate", onNavigate);
window.addEventListener("hashchange", onNavigate);

function onNavigate() {
  readHash();
  render();
}

// ---------- 渲染 ----------

function render() {
  if (view.name === "home") renderHome();
  else renderTrip();
}

function renderHome() {
  titleEl.textContent = "旅行记";
  const trips = store.listTrips();
  pageEl.className = "page";
  pageEl.innerHTML = "";

  pageEl.appendChild(
    h(
      "div",
      { class: "hero" },
      h("h2", { text: "旅行记" }),
      h("p", { text: "记下每天去哪、拍了什么、想到什么" })
    )
  );

  if (!trips.length) {
    pageEl.appendChild(
      h(
        "div",
        { class: "empty" },
        h("div", { class: "icon", text: "🧭" }),
        h("p", { text: "还没有旅行" }),
        h("p", { class: "hint", style: "margin:0", text: "点右下角开始记第一趟" })
      )
    );
  } else {
    const list = h("div", { class: "trip-list" });
    for (const t of trips) {
      const st = store.mediaStats(t);
      const card = h("a", {
        class: "trip-card",
        href: `#/trip/${t.id}`,
        onclick: (e) => {
          e.preventDefault();
          go({ name: "trip", tripId: t.id, tab: "plan" });
        },
      });
      card.innerHTML = `
        <div class="trip-cover" style="--hue:${t.coverHue ?? 30}"></div>
        <div class="trip-body">
          <h3>${esc(t.name)}</h3>
          <div class="trip-meta">
            <span>${esc(t.startDate)} → ${esc(t.endDate)}</span>
            <span class="dot">·</span>
            <span class="tnum">${t.days.length} 天</span>
            <span class="dot">·</span>
            <span class="tnum">${t.stops.length} 个地点</span>
            ${st.images || st.videos
              ? `<span class="dot">·</span><span class="tnum">${st.images} 图 ${st.videos} 视频</span>`
              : ""}
          </div>
        </div>
      `;
      list.appendChild(card);
    }
    pageEl.appendChild(list);
  }

  mountFab("＋ 新建旅行", openNewTrip);
}

function renderTrip() {
  const trip = currentTrip();
  if (!trip) {
    go({ name: "home", tripId: null });
    return;
  }
  titleEl.innerHTML = `${esc(trip.name)}<span class="sub tnum">${trip.days.length}天</span>`;

  pageEl.className = view.tab === "map" ? "page page-wide" : "page";
  pageEl.innerHTML = "";

  // 返回 + 标签切换
  const tabs = h("div", { class: "tabs" });
  for (const [k, label] of [["plan", "行程"], ["map", "地图"]]) {
    const b = h("button", { "aria-selected": view.tab === k ? "true" : "false", text: label });
    b.onclick = () => {
      view.tab = k;
      render();
    };
    tabs.appendChild(b);
  }

  const bar = h(
    "div",
    { style: "display:flex;gap:8px;align-items:center;padding:10px 0 0" },
    (() => {
      const b = h("button", { class: "btn btn-sm", text: "‹ 全部旅行" });
      b.onclick = () => go({ name: "home", tripId: null });
      return b;
    })(),
    h("div", { style: "flex:1" }),
    (() => {
      const b = h("button", { class: "btn btn-sm", text: "⋯" });
      b.onclick = () => openTripMenu(trip);
      return b;
    })()
  );

  if (view.tab === "map") {
    const wrap = h("div", { style: "padding:0 16px" }, bar, tabs);
    pageEl.appendChild(wrap);
    pageEl.appendChild(renderMapPane(trip));
  } else {
    pageEl.appendChild(bar);
    pageEl.appendChild(tabs);
    pageEl.appendChild(renderPlanPane(trip));
  }

  mountFab("＋ 加地点", () => {
    const dayId = view.day || trip.days[0]?.id;
    if (!dayId) return;
    openStopSheet(trip, dayId, null, { onSaved: render });
  });
}

// ---------- 行程时间轴 ----------

function renderPlanPane(trip) {
  const box = h("div");

  if (trip.description) {
    // 用自己的类，不复用 .stop-note —— 那个属于地点，混用会让"有几段想法"这类判断出错
    box.appendChild(h("div", { class: "trip-desc", text: trip.description }));
  }

  for (const day of trip.days) {
    const stops = store.stopsOfDay(trip, day.id);
    const block = h("div", { class: "day-block" });

    const head = h(
      "div",
      { class: "day-head" },
      h("span", { class: "day-num tnum", text: `第 ${day.day} 天` }),
      h("span", { class: "day-date", text: formatDateCN(day.date) }),
      h("span", { class: "day-count tnum", text: stops.length ? `${stops.length} 站` : "空" })
    );
    head.onclick = () => {
      view.day = day.id;
      toast(`新地点会加到第 ${day.day} 天`, "", 1400);
    };
    block.appendChild(head);

    if (!stops.length) {
      const add = h("button", {
        class: "btn btn-sm btn-block",
        style: "border-style:dashed;color:var(--ink-3)",
        text: "＋ 这天还没有地点",
      });
      add.onclick = () => openStopSheet(trip, day.id, null, { onSaved: render });
      block.appendChild(add);
    } else {
      const line = h("div", { class: "stop-line" });
      stops.forEach((s, i) => {
        line.appendChild(renderStop(trip, s, i, stops.length));
        if (i + 1 < stops.length) {
          line.appendChild(renderLeg(trip, s, stops[i + 1]));
        }
      });
      block.appendChild(line);

      const add = h("button", {
        class: "btn btn-sm",
        style: "margin-left:30px;border-style:dashed;color:var(--ink-3)",
        text: "＋ 加到这天",
      });
      add.onclick = () => openStopSheet(trip, day.id, null, { onSaved: render });
      block.appendChild(add);
    }

    box.appendChild(block);
  }

  return box;
}

function renderStop(trip, stop, idx, total) {
  const meta = STOP_TYPE[stop.type] || STOP_TYPE.other;
  const el = h("div", { class: "stop" });

  const top = h(
    "div",
    { class: "stop-top" },
    h("span", { class: "stop-icon", text: meta.icon }),
    h(
      "div",
      { class: "stop-main" },
      h("div", { class: "stop-name", text: `${idx + 1}. ${stop.name}` }),
      h("div", {
        class: "stop-type",
        text: [meta.label, stop.latitude != null ? "已定位" : "未定位"].join(" · "),
      })
    )
  );
  el.appendChild(top);

  if (stop.note) {
    el.appendChild(h("div", { class: "stop-note", text: stop.note }));
  }

  // 素材网格
  const grid = h("div", { class: "media-grid" });
  (stop.media || []).forEach((m, i) => {
    const b = h("button", { class: "media-thumb" });
    b.onclick = () => openViewer(stop, i);
    if (m.kind === "video") {
      b.appendChild(h("div", { class: "play", text: "▶" }));
      b.appendChild(
        h("span", {
          class: "badge",
          text: m.duration ? `${Math.round(m.duration)}s` : "视频",
        })
      );
    }
    grid.appendChild(b);
    // 缩略图异步加载，避免一次性把几十张图塞进内存
    media.getThumb(m.id).then((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const img = h("img", { src: url, alt: "", loading: "lazy" });
      img.onload = () => setTimeout(() => URL.revokeObjectURL(url), 1000);
      b.prepend(img);
    });
  });
  const addBtn = h("button", { class: "media-add", text: "＋" });
  addBtn.onclick = () => pickFiles(trip, stop.id, render);
  grid.appendChild(addBtn);
  el.appendChild(grid);

  // 操作行
  const acts = h("div", { class: "stop-actions" });
  const mk = (label, fn, cls = "btn btn-sm btn-ghost") => {
    const b = h("button", { class: cls, text: label });
    b.onclick = fn;
    return b;
  };
  acts.appendChild(mk("编辑", () => openStopSheet(trip, stop.dayId, stop, { onSaved: render })));
  if (idx > 0) acts.appendChild(mk("↑", () => { store.moveStop(trip, stop.id, -1); render(); }));
  if (idx + 1 < total) acts.appendChild(mk("↓", () => { store.moveStop(trip, stop.id, 1); render(); }));
  acts.appendChild(h("div", { class: "spacer" }));
  acts.appendChild(
    mk("删除", async () => {
      if (
        await confirmSheet("删掉这个地点？", "它的照片和想法会一起删掉，找不回来。", {
          danger: true,
          okText: "删除",
        })
      ) {
        await store.removeStop(trip, stop.id);
        render();
      }
    }, "btn btn-sm btn-ghost")
  );
  el.appendChild(acts);

  // 时间做成卡片外的标签，脱离白底后橙色更跳眼。
  // 时间轴圆点画在外层上：有时间就对齐标签，没时间就对齐卡片。
  const tl = stopTimeLabel(stop);
  const wrap = h("div", { class: `stop-wrap${tl ? " has-time" : ""}` });
  if (tl) wrap.appendChild(renderStopTime(tl));
  wrap.appendChild(el);
  return wrap;
}

/**
 * 时间块。两种形态：
 *   时段  08:20 – 11:05 │ 2 小时 45 分
 *   单点  07:30 出发
 * 结束早于开始时标红，让用户看到自己填错了（不静默吞掉）。
 */
function renderStopTime(tl) {
  const bad = tl.kind === "range" && !tl.duration;
  return h(
    "div",
    { class: `stop-time${bad ? " bad" : ""}` },
    h("span", { class: "clock", text: "🕐" }),
    h("span", { text: tl.text }),
    tl.kind === "range"
      ? tl.duration
        ? h("span", { class: "dur", text: tl.duration })
        : h("span", { class: "dur", text: "结束早于开始" })
      : h("span", { class: "at", text: "开始" })
  );
}

function renderLeg(trip, a, b) {
  const seg = store.getSegment(trip, a.id, b.id);
  const t = seg?.transport || DEFAULT_TRANSPORT;
  const tm = TRANSPORT[t] || TRANSPORT.car;
  const dist =
    a.latitude != null && b.latitude != null ? mapmod.legDistance(a, b) : "";

  const pill = h(
    "button",
    { class: "leg-pill" },
    h("span", { text: tm.icon }),
    h("span", { text: tm.label })
  );
  pill.onclick = () => openTransportSheet(trip, a.id, b.id, t, render);

  return h(
    "div",
    { class: "leg" },
    pill,
    dist ? h("span", { class: "leg-dist tnum", text: `约 ${dist}` }) : null
  );
}

// ---------- 地图 ----------

function renderMapPane(trip) {
  const wrap = h("div", { class: "map-wrap" });
  const mapEl = h("div", { id: "map" });
  wrap.appendChild(mapEl);

  const tools = h("div", { class: "map-tools" });
  const tBase = h("button", { class: "btn", text: "🌐", title: "切换底图" });
  tBase.onclick = () => {
    const nm = mapmod.toggleBase();
    toast(`底图：${nm}`, "", 1200);
  };
  const tMe = h("button", { class: "btn", text: "📍", title: "我的位置" });
  tMe.onclick = async () => {
    try {
      const p = await mapmod.locate();
      mapmod.showMe(p.latitude, p.longitude);
    } catch (e) {
      err(e.message);
    }
  };
  const tFit = h("button", { class: "btn", text: "⤢", title: "看全程" });
  tFit.onclick = () => paintMap(trip, null);
  tools.append(tBase, tMe, tFit);
  wrap.appendChild(tools);

  const legend = h("div", { class: "map-legend" });
  wrap.appendChild(legend);

  // 天数筛选
  const dayBar = h(
    "div",
    { style: "display:flex;gap:6px;overflow-x:auto;padding:12px 16px 4px;-webkit-overflow-scrolling:touch" }
  );
  const mkDay = (label, dayNum) => {
    const b = h("button", {
      class: "btn btn-sm",
      style: "flex:0 0 auto",
      text: label,
    });
    b.onclick = () => {
      dayBar.querySelectorAll("button").forEach((x) => (x.style.borderColor = ""));
      b.style.borderColor = "var(--accent)";
      paintMap(trip, dayNum);
    };
    return b;
  };
  dayBar.appendChild(mkDay("全程", null));
  for (const d of trip.days) {
    if (store.stopsOfDay(trip, d.id).length) dayBar.appendChild(mkDay(`第${d.day}天`, d.day));
  }

  const out = h("div");
  out.append(dayBar, wrap);

  // 地图必须在 DOM 挂上之后再初始化
  requestAnimationFrame(() => {
    try {
      mapmod.initMap("map");
      mapmod.invalidate();
      paintMap(trip, null);
    } catch (e) {
      mapEl.innerHTML = `<div style="padding:40px;text-align:center;color:var(--ink-3)">地图加载失败：${esc(
        e.message
      )}</div>`;
    }
  });

  function paintMap(t, dayNum) {
    const ordered = orderedStops(t);
    const located = ordered.filter((s) => s.latitude != null);
    mapmod.renderTrip(t, located, { highlightDay: dayNum });
    const missing = ordered.length - located.length;
    legend.innerHTML =
      `<b>${located.length}</b> 个已定位地点` +
      (missing ? `，<span style="color:var(--danger)">${missing} 个还没位置</span>` : "") +
      (dayNum ? `<br>正看第 ${dayNum} 天` : "");
  }

  return out;
}

/** 全程地点按 第几天 → 第几站 排好序。导出也用这个顺序。 */
function orderedStops(trip) {
  const out = [];
  for (const d of trip.days) {
    for (const s of store.stopsOfDay(trip, d.id)) out.push(s);
  }
  return out;
}

// ---------- 新建旅行 ----------

function openNewTrip() {
  const today = toDateStr(new Date());
  const save = button("创建", "btn btn-primary");
  const cancel = button("取消", "btn");
  const s = sheet({ title: "新建旅行", foot: [cancel, save] });
  s.body.innerHTML = `
    <div class="field">
      <label>旅行名字</label>
      <input class="input" id="n" placeholder="比如 春天的杭州" autocomplete="off">
    </div>
    <div class="row">
      <div class="field" style="flex:1">
        <label>出发</label>
        <input class="input" type="date" id="d1" value="${today}">
      </div>
      <div class="field" style="flex:1">
        <label>返回</label>
        <input class="input" type="date" id="d2" value="${addDays(today, 2)}">
      </div>
    </div>
    <div class="field">
      <label>说明（可选）</label>
      <textarea class="textarea" id="desc" placeholder="这趟想去哪、和谁一起…"></textarea>
    </div>
    <div class="hint" id="tip"></div>
  `;
  const n = s.body.querySelector("#n");
  const d1 = s.body.querySelector("#d1");
  const d2 = s.body.querySelector("#d2");
  const tip = s.body.querySelector("#tip");

  const paint = () => {
    if (d2.value < d1.value) {
      tip.textContent = "返回日期比出发早了";
      tip.style.color = "var(--danger)";
    } else {
      tip.textContent = `共 ${daysBetween(d1.value, d2.value)} 天`;
      tip.style.color = "var(--ink-3)";
    }
  };
  d1.onchange = d2.onchange = paint;
  paint();

  cancel.onclick = () => s.close();
  save.onclick = () => {
    const name = n.value.trim();
    if (!name) {
      err("给这趟旅行起个名字");
      n.focus();
      return;
    }
    if (d2.value < d1.value) {
      err("返回日期比出发早了");
      return;
    }
    const t = store.addTrip({
      name,
      startDate: d1.value,
      endDate: d2.value,
      description: s.body.querySelector("#desc").value.trim(),
    });
    s.close();
    ok("建好了");
    go({ name: "trip", tripId: t.id, tab: "plan" });
  };
  setTimeout(() => n.focus(), 260);
}

// ---------- 旅行菜单 ----------

function openTripMenu(trip) {
  const s = sheet({ title: trip.name });
  const st = store.mediaStats(trip);

  const item = (label, desc, fn, cls = "") => {
    const b = h(
      "button",
      {
        class: "result",
        style: "padding:14px 4px",
      },
      h("div", { class: "nm", text: label, style: cls }),
      desc ? h("div", { class: "ad", text: desc }) : null
    );
    b.onclick = fn;
    return b;
  };

  s.body.appendChild(
    h("div", {
      class: "hint",
      style: "margin:0 0 8px",
      text: `${trip.days.length} 天 · ${trip.stops.length} 个地点 · ${st.images} 张照片 · ${st.videos} 个视频 · ${media.formatBytes(st.bytes)}`,
    })
  );

  s.body.appendChild(
    item("导出给豆包", "照片按顺序命名 + 文案，用来做视频", () => {
      s.close();
      exportTrip(trip);
    })
  );

  s.body.appendChild(
    item("生成一个网页发给家人", "单个文件，互传过去点开就能看", async () => {
      s.close();
      await buildShareHtml(trip);
    })
  );

  s.body.appendChild(
    item("编辑旅行信息", "改名字、日期、说明", () => {
      s.close();
      openEditTrip(trip);
    })
  );

  s.body.appendChild(
    item("备份这趟行程", "导出 JSON，换手机或清理浏览器前存一份", () => {
      s.close();
      const blob = new Blob([JSON.stringify({ version: 1, trips: [trip] }, null, 2)], {
        type: "application/json",
      });
      downloadBlob(blob, `${safeName(trip.name)}-备份.json`);
      ok("已导出备份");
    })
  );

  s.body.appendChild(
    item("删除这趟旅行", "连照片一起删掉", async () => {
      s.close();
      if (
        await confirmSheet("删掉整趟旅行？", `「${trip.name}」的所有地点、照片、想法都会删掉，找不回来。`, {
          danger: true,
          okText: "删除",
        })
      ) {
        await store.deleteTrip(trip.id);
        ok("已删除");
        go({ name: "home", tripId: null });
      }
    }, "color:var(--danger)")
  );
}

function openEditTrip(trip) {
  const save = button("保存", "btn btn-primary");
  const cancel = button("取消", "btn");
  const s = sheet({ title: "编辑旅行", foot: [cancel, save] });
  s.body.innerHTML = `
    <div class="field">
      <label>旅行名字</label>
      <input class="input" id="n" autocomplete="off">
    </div>
    <div class="row">
      <div class="field" style="flex:1">
        <label>出发</label>
        <input class="input" type="date" id="d1">
      </div>
      <div class="field" style="flex:1">
        <label>返回</label>
        <input class="input" type="date" id="d2">
      </div>
    </div>
    <div class="field">
      <label>说明</label>
      <textarea class="textarea" id="desc"></textarea>
    </div>
    <div class="hint" id="tip"></div>
  `;
  const n = s.body.querySelector("#n");
  const d1 = s.body.querySelector("#d1");
  const d2 = s.body.querySelector("#d2");
  const desc = s.body.querySelector("#desc");
  const tip = s.body.querySelector("#tip");
  n.value = trip.name;
  d1.value = trip.startDate;
  d2.value = trip.endDate;
  desc.value = trip.description || "";

  const paint = () => {
    const want = daysBetween(d1.value, d2.value);
    const have = trip.days.length;
    if (d2.value < d1.value) {
      tip.textContent = "返回日期比出发早了";
      tip.style.color = "var(--danger)";
    } else if (want < have) {
      tip.textContent = `天数从 ${have} 减到 ${want}，被砍掉那几天的地点会挪到最后一天`;
      tip.style.color = "var(--danger)";
    } else {
      tip.textContent = `共 ${want} 天`;
      tip.style.color = "var(--ink-3)";
    }
  };
  d1.onchange = d2.onchange = paint;
  paint();

  cancel.onclick = () => s.close();
  save.onclick = () => {
    if (d2.value < d1.value) {
      err("返回日期比出发早了");
      return;
    }
    trip.name = n.value.trim() || trip.name;
    trip.startDate = d1.value;
    trip.endDate = d2.value;
    trip.description = desc.value.trim();
    store.resizeDays(trip);
    store.saveTrip(trip);
    s.close();
    ok("已保存");
    render();
  };
}

// ---------- 设置 ----------

document.getElementById("btn-settings").onclick = openSettings;

async function openSettings() {
  const save = button("保存", "btn btn-primary");
  const s = sheet({ title: "设置", foot: [save] });
  const cfg = store.getSettings();
  const est = await media.storageEstimate();

  s.body.innerHTML = `
    <div class="field">
      <label>高德 Key（Web服务类型）</label>
      <input class="input" id="k" placeholder="搜地名需要，底图不需要" autocomplete="off">
      <div class="hint">
        只用来搜地名和反查地址。留空也能用应用：当前位置打点、地图点选、看地图都不需要 Key。
      </div>
    </div>
    <div class="field">
      <label>存储占用</label>
      <div class="hint" style="margin:0">${
        est
          ? `已用 ${media.formatBytes(est.usage)}${
              est.quota ? ` / 可用 ${media.formatBytes(est.quota)}` : ""
            }`
          : "这个浏览器读不到占用信息"
      }</div>
      <div class="hint" style="color:var(--danger);margin-top:6px">
        数据存在浏览器里。清理浏览器数据会一起清掉，重要行程记完导一份备份。
      </div>
    </div>
    <div class="field">
      <label>整库备份</label>
      <div class="row">
        <button class="btn btn-sm" id="exp">导出全部</button>
        <button class="btn btn-sm" id="imp">导入备份</button>
      </div>
    </div>
  `;
  const k = s.body.querySelector("#k");
  k.value = cfg.amapKey || "";

  s.body.querySelector("#exp").onclick = () => {
    const blob = new Blob([store.exportAllJSON()], { type: "application/json" });
    downloadBlob(blob, `旅行记-全部备份-${toDateStr(new Date())}.json`);
    ok("已导出");
  };

  s.body.querySelector("#imp").onclick = () => {
    const input = h("input", { type: "file", accept: ".json,application/json", style: "display:none" });
    document.body.appendChild(input);
    input.onchange = async () => {
      const f = input.files?.[0];
      input.remove();
      if (!f) return;
      try {
        const r = store.importJSON(await f.text());
        ok(`导入 ${r.added} 趟，跳过 ${r.skipped} 趟`);
        s.close();
        render();
      } catch (e) {
        err("导入失败：" + e.message);
      }
    };
    input.click();
  };

  save.onclick = () => {
    store.saveSettings({ amapKey: k.value.trim() });
    s.close();
    ok("已保存");
  };
}

// ---------- 工具 ----------

function mountFab(label, fn) {
  document.querySelector(".fab")?.remove();
  const b = h("button", { class: "fab", text: label });
  b.onclick = fn;
  document.body.appendChild(b);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: filename, style: "display:none" });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1500);
}

export function safeName(s) {
  return String(s || "旅行").replace(/[\/\\:*?"<>|]/g, "_").slice(0, 40);
}

export { orderedStops };

// ---------- 启动 ----------

readHash();
render();

// ============================================================
// 地点编辑：新增/修改地点、写想法、传照片和视频
//
// 三种加地点的方式：
//   1. 当前位置（旅行中最顺手，走到了点一下）
//   2. 地图上点选
//   3. 搜地名（需要高德 key）
// ============================================================

import {
  STOP_TYPE, TRANSPORT, guessStopType, createMedia,
  normalizeTime, formatDuration,
} from "./model.js";
import * as store from "./store.js";
import * as media from "./media.js";
import { searchPlaces, reverseGeocode, hasKey } from "./search.js";
import { locate, focusStop, setPickMode, clearPickMarker } from "./map.js";
import { sheet, toast, ok, err, esc, h, button, optionGrid, confirmSheet, busy } from "./ui.js";
import { PHOTO_MAX_EDGE, THUMB_MAX_EDGE } from "./config.js";

/**
 * 打开地点编辑弹层。
 * stop 传 null 是新增；传对象是修改。
 * 新增时 seed 可以带上已知的坐标和名字（来自定位/点选/搜索）。
 */
export function openStopSheet(trip, dayId, stop, { seed = null, onSaved } = {}) {
  const isNew = !stop;
  const draft = isNew
    ? {
        name: seed?.name || "",
        latitude: seed?.latitude ?? null,
        longitude: seed?.longitude ?? null,
        type: seed?.type || guessStopType(seed?.name || ""),
        note: seed?.note || "",
        startTime: seed?.startTime || "",
        endTime: seed?.endTime || "",
      }
    : {
        name: stop.name,
        latitude: stop.latitude,
        longitude: stop.longitude,
        type: stop.type,
        note: stop.note || "",
        startTime: stop.startTime || "",
        endTime: stop.endTime || "",
      };

  const save = button(isNew ? "添加" : "保存", "btn btn-primary");
  const cancel = button("取消", "btn");
  const s = sheet({ title: isNew ? "添加地点" : "编辑地点", foot: [cancel, save] });

  s.body.innerHTML = `
    <div class="field">
      <label>地点名称</label>
      <input class="input" id="f-name" placeholder="比如 西湖断桥" autocomplete="off">
      <div class="hint" id="f-coord"></div>
    </div>
    <div class="field">
      <label>位置</label>
      <div class="row">
        <button class="btn btn-sm" id="f-locate">📍 当前位置</button>
        <button class="btn btn-sm" id="f-pick">🗺 地图点选</button>
      </div>
      <div class="row" style="margin-top:8px">
        <button class="btn btn-sm btn-block" id="f-search">🔍 搜地名</button>
      </div>
    </div>
    <div class="field">
      <label>时间（可选）</label>
      <div class="time-modes" id="f-tmode">
        <button data-m="none">不填</button>
        <button data-m="point">几点开始</button>
        <button data-m="range">时段</button>
      </div>
      <div id="f-tbox" class="time-box" hidden>
        <div class="row">
          <div style="flex:1">
            <label class="tlabel" id="f-tl1">开始</label>
            <input class="input" type="time" id="f-t1" step="60">
          </div>
          <div style="flex:1" id="f-t2wrap" hidden>
            <label class="tlabel">结束</label>
            <input class="input" type="time" id="f-t2" step="60">
          </div>
        </div>
        <div class="hint" id="f-thint"></div>
      </div>
    </div>
    <div class="field">
      <label>类型</label>
      <div id="f-type"></div>
    </div>
    <div class="field">
      <label>当时的想法</label>
      <textarea class="textarea" id="f-note" placeholder="看到什么、想到什么、好不好吃…&#10;这段文字会一起导出，用来配视频"></textarea>
    </div>
  `;

  const nameEl = s.body.querySelector("#f-name");
  const coordEl = s.body.querySelector("#f-coord");
  const noteEl = s.body.querySelector("#f-note");
  const typeBox = s.body.querySelector("#f-type");

  nameEl.value = draft.name;
  noteEl.value = draft.note;

  const paintCoord = () => {
    if (draft.latitude == null) {
      coordEl.textContent = "还没有位置。可以只写名字，位置以后再补。";
      coordEl.style.color = "var(--ink-3)";
    } else {
      coordEl.textContent = `${draft.latitude.toFixed(5)}, ${draft.longitude.toFixed(5)}`;
      coordEl.style.color = "var(--ok)";
    }
  };
  paintCoord();

  const paintType = () => {
    typeBox.innerHTML = "";
    typeBox.appendChild(
      optionGrid(STOP_TYPE, draft.type, (k) => {
        draft.type = k;
        paintType();
      })
    );
  };
  paintType();

  // ---- 时间 ----
  const tmode = s.body.querySelector("#f-tmode");
  const tbox = s.body.querySelector("#f-tbox");
  const t1 = s.body.querySelector("#f-t1");
  const t2 = s.body.querySelector("#f-t2");
  const t2wrap = s.body.querySelector("#f-t2wrap");
  const tl1 = s.body.querySelector("#f-tl1");
  const thint = s.body.querySelector("#f-thint");

  // 从已有数据判断当前是哪种模式
  let mode = draft.endTime ? "range" : draft.startTime ? "point" : "none";
  t1.value = draft.startTime || "";
  t2.value = draft.endTime || "";

  const paintTime = () => {
    for (const b of tmode.querySelectorAll("button")) {
      b.setAttribute("aria-selected", b.dataset.m === mode ? "true" : "false");
    }
    tbox.hidden = mode === "none";
    t2wrap.hidden = mode !== "range";
    tl1.textContent = mode === "range" ? "开始" : "几点开始";

    thint.textContent = "";
    thint.style.color = "var(--ink-3)";
    if (mode === "range" && t1.value && t2.value) {
      const d = formatDuration(t1.value, t2.value);
      if (d) {
        thint.textContent = `共 ${d}`;
      } else {
        thint.textContent = "结束时间比开始早了，检查一下";
        thint.style.color = "var(--danger)";
      }
    } else if (mode === "point" && t1.value) {
      thint.textContent = "会在行程里明显标出来";
    }
  };

  tmode.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-m]");
    if (!b) return;
    mode = b.dataset.m;
    if (mode === "none") {
      t1.value = "";
      t2.value = "";
    } else if (mode === "point") {
      t2.value = "";
    }
    paintTime();
    // 切到需要填时间的模式时顺手把选择器叫起来，少点一次。
    // showPicker 必须在用户手势的同步流程里调用，放进 setTimeout 会被浏览器拒绝，
    // 而且不是所有浏览器都支持，所以包一层 try 静默失败 —— 用户仍可手动点输入框。
    if (mode !== "none" && !t1.value) {
      t1.focus();
      try {
        t1.showPicker?.();
      } catch {}
    }
  });

  t1.addEventListener("change", paintTime);
  t2.addEventListener("change", paintTime);
  paintTime();

  // 名字变了就重新猜类型（用户手动选过就不再覆盖）
  let typeTouched = !isNew;
  typeBox.addEventListener("click", () => (typeTouched = true), { once: true });
  nameEl.addEventListener("input", () => {
    if (typeTouched) return;
    const g = guessStopType(nameEl.value);
    if (g !== draft.type) {
      draft.type = g;
      paintType();
    }
  });

  // 当前位置
  s.body.querySelector("#f-locate").onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "定位中…";
    try {
      const pos = await locate();
      draft.latitude = pos.latitude;
      draft.longitude = pos.longitude;
      paintCoord();
      ok("已获取位置");
      // 顺手猜个名字
      if (!nameEl.value.trim() && hasKey()) {
        const rg = await reverseGeocode(pos.latitude, pos.longitude);
        if (rg.name) {
          nameEl.value = rg.name;
          if (!typeTouched) {
            draft.type = guessStopType(rg.name);
            paintType();
          }
        }
      }
    } catch (e2) {
      err(e2.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "📍 当前位置";
    }
  };

  // 地图点选：收起弹层，让用户点地图。
  // 弹层要重开，所以已填的内容必须全部带回去 —— 名字、想法、类型、时间，
  // 漏一样用户就得重填一次。
  s.body.querySelector("#f-pick").onclick = () => {
    const keep = {
      name: nameEl.value,
      note: noteEl.value,
      type: draft.type,
      startTime: mode === "none" ? "" : normalizeTime(t1.value),
      endTime: mode === "range" ? normalizeTime(t2.value) : "",
    };
    s.close();
    toast("在地图上点一下要标记的位置", "", 3000);
    setPickMode(true, async (pt) => {
      setPickMode(false);
      clearPickMarker();
      let nm = keep.name;
      if (!nm && hasKey()) {
        const rg = await reverseGeocode(pt.latitude, pt.longitude);
        nm = rg.name || "";
      }
      openStopSheet(trip, dayId, stop, {
        seed: { ...pt, ...keep, name: nm },
        onSaved,
      });
    });
  };

  // 搜地名
  s.body.querySelector("#f-search").onclick = () => {
    if (!hasKey()) {
      err("还没配高德 Key，去设置里填一下");
      return;
    }
    openSearchSheet(nameEl.value, (r) => {
      draft.latitude = r.latitude;
      draft.longitude = r.longitude;
      draft.type = r.type;
      nameEl.value = r.name;
      typeTouched = true;
      paintCoord();
      paintType();
    });
  };

  cancel.onclick = () => s.close();
  save.onclick = () => {
    const name = nameEl.value.trim();
    if (!name) {
      err("给这个地点起个名字");
      nameEl.focus();
      return;
    }
    // 时间：按当前模式取值，"不填"就清空。
    // 结束早于开始不阻止保存 —— 用户可能先填结束再改开始，
    // 卡住反而烦人；行程里会用红色标出来。
    const startTime = mode === "none" ? "" : normalizeTime(t1.value);
    const endTime = mode === "range" ? normalizeTime(t2.value) : "";

    const fields = {
      name,
      latitude: draft.latitude,
      longitude: draft.longitude,
      type: draft.type,
      note: noteEl.value.trim(),
      startTime,
      endTime,
    };
    if (isNew) {
      store.addStop(trip, dayId, fields);
      ok("已添加");
    } else {
      store.updateStop(trip, stop.id, fields);
      ok("已保存");
    }
    s.close();
    onSaved?.();
  };
}

/** 搜索弹层 */
export function openSearchSheet(initial, onPick) {
  const s = sheet({ title: "搜地名" });
  s.body.innerHTML = `
    <div class="field" style="margin-bottom:10px">
      <div class="row">
        <input class="input" id="q" placeholder="地名关键词" autocomplete="off">
        <button class="btn btn-primary" id="go" style="flex:0 0 68px">搜索</button>
      </div>
      <div class="hint" id="tip">支持全国搜索。名字越具体结果越准。</div>
    </div>
    <div id="results"></div>
  `;
  const q = s.body.querySelector("#q");
  const tip = s.body.querySelector("#tip");
  const box = s.body.querySelector("#results");
  q.value = (initial || "").trim();

  const run = async () => {
    const kw = q.value.trim();
    if (!kw) return;
    box.innerHTML = "";
    tip.textContent = "搜索中…";
    try {
      const list = await searchPlaces(kw);
      tip.textContent = list.length ? `找到 ${list.length} 个` : "没找到，换个说法试试";
      for (const r of list) {
        const b = h(
          "button",
          { class: "result" },
          h("div", { class: "nm", text: r.name }),
          h("div", { class: "ad", text: r.address || "" })
        );
        b.onclick = () => {
          onPick(r);
          s.close();
        };
        box.appendChild(b);
      }
    } catch (e) {
      tip.textContent =
        e.message === "NO_KEY" ? "还没配 Key" : e.message;
      tip.style.color = "var(--danger)";
    }
  };

  s.body.querySelector("#go").onclick = run;
  q.addEventListener("keydown", (e) => {
    if (e.key === "Enter") run();
  });
  setTimeout(() => q.focus(), 260);
  if (q.value) run();
}

/** 选交通方式 */
export function openTransportSheet(trip, fromId, toId, current, onDone) {
  const s = sheet({ title: "怎么去的" });
  s.body.appendChild(
    optionGrid(TRANSPORT, current, (k) => {
      store.setTransport(trip, fromId, toId, k);
      s.close();
      onDone?.();
    })
  );
}

// ---------- 素材上传 ----------

/**
 * 处理选中的文件。
 * 照片：压到 PHOTO_MAX_EDGE 存原件，另存缩略图。
 * 视频：原样存（不敢重编码，手机上太慢），取首帧当封面。
 *
 * 拍摄时间在这里读出来存住 —— 照片一经转发这个信息就没了。
 */
export async function ingestFiles(trip, stopId, files, onProgress) {
  const list = Array.from(files || []);
  if (!list.length) return 0;

  let done = 0;
  for (const file of list) {
    onProgress?.(done / list.length * 100, `处理第 ${done + 1} / ${list.length} 个`);
    try {
      const isVideo = file.type.startsWith("video/");
      if (isVideo) {
        const t = await media.videoThumb(file);
        const meta = createMedia({
          kind: "video",
          name: file.name,
          mime: file.type,
          size: file.size,
          width: t?.width || 0,
          height: t?.height || 0,
          duration: t?.duration || 0,
          shotAt: file.lastModified || null,
        });
        await media.putBlob(meta.id, file);
        if (t?.blob) await media.putThumb(meta.id, t.blob);
        store.attachMedia(trip, stopId, meta);
      } else if (file.type.startsWith("image/")) {
        const shotAt = (await media.readShotAt(file)) || file.lastModified || null;
        const full = await media.compressImage(file, PHOTO_MAX_EDGE, 0.88);
        const thumb = await media.compressImage(file, THUMB_MAX_EDGE, 0.75);
        const meta = createMedia({
          kind: "image",
          name: file.name,
          mime: "image/jpeg",
          size: full.blob.size,
          width: full.width || full.origWidth || 0,
          height: full.height || full.origHeight || 0,
          shotAt,
        });
        await media.putBlob(meta.id, full.blob);
        await media.putThumb(meta.id, thumb.blob);
        store.attachMedia(trip, stopId, meta);
      } else {
        continue; // 不认的类型跳过
      }
      done++;
    } catch (e) {
      console.error("素材处理失败", file.name, e);
      err(`「${file.name}」处理失败，跳过了`);
    }
  }
  onProgress?.(100, "");
  return done;
}

/** 触发文件选择 */
export function pickFiles(trip, stopId, onDone) {
  const input = h("input", {
    type: "file",
    accept: "image/*,video/*",
    multiple: true,
    style: "display:none",
  });
  document.body.appendChild(input);
  input.onchange = async () => {
    const files = input.files;
    input.remove();
    if (!files || !files.length) return;
    const b = busy("正在处理素材…");
    try {
      const n = await ingestFiles(trip, stopId, files, (pct, msg) => b.set(pct, msg));
      // 按拍摄时间排好，导出时顺序就是对的
      store.sortMediaByShotAt(trip, stopId);
      b.done();
      if (n) ok(`加了 ${n} 个素材`);
    } catch (e) {
      b.done();
      err("处理失败：" + e.message);
    }
    onDone?.();
  };
  input.click();
}

// ---------- 查看器 ----------

/** 全屏看图/看视频，左右滑切换 */
export async function openViewer(stop, index) {
  const list = stop.media || [];
  if (!list.length) return;
  let i = Math.max(0, Math.min(index, list.length - 1));
  let objUrl = null;

  const el = h("div", { class: "viewer" });
  el.innerHTML = `
    <div class="viewer-top">
      <button class="btn-icon" data-x aria-label="关闭">✕</button>
      <div class="t"></div>
      <button class="btn-icon" data-del aria-label="删除">🗑</button>
    </div>
    <div class="viewer-stage"></div>
    <div class="viewer-foot"></div>
  `;
  document.body.appendChild(el);

  const stage = el.querySelector(".viewer-stage");
  const titleEl = el.querySelector(".t");
  const footEl = el.querySelector(".viewer-foot");

  const cleanup = () => {
    if (objUrl) URL.revokeObjectURL(objUrl);
    objUrl = null;
  };

  const paint = async () => {
    cleanup();
    stage.innerHTML = "";
    const m = list[i];
    if (!m) return;
    titleEl.textContent = `${stop.name} · ${i + 1}/${list.length}`;
    const shot = m.shotAt ? new Date(m.shotAt).toLocaleString("zh-CN") : "";
    footEl.textContent = [shot, m.name, media.formatBytes(m.size)]
      .filter(Boolean)
      .join(" · ");

    const blob = await media.getBlob(m.id);
    if (!blob) {
      stage.innerHTML = `<div style="color:#a09689">素材丢了</div>`;
      return;
    }
    objUrl = URL.createObjectURL(blob);
    if (m.kind === "video") {
      const v = h("video", { src: objUrl, controls: true, playsinline: true, autoplay: true });
      stage.appendChild(v);
    } else {
      stage.appendChild(h("img", { src: objUrl, alt: m.name || "" }));
    }
  };

  const close = () => {
    cleanup();
    el.remove();
  };
  el.querySelector("[data-x]").onclick = close;

  el.querySelector("[data-del]").onclick = async () => {
    const m = list[i];
    if (!m) return;
    if (!(await confirmSheet("删掉这个素材？", "删了就找不回来了。", { danger: true, okText: "删除" })))
      return;
    close();
    window.__tnDeleteMedia?.(stop.id, m.id);
  };

  // 左右滑
  let x0 = null;
  stage.addEventListener("touchstart", (e) => (x0 = e.touches[0].clientX), { passive: true });
  stage.addEventListener(
    "touchend",
    (e) => {
      if (x0 == null) return;
      const dx = e.changedTouches[0].clientX - x0;
      x0 = null;
      if (Math.abs(dx) < 46) return;
      const next = i + (dx < 0 ? 1 : -1);
      if (next >= 0 && next < list.length) {
        i = next;
        paint();
      }
    },
    { passive: true }
  );

  const onKey = (e) => {
    if (e.key === "Escape") {
      close();
      document.removeEventListener("keydown", onKey);
    } else if (e.key === "ArrowRight" && i + 1 < list.length) {
      i++;
      paint();
    } else if (e.key === "ArrowLeft" && i > 0) {
      i--;
      paint();
    }
  };
  document.addEventListener("keydown", onKey);

  paint();
}

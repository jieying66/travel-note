// ============================================================
// 行程仓库
//
// 行程结构（文字、坐标、素材元数据）存 localStorage —— 小、同步读写、简单。
// 素材二进制存 IndexedDB（media.js）。
//
// 注意：localStorage 会被"清理浏览器数据"清掉。
// 所以 export.js 提供备份成文件的功能，重要行程记完导一份存着。
// ============================================================

import {
  createTrip, createStop, createSegment,
  daysBetween, addDays, newId, DEFAULT_TRANSPORT,
} from "./model.js";
import { deleteMedia } from "./media.js";

const KEY_TRIPS = "tn.trips";
const KEY_SETTINGS = "tn.settings";

// ---------- 底层 ----------

function readAll() {
  try {
    const raw = localStorage.getItem(KEY_TRIPS);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return []; // 数据坏了不至于让整个应用打不开
  }
}

function writeAll(trips) {
  try {
    localStorage.setItem(KEY_TRIPS, JSON.stringify(trips));
    return true;
  } catch (e) {
    // 写满了。行程文字很小，正常到不了这一步；真到了要让用户知道
    console.error("行程保存失败", e);
    alert("保存失败,存储空间可能已满。建议先导出备份,再删掉不用的素材。");
    return false;
  }
}

// ---------- 旅行 ----------

export function listTrips() {
  return readAll().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export function getTrip(id) {
  return readAll().find((t) => t.id === id) || null;
}

export function saveTrip(trip) {
  const trips = readAll();
  const i = trips.findIndex((t) => t.id === trip.id);
  trip.updatedAt = Date.now();
  if (i >= 0) trips[i] = trip;
  else trips.push(trip);
  writeAll(trips);
  return trip;
}

export function addTrip(fields) {
  return saveTrip(createTrip(fields));
}

/** 删除旅行，连带清掉它所有素材的二进制 */
export async function deleteTrip(id) {
  const trip = getTrip(id);
  if (trip) {
    for (const stop of trip.stops || []) {
      for (const m of stop.media || []) {
        await deleteMedia(m.id).catch(() => {});
      }
    }
  }
  writeAll(readAll().filter((t) => t.id !== id));
}

/**
 * 改起止日期时同步天数。
 * 加天数：往后补空的 Day。
 * 减天数：被砍掉的那些天，地点会移到最后一天，不静默丢数据。
 */
export function resizeDays(trip) {
  const want = daysBetween(trip.startDate, trip.endDate);
  const have = trip.days.length;

  if (want > have) {
    for (let i = have; i < want; i++) {
      trip.days.push({ id: newId("day"), day: i + 1, date: addDays(trip.startDate, i) });
    }
  } else if (want < have) {
    const dropped = trip.days.slice(want);
    trip.days = trip.days.slice(0, want);
    const last = trip.days[trip.days.length - 1];
    const droppedIds = new Set(dropped.map((d) => d.id));
    for (const s of trip.stops) {
      if (droppedIds.has(s.dayId)) {
        s.dayId = last.id;
        s.day = last.day;
      }
    }
    reorderDay(trip, last.id);
  }

  // 日期整体平移时刷新每天的日期
  trip.days.forEach((d, i) => {
    d.day = i + 1;
    d.date = addDays(trip.startDate, i);
  });
  return trip;
}

// ---------- 地点 ----------

export function stopsOfDay(trip, dayId) {
  return trip.stops
    .filter((s) => s.dayId === dayId)
    .sort((a, b) => a.order - b.order);
}

function reorderDay(trip, dayId) {
  stopsOfDay(trip, dayId).forEach((s, i) => (s.order = i));
}

export function addStop(trip, dayId, fields) {
  const day = trip.days.find((d) => d.id === dayId);
  if (!day) return null;
  const stop = createStop({ ...fields, dayId, day: day.day });
  stop.order = stopsOfDay(trip, dayId).length;
  trip.stops.push(stop);
  syncSegments(trip, dayId);
  saveTrip(trip);
  return stop;
}

export function updateStop(trip, stopId, patch) {
  const s = trip.stops.find((x) => x.id === stopId);
  if (!s) return null;
  Object.assign(s, patch);
  saveTrip(trip);
  return s;
}

export async function removeStop(trip, stopId) {
  const s = trip.stops.find((x) => x.id === stopId);
  if (!s) return;
  for (const m of s.media || []) {
    await deleteMedia(m.id).catch(() => {});
  }
  const dayId = s.dayId;
  trip.stops = trip.stops.filter((x) => x.id !== stopId);
  reorderDay(trip, dayId);
  syncSegments(trip, dayId);
  saveTrip(trip);
}

/** 在同一天内上下移动 */
export function moveStop(trip, stopId, dir) {
  const s = trip.stops.find((x) => x.id === stopId);
  if (!s) return;
  const list = stopsOfDay(trip, s.dayId);
  const i = list.findIndex((x) => x.id === stopId);
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i].order, list[j].order] = [list[j].order, list[i].order];
  syncSegments(trip, s.dayId);
  saveTrip(trip);
}

/** 挪到别的一天，放到那天末尾 */
export function moveStopToDay(trip, stopId, dayId) {
  const s = trip.stops.find((x) => x.id === stopId);
  const day = trip.days.find((d) => d.id === dayId);
  if (!s || !day || s.dayId === dayId) return;
  const from = s.dayId;
  s.dayId = dayId;
  s.day = day.day;
  s.order = stopsOfDay(trip, dayId).length;
  reorderDay(trip, from);
  syncSegments(trip, from);
  syncSegments(trip, dayId);
  saveTrip(trip);
}

// ---------- 行程段 ----------

/**
 * 保证每天相邻地点之间都有一段，且没有多余的段。
 * 已有的段保留用户选的交通方式，不重置。
 */
function syncSegments(trip, dayId) {
  const list = stopsOfDay(trip, dayId);
  const wanted = [];
  for (let i = 0; i + 1 < list.length; i++) {
    wanted.push([list[i].id, list[i + 1].id]);
  }
  const dayStopIds = new Set(list.map((s) => s.id));

  // 清掉这天内失效的段（两端地点变了或被删了）
  trip.segments = trip.segments.filter((seg) => {
    const inThisDay = dayStopIds.has(seg.fromStopId) || dayStopIds.has(seg.toStopId);
    if (!inThisDay) return true; // 别的天的，不动
    return wanted.some(([a, b]) => seg.fromStopId === a && seg.toStopId === b);
  });

  for (const [a, b] of wanted) {
    if (!trip.segments.some((s) => s.fromStopId === a && s.toStopId === b)) {
      trip.segments.push(createSegment({ fromStopId: a, toStopId: b }));
    }
  }
}

export function getSegment(trip, fromId, toId) {
  return trip.segments.find((s) => s.fromStopId === fromId && s.toStopId === toId) || null;
}

export function setTransport(trip, fromId, toId, transport) {
  let seg = getSegment(trip, fromId, toId);
  if (!seg) {
    seg = createSegment({ fromStopId: fromId, toStopId: toId, transport });
    trip.segments.push(seg);
  } else {
    seg.transport = transport;
  }
  saveTrip(trip);
  return seg;
}

// ---------- 素材 ----------

export function attachMedia(trip, stopId, meta) {
  const s = trip.stops.find((x) => x.id === stopId);
  if (!s) return null;
  s.media = s.media || [];
  s.media.push(meta);
  saveTrip(trip);
  return meta;
}

export async function removeMediaFrom(trip, stopId, mediaId) {
  const s = trip.stops.find((x) => x.id === stopId);
  if (!s) return;
  s.media = (s.media || []).filter((m) => m.id !== mediaId);
  await deleteMedia(mediaId).catch(() => {});
  saveTrip(trip);
}

/** 按拍摄时间排序一个地点的素材（读不到拍摄时间的排后面，保持原顺序） */
export function sortMediaByShotAt(trip, stopId) {
  const s = trip.stops.find((x) => x.id === stopId);
  if (!s || !s.media) return;
  s.media.sort((a, b) => {
    const ta = a.shotAt || Infinity;
    const tb = b.shotAt || Infinity;
    if (ta === tb) return (a.createdAt || 0) - (b.createdAt || 0);
    return ta - tb;
  });
  saveTrip(trip);
}

/** 全部素材数量统计 */
export function mediaStats(trip) {
  let images = 0, videos = 0, bytes = 0;
  for (const s of trip.stops || []) {
    for (const m of s.media || []) {
      if (m.kind === "video") videos++;
      else images++;
      bytes += m.size || 0;
    }
  }
  return { images, videos, bytes };
}

// ---------- 设置 ----------

export function getSettings() {
  try {
    return JSON.parse(localStorage.getItem(KEY_SETTINGS)) || {};
  } catch {
    return {};
  }
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  localStorage.setItem(KEY_SETTINGS, JSON.stringify(next));
  return next;
}

// ---------- 备份 ----------

/** 整库导出（不含素材二进制，那个走 export.js 的打包） */
export function exportAllJSON() {
  return JSON.stringify(
    { version: 1, exportedAt: Date.now(), trips: readAll(), settings: getSettings() },
    null,
    2
  );
}

/** 导入备份。合并策略：同 id 的跳过，不覆盖现有数据。 */
export function importJSON(text) {
  const data = JSON.parse(text);
  const incoming = Array.isArray(data) ? data : data.trips;
  if (!Array.isArray(incoming)) throw new Error("文件格式不对");
  const trips = readAll();
  const have = new Set(trips.map((t) => t.id));
  let added = 0;
  for (const t of incoming) {
    if (t && t.id && !have.has(t.id)) {
      trips.push(t);
      added++;
    }
  }
  writeAll(trips);
  return { added, skipped: incoming.length - added };
}

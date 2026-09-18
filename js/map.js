// ============================================================
// 地图
//
// 用 Leaflet + 高德瓦片。为什么不用 Travel Story 的 MapLibre：
//   那套是为了做视频动画（一秒渲染 30 帧地图）设计的,重。
//   我们只要一张能拖能放大的静态地图,Leaflet 小得多、手机上更流畅。
//
// 底图用高德:国内加载快、中文标注全,不需要 key。
// 坐标转换见 coord.js —— 存 WGS-84,画图时转 GCJ-02。
//
// 路线用带弧度的曲线连接,不调路径规划服务:
//   旅行中网络常常很差,等路线转圈不如立刻看到方位。
// ============================================================

import { wgs84ToGcj02, gcj02ToWgs84, distanceMeters, formatDistance } from "./coord.js";
import { STOP_TYPE, TRANSPORT, stopTimeLabel } from "./model.js";

const AMAP_TILES = [
  "https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
  "https://webrd02.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
  "https://webrd03.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
  "https://webrd04.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
];

// 备用底图（高德不通时,比如在境外）
const OSM_TILE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

let map = null;
let layerGroup = null;
let baseLayer = null;
let useAmap = true;
let onMapPick = null;   // 地图点选回调
let pickMode = false;
let pickMarker = null;
let meMarker = null;
let boundEl = null;     // 当前 map 绑定的那个 DOM 容器

/**
 * 初始化。container 是 DOM id。
 *
 * 注意：切换标签页会重建 DOM，#map 是个新元素。
 * 这时必须重建地图 —— 否则 map 还指着已经从文档移除的旧容器，
 * 标记全画进看不见的元素里，地图看起来是空的（图例却正常，很难查）。
 */
export function initMap(containerId, opts = {}) {
  const L = window.L;
  if (!L) throw new Error("Leaflet 未加载");

  const el = document.getElementById(containerId);
  if (!el) throw new Error("找不到地图容器");

  if (map && boundEl === el && el.isConnected) return map;

  if (map) {
    // 容器换了，旧地图连同事件一起销毁，不然内存和监听会越积越多
    try { map.remove(); } catch {}
    map = null;
    layerGroup = null;
    baseLayer = null;
    pickMarker = null;
    meMarker = null;
  }
  // Leaflet 在同一个元素上重复初始化会抛错，清掉它留下的标记
  if (el._leaflet_id) delete el._leaflet_id;
  boundEl = el;

  map = L.map(containerId, {
    zoomControl: false,
    attributionControl: true,
    // 手机上双指缩放更顺
    tap: false,
  }).setView(opts.center || [35.86, 104.19], opts.zoom || 4);

  setBase(useAmap);
  layerGroup = L.layerGroup().addTo(map);

  map.on("click", (e) => {
    if (!pickMode || !onMapPick) return;
    // 地图上的坐标是 GCJ-02,转回 WGS-84 再交出去
    const { lat, lon } = gcj02ToWgs84(e.latlng.lat, e.latlng.lng);
    if (pickMarker) map.removeLayer(pickMarker);
    pickMarker = L.marker(e.latlng, { icon: pinIcon("＋", true) }).addTo(map);
    onMapPick({ latitude: lat, longitude: lon });
  });

  return map;
}

function setBase(amap) {
  const L = window.L;
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = amap
    ? L.tileLayer(AMAP_TILES[0], {
        subdomains: "1234",
        maxZoom: 18,
        attribution: "高德地图",
      })
    : L.tileLayer(OSM_TILE, {
        maxZoom: 19,
        attribution: "© OpenStreetMap",
      });
  baseLayer.addTo(map);
  useAmap = amap;
}

/** 切换底图（境外时 OSM 更准） */
export function toggleBase() {
  setBase(!useAmap);
  return useAmap ? "高德" : "OSM";
}

export function isAmapBase() {
  return useAmap;
}

function pinIcon(label, highlight = false) {
  const L = window.L;
  return L.divIcon({
    className: "",
    html: `<div class="pin${highlight ? "" : " dim"}">${label}</div>`,
    iconSize: [27, 27],
    iconAnchor: [13, 13],
  });
}

/**
 * 画整趟旅行。
 * stops 已排好序（第几天 → 第几个）。
 * highlightDay 传第几天则只高亮那一天,其余变灰。
 */
export function renderTrip(trip, stopsInOrder, opts = {}) {
  if (!map || !layerGroup) return;
  const L = window.L;
  layerGroup.clearLayers();

  const withCoord = stopsInOrder.filter(
    (s) => isFinite(s.latitude) && isFinite(s.longitude)
  );
  if (!withCoord.length) return;

  const highlightDay = opts.highlightDay ?? null;
  const pts = [];

  // 先画线,让标记盖在线上面
  const byDay = new Map();
  for (const s of withCoord) {
    if (!byDay.has(s.day)) byDay.set(s.day, []);
    byDay.get(s.day).push(s);
  }

  for (const [day, list] of byDay) {
    const dim = highlightDay !== null && day !== highlightDay;
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i];
      const b = list[i + 1];
      const seg = trip.segments.find(
        (x) => x.fromStopId === a.id && x.toStopId === b.id
      );
      const kind = seg ? TRANSPORT[seg.transport]?.kind : "road";
      drawLeg(a, b, { dim, kind });
    }
  }

  for (const s of withCoord) {
    const g = wgs84ToGcj02(s.latitude, s.longitude);
    const ll = [g.lat, g.lon];
    pts.push(ll);
    const dim = highlightDay !== null && s.day !== highlightDay;
    const order = (s.order ?? 0) + 1;
    const meta = STOP_TYPE[s.type] || STOP_TYPE.other;

    L.marker(ll, { icon: pinIcon(String(order), !dim), zIndexOffset: dim ? 0 : 500 })
      .bindPopup(
        (() => {
          const tl = stopTimeLabel(s);
          return tl
            ? `<div style="color:#b8551a;font-weight:700;font-size:14px;margin-bottom:2px">` +
                `🕐 ${escapeHtml(tl.text)}</div>`
            : "";
        })() +
          `<b>${escapeHtml(s.name)}</b><br>` +
          `<span style="color:#6b6259;font-size:12.5px">` +
          `第${s.day}天 · 第${order}站 · ${meta.icon} ${meta.label}` +
          `</span>` +
          (s.note
            ? `<br><span style="font-size:12.5px">${escapeHtml(
                s.note.slice(0, 60)
              )}${s.note.length > 60 ? "…" : ""}</span>`
            : "") +
          ((s.media || []).length
            ? `<br><span style="color:#a09689;font-size:12px">${
                s.media.length
              } 个素材</span>`
            : "")
      )
      .addTo(layerGroup);
  }

  if (opts.fit !== false && pts.length) {
    const b = L.latLngBounds(pts);
    map.fitBounds(b, { padding: [44, 44], maxZoom: 15, animate: false });
  }
}

/**
 * 一段路。
 * 飞机/火箭这类走弧线（明显是"飞过去"）,地面交通走轻微弧度的线。
 * 不调真实路径服务,理由见文件头。
 */
function drawLeg(a, b, { dim, kind }) {
  const L = window.L;
  const ga = wgs84ToGcj02(a.latitude, a.longitude);
  const gb = wgs84ToGcj02(b.latitude, b.longitude);

  const air = kind === "air";
  const curve = air ? 0.22 : 0.08;
  const coords = arcPoints([ga.lat, ga.lon], [gb.lat, gb.lon], curve);

  L.polyline(coords, {
    color: dim ? "#c4bbae" : air ? "#8a6fb0" : "#d2691e",
    weight: dim ? 1.6 : 2.4,
    opacity: dim ? 0.55 : 0.9,
    dashArray: air ? "6 6" : null,
    lineCap: "round",
  }).addTo(layerGroup);
}

/** 两点之间的弧线采样点。curve 是弯曲程度。 */
function arcPoints(from, to, curve = 0.1, n = 40) {
  const [lat1, lon1] = from;
  const [lat2, lon2] = to;
  // 中点往垂直方向偏移,得到二次贝塞尔的控制点
  const mLat = (lat1 + lat2) / 2;
  const mLon = (lon1 + lon2) / 2;
  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;
  const cLat = mLat - dLon * curve;
  const cLon = mLon + dLat * curve;

  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([
      u * u * lat1 + 2 * u * t * cLat + t * t * lat2,
      u * u * lon1 + 2 * u * t * cLon + t * t * lon2,
    ]);
  }
  return out;
}

/** 定位到某个地点 */
export function focusStop(stop, zoom = 14) {
  if (!map || !isFinite(stop.latitude)) return;
  const g = wgs84ToGcj02(stop.latitude, stop.longitude);
  map.setView([g.lat, g.lon], zoom, { animate: true });
}

/** 进入/退出"在地图上点选"模式 */
export function setPickMode(on, cb) {
  pickMode = on;
  onMapPick = cb || null;
  if (map) {
    map.getContainer().style.cursor = on ? "crosshair" : "";
  }
  if (!on && pickMarker) {
    map.removeLayer(pickMarker);
    pickMarker = null;
  }
}

export function clearPickMarker() {
  if (pickMarker && map) {
    map.removeLayer(pickMarker);
    pickMarker = null;
  }
}

/** 当前位置。返回 WGS-84（浏览器给的就是这个）。 */
export function locate(timeout = 12000) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("这个浏览器不支持定位"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        }),
      (err) => {
        const msg =
          err.code === 1
            ? "定位权限被拒绝,请在浏览器设置里允许"
            : err.code === 2
            ? "拿不到位置,试试到室外或开启 GPS"
            : "定位超时,再试一次";
        reject(new Error(msg));
      },
      { enableHighAccuracy: true, timeout, maximumAge: 30000 }
    );
  });
}

/** 显示当前位置蓝点（meMarker 在文件头声明，重建地图时要一起清） */
export function showMe(lat, lon) {
  if (!map) return;
  const L = window.L;
  const g = wgs84ToGcj02(lat, lon);
  if (meMarker) map.removeLayer(meMarker);
  meMarker = L.circleMarker([g.lat, g.lon], {
    radius: 7,
    color: "#fff",
    weight: 2.5,
    fillColor: "#2d7ff9",
    fillOpacity: 1,
  }).addTo(map);
  map.setView([g.lat, g.lon], Math.max(map.getZoom(), 13), { animate: true });
}

/** 相邻地点直线距离,给时间轴显示 */
export function legDistance(a, b) {
  if (!a || !b) return "";
  const m = distanceMeters(a.latitude, a.longitude, b.latitude, b.longitude);
  return formatDistance(m);
}

export function invalidate() {
  if (map) setTimeout(() => map.invalidateSize(), 60);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

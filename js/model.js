// ============================================================
// 数据模型
//
// 结构：Trip（一趟旅行） → Day（第几天） → Stop（地点） → Media（照片/视频）
// 这个层级就是导出时的顺序保证：第几天 → 第几个地点 → 第几张照片。
//
// 坐标一律存 WGS-84（见 coord.js 顶部说明）。
// 照片/视频的二进制存在 IndexedDB，这里只存元数据。
// ============================================================

/** 交通方式（沿用 Travel Story 的 15 种，含几个玩的） */
export const TRANSPORT = {
  car:        { label: "汽车",   icon: "🚗", kind: "road" },
  bus:        { label: "巴士",   icon: "🚌", kind: "road" },
  train:      { label: "火车",   icon: "🚆", kind: "rail" },
  subway:     { label: "地铁",   icon: "🚇", kind: "rail" },
  plane:      { label: "飞机",   icon: "✈️", kind: "air"  },
  ship:       { label: "轮船",   icon: "🚢", kind: "water"},
  kayak:      { label: "皮划艇", icon: "🛶", kind: "water"},
  motorcycle: { label: "摩托",   icon: "🏍️", kind: "road" },
  bicycle:    { label: "自行车", icon: "🚲", kind: "road" },
  scooter:    { label: "电动车", icon: "🛵", kind: "road" },
  walk:       { label: "步行",   icon: "🚶", kind: "foot" },
  horse:      { label: "骑马",   icon: "🐎", kind: "foot" },
  ufo:        { label: "飞碟",   icon: "🛸", kind: "air"  },
  swim:       { label: "游泳",   icon: "🏊", kind: "water"},
  rocket:     { label: "火箭",   icon: "🚀", kind: "air"  },
};

export const DEFAULT_TRANSPORT = "car";

/** 地点类型（沿用 23 种，决定地图标记的图标） */
export const STOP_TYPE = {
  attraction: { label: "景点",     icon: "📍" },
  museum:     { label: "博物馆",   icon: "🏛️" },
  park:       { label: "公园",     icon: "🌳" },
  zoo:        { label: "动物园",   icon: "🦁" },
  hotel:      { label: "酒店",     icon: "🏨" },
  airport:    { label: "机场",     icon: "✈️" },
  station:    { label: "车站",     icon: "🚉" },
  beach:      { label: "海滩",     icon: "🏖️" },
  lake:       { label: "湖泊",     icon: "🏞️" },
  mountain:   { label: "山",       icon: "⛰️" },
  restaurant: { label: "餐厅",     icon: "🍜" },
  scenic:     { label: "风景区",   icon: "🌄" },
  city:       { label: "城市",     icon: "🏙️" },
  tower:      { label: "高塔",     icon: "🗼" },
  skyscraper: { label: "高楼",     icon: "🏢" },
  skyline:    { label: "建筑群",   icon: "🌆" },
  garden:     { label: "园林",     icon: "🌸" },
  forest:     { label: "森林",     icon: "🌲" },
  river:      { label: "江河",     icon: "🌊" },
  sea:        { label: "海洋",     icon: "🌊" },
  temple:     { label: "寺庙",     icon: "⛩️" },
  bridge:     { label: "桥梁",     icon: "🌉" },
  other:      { label: "其他",     icon: "📌" },
};

export const DEFAULT_STOP_TYPE = "attraction";

/**
 * 按地名关键词猜地点类型。
 * 搜索结果和手动命名都走这里，猜错了用户可以改。
 * 顺序有讲究：更具体的关键词排前面（"美术馆"要在"馆"之前命中）。
 */
const TYPE_HINTS = [
  [/机场|航站楼/,                          "airport"],
  // 「杭州东站」「上海虹桥站」这类简称也要认出来，所以单独一条 站$
  [/火车站|高铁站|动车站|客运站|汽车站|地铁站|站$/, "station"],
  [/酒店|宾馆|旅馆|民宿|客栈|青旅/,          "hotel"],
  [/博物馆|美术馆|纪念馆|科技馆|展览馆|艺术馆/, "museum"],
  [/动物园|海洋馆|水族馆/,                   "zoo"],
  // 「拙政园」「留园」这类江南园林都是 …园 结尾，但要排在「公园」之后判断，
  // 所以这里用 园$ 而不是 园，公园那条在下面靠 公园 先命中
  [/植物园|花园|园林|苗圃/,                  "garden"],
  [/公园|绿地|广场/,                        "park"],
  [/园$/,                                   "garden"],
  [/寺|庙|观音|禅院|道观|教堂|清真寺|塔院|祠/, "temple"],
  [/塔$|宝塔|电视塔|钟楼|鼓楼/,              "tower"],
  [/大厦|中心大楼|写字楼|摩天/,              "skyscraper"],
  [/海滩|沙滩|海滨|海岸/,                    "beach"],
  [/湖$|湖泊|水库|潭$/,                      "lake"],
  [/山$|山脉|峰$|岭$|崖|峡谷/,               "mountain"],
  [/江$|河$|溪$|运河/,                       "river"],
  [/海$|海域|湾$/,                           "sea"],
  [/桥$|大桥|立交/,                          "bridge"],
  [/森林|林场|竹海/,                         "forest"],
  [/餐厅|饭店|food|美食|小吃|火锅|烧烤|咖啡|茶楼|酒楼/i, "restaurant"],
  [/风景区|景区|度假区|游览区/,              "scenic"],
  [/古镇|古城|老街|胡同|步行街/,             "attraction"],
  [/市$|区$|县$|镇$|村$|城$/,                "city"],
  [/景点|遗址|故居|陵|墓|碑/,                "attraction"],
];

export function guessStopType(name = "") {
  for (const [re, type] of TYPE_HINTS) {
    if (re.test(name)) return type;
  }
  return DEFAULT_STOP_TYPE;
}

// ---------- ID ----------

/** 短 ID。不追求全局唯一，同一台手机内不撞就够。 */
export function newId(prefix = "") {
  const s = Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  return prefix ? `${prefix}_${s}` : s;
}

// ---------- 日期 ----------

/** Date → YYYY-MM-DD（本地时区，不用 toISOString 以免时区偏一天） */
export function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseDateStr(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** 起止日期之间的天数（含首尾） */
export function daysBetween(startStr, endStr) {
  const a = parseDateStr(startStr);
  const b = parseDateStr(endStr);
  const diff = Math.round((b - a) / 86400000);
  return Math.max(1, diff + 1);
}

export function addDays(dateStr, n) {
  const d = parseDateStr(dateStr);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

/** "3月15日 周六" */
export function formatDateCN(dateStr) {
  const d = parseDateStr(dateStr);
  const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日 ${week}`;
}

// ---------- 工厂 ----------

export function createTrip({ name, startDate, endDate, description = "" }) {
  const trip = {
    id: newId("trip"),
    name: name || "未命名旅行",
    startDate,
    endDate,
    description,
    coverHue: Math.floor(Math.random() * 360),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    days: [],
    stops: [],
    segments: [],
  };
  const n = daysBetween(startDate, endDate);
  for (let i = 0; i < n; i++) {
    trip.days.push({
      id: newId("day"),
      day: i + 1,
      date: addDays(startDate, i),
    });
  }
  return trip;
}

export function createStop({
  dayId, day, name, latitude, longitude, type, note = "",
  startTime = "", endTime = "",
}) {
  return {
    id: newId("stop"),
    dayId,
    day,
    name: name || "未命名地点",
    latitude,
    longitude,
    type: type || guessStopType(name),
    note,                // ← Travel Story 没有这个字段，是你要的"所思所想"
    // 时间可选，"HH:MM" 或空字符串。
    // 只填 startTime = "几点出发"；两个都填 = 时段（如航班起降）。
    // 不参与排序，顺序由用户手动控制。
    startTime,
    endTime,
    order: 0,            // 由 store 重排
    media: [],
    createdAt: Date.now(),
  };
}

// ---------- 时间 ----------

/** "HH:MM" 是否合法 */
export function isValidTime(s) {
  const m = String(s || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h >= 0 && h <= 23 && mi >= 0 && mi <= 59;
}

/** "8:5" → "08:05"，非法返回空串 */
export function normalizeTime(s) {
  const m = String(s || "").trim().match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return "";
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return "";
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

/** 分钟数，用来算时长。非法返回 null */
export function timeToMinutes(s) {
  if (!isValidTime(s)) return null;
  const [h, mi] = s.split(":").map(Number);
  return h * 60 + mi;
}

/**
 * 时段时长，人话。跨夜不考虑（用户确认不会有）。
 * 结束比开始早时返回空串，由调用方提示。
 */
export function formatDuration(startTime, endTime) {
  const a = timeToMinutes(startTime);
  const b = timeToMinutes(endTime);
  if (a == null || b == null || b <= a) return "";
  const d = b - a;
  const h = Math.floor(d / 60);
  const mi = d % 60;
  if (!h) return `${mi} 分钟`;
  if (!mi) return `${h} 小时`;
  return `${h} 小时 ${mi} 分`;
}

/** 地点的时间怎么显示。没时间返回 null。 */
export function stopTimeLabel(stop) {
  const s = normalizeTime(stop?.startTime);
  const e = normalizeTime(stop?.endTime);
  if (!s && !e) return null;
  if (s && e) {
    return { kind: "range", text: `${s} – ${e}`, duration: formatDuration(s, e) };
  }
  // 只有结束时间也按单点显示，避免数据异常时啥都不显示
  return { kind: "point", text: s || e, duration: "" };
}

/**
 * 素材元数据。二进制另存 IndexedDB（media.js）。
 * shotAt 是照片自带的拍摄时间，必须在选中文件那一刻就读出来存住 ——
 * 照片一经微信等转发，这个信息就被抹掉了。
 */
export function createMedia({ kind, name, mime, size, width, height, shotAt, duration }) {
  return {
    id: newId("m"),
    kind,                       // "image" | "video"
    name,
    mime,
    size,
    width: width || 0,
    height: height || 0,
    shotAt: shotAt || null,     // 拍摄时间（毫秒），读不到就是 null
    duration: duration || 0,    // 视频时长（秒）
    createdAt: Date.now(),
  };
}

/** 地点之间的行程段（记怎么去的） */
export function createSegment({ fromStopId, toStopId, transport = DEFAULT_TRANSPORT }) {
  return {
    id: newId("seg"),
    fromStopId,
    toStopId,
    transport,
  };
}

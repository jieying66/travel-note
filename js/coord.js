// ============================================================
// 坐标转换：WGS-84 ⇄ GCJ-02
//
// 为什么需要：
//   手机 GPS 给的是 WGS-84（国际标准真实坐标）。
//   高德底图和高德搜索用的是 GCJ-02（国测局加密偏移，"火星坐标"）。
//   两者直接混用会偏几十到几百米，标记会落在马路对面。
//
// 本项目的约定（重要）：
//   存储统一用 WGS-84 —— 标准、可导出、以后换底图不用迁移数据。
//   只在画到地图上的那一刻转成 GCJ-02。
//   高德搜索返回的 GCJ-02 在入库前转成 WGS-84。
//
// 加密只作用于中国境内，境外坐标原样通过。
// 纯数学转换，不涉及任何隐私数据。
// ============================================================

const PI = Math.PI;
const A = 6378245.0;            // 长半轴
const EE = 0.00669342162296594323; // 偏心率平方

/** 是否在中国大陆范围外（偏移只作用于境内） */
export function outOfChina(lat, lon) {
  return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let ret =
    -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320.0 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLon(x, y) {
  let ret =
    300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y +
    0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

/** WGS-84 → GCJ-02（存储 → 画到高德底图上） */
export function wgs84ToGcj02(lat, lon) {
  if (outOfChina(lat, lon)) return { lat, lon };
  const dLat = transformLat(lon - 105.0, lat - 35.0);
  const dLon = transformLon(lon - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  const mLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  const mLon = (dLon * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  return { lat: lat + mLat, lon: lon + mLon };
}

/**
 * GCJ-02 → WGS-84（高德搜索结果 / 地图点选 → 入库）
 * 迭代逼近：用前向函数算当前偏移，把差值回加，3 轮收敛到 1–2 米。
 */
export function gcj02ToWgs84(lat, lon) {
  if (outOfChina(lat, lon)) return { lat, lon };
  let wgsLat = lat;
  let wgsLon = lon;
  for (let i = 0; i < 3; i++) {
    const g = wgs84ToGcj02(wgsLat, wgsLon);
    wgsLat += lat - g.lat;
    wgsLon += lon - g.lon;
  }
  return { lat: wgsLat, lon: wgsLon };
}

/** 两点间直线距离（米），Haversine */
export function distanceMeters(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const dLat = ((bLat - aLat) * PI) / 180;
  const dLon = ((bLon - aLon) * PI) / 180;
  const la1 = (aLat * PI) / 180;
  const la2 = (bLat * PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** 人类可读距离 */
export function formatDistance(m) {
  if (!isFinite(m) || m <= 0) return "";
  if (m < 1000) return `${Math.round(m)} 米`;
  if (m < 10000) return `${(m / 1000).toFixed(1)} 公里`;
  return `${Math.round(m / 1000)} 公里`;
}

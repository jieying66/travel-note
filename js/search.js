// ============================================================
// 地点搜索（高德）
//
// 需要「Web服务」类型的 key。没有 key 也能用应用 ——
// 当前位置打点、地图点选都不需要 key，搜索会提示去设置里填。
//
// 高德返回 GCJ-02，这里统一转成 WGS-84 再交出去（见 coord.js）。
//
// 关于 key 直接从浏览器调用：
//   这个 key 只能查地图和地名，泄露最多被蹭免费额度，
//   不涉及账号或资金。个人自用可以接受。
//   代价是必须在高德控制台把域名白名单留空或设为 *，否则会被拦。
// ============================================================

import { gcj02ToWgs84 } from "./coord.js";
import { guessStopType } from "./model.js";
import { getSettings } from "./store.js";
import { DEFAULT_AMAP_KEY } from "./config.js";

/**
 * 取 key：优先用户在设置里填的，否则回退到内置的。
 *
 * 为什么不只读设置：内置 key 原来只在首次启动时写进设置，
 * 一旦用户清了浏览器数据或换了设备，设置为空就再也搜不了地名，
 * 而且界面只说"未配置"，很难看出是这个原因。
 */
function key() {
  const saved = (getSettings().amapKey || "").trim();
  return saved || (DEFAULT_AMAP_KEY || "").trim();
}

export function hasKey() {
  return !!key();
}

/**
 * 搜地点。
 * city 传城市名可以缩小范围，不传就全国搜。
 * 返回 [{ name, address, latitude, longitude, type }]，坐标是 WGS-84。
 */
export async function searchPlaces(keyword, { city = "", limit = 20 } = {}) {
  const k = key();
  if (!k) throw new Error("NO_KEY");
  const kw = String(keyword || "").trim();
  if (!kw) return [];

  const url =
    "https://restapi.amap.com/v3/place/text" +
    `?key=${encodeURIComponent(k)}` +
    `&keywords=${encodeURIComponent(kw)}` +
    (city ? `&city=${encodeURIComponent(city)}` : "") +
    `&offset=${Math.min(25, limit)}&page=1&extensions=base`;

  let data;
  try {
    const res = await fetch(url);
    data = await res.json();
  } catch {
    throw new Error("网络不通，检查一下连接");
  }

  // 高德的错误信息藏在 info 里，status "0" 是失败
  if (data.status !== "1") {
    const info = String(data.info || "");
    if (/INVALID_USER_KEY|KEY/i.test(info)) {
      throw new Error("Key 无效。确认是「Web服务」类型，不是「JS API」");
    }
    if (/DAILY_QUERY_OVER_LIMIT|QUOTA/i.test(info)) {
      throw new Error("今天的免费额度用完了，明天再试");
    }
    if (/IP|DOMAIN|REFERER/i.test(info)) {
      throw new Error("Key 被白名单拦了。到高德控制台把域名白名单清空");
    }
    throw new Error(info || "搜索失败");
  }

  return (data.pois || [])
    .map((p) => {
      const loc = String(p.location || "");
      const [lonStr, latStr] = loc.split(",");
      const lon = parseFloat(lonStr);
      const lat = parseFloat(latStr);
      if (!isFinite(lat) || !isFinite(lon)) return null;
      const w = gcj02ToWgs84(lat, lon);
      const name = pickStr(p.name);
      return {
        name,
        address: [pickStr(p.cityname), pickStr(p.adname), pickStr(p.address)]
          .filter(Boolean)
          .join(" "),
        city: pickStr(p.cityname),
        latitude: w.lat,
        longitude: w.lon,
        type: guessStopType(name + " " + pickStr(p.type)),
      };
    })
    .filter(Boolean);
}

/**
 * 逆地理编码：坐标 → 地名。
 * 当前位置打点和地图点选后用它猜个名字，用户可以改。
 * 没 key 或失败就返回空字符串，不阻断流程。
 */
export async function reverseGeocode(latitude, longitude) {
  const k = key();
  if (!k) return { name: "", address: "" };
  const { wgs84ToGcj02 } = await import("./coord.js");
  const g = wgs84ToGcj02(latitude, longitude);
  const url =
    "https://restapi.amap.com/v3/geocode/regeo" +
    `?key=${encodeURIComponent(k)}` +
    `&location=${g.lon.toFixed(6)},${g.lat.toFixed(6)}` +
    `&extensions=all&radius=200`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.status !== "1" || !data.regeocode) return { name: "", address: "" };
    const rc = data.regeocode;
    const pois = rc.pois || [];
    const near = pois.length ? pickStr(pois[0].name) : "";
    const ac = rc.addressComponent || {};
    const fallback =
      pickStr(ac.township) || pickStr(ac.district) || pickStr(ac.city) || pickStr(ac.province);
    return {
      name: near || fallback || "",
      address: pickStr(rc.formatted_address),
      city: pickStr(ac.city) || pickStr(ac.province),
    };
  } catch {
    return { name: "", address: "" };
  }
}

/** 高德有些字段空值会返回空数组，统一成字符串 */
function pickStr(v) {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.length ? String(v[0]) : "";
  return v == null ? "" : String(v);
}

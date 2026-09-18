// ============================================================
// 通用 UI：提示条、弹层、确认框
// ============================================================

const toastHost = (() => {
  let el = document.querySelector(".toast-host");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast-host";
    document.body.appendChild(el);
  }
  return el;
})();

export function toast(msg, kind = "", ms = 2200) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  toastHost.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .25s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 260);
  }, ms);
  return el;
}

export const ok = (m) => toast(m, "ok");
export const err = (m) => toast(m, "err", 3200);

/** HTML 转义。所有用户输入拼进 innerHTML 前必须过这里。 */
export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

/**
 * 底部弹层。
 * 返回 { el, body, close }，body 里塞内容。
 */
export function sheet({ title = "", foot = null, onClose = null } = {}) {
  const backdrop = document.createElement("div");
  backdrop.className = "sheet-backdrop";

  const el = document.createElement("div");
  el.className = "sheet";
  el.innerHTML = `
    <div class="sheet-grip"></div>
    <div class="sheet-head">
      <h3></h3>
      <button class="btn-icon" data-x aria-label="关闭">✕</button>
    </div>
    <div class="sheet-body"></div>
  `;
  el.querySelector("h3").textContent = title;

  const body = el.querySelector(".sheet-body");

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    el.style.transition = "transform .2s";
    el.style.transform = "translateY(100%)";
    backdrop.style.transition = "opacity .2s";
    backdrop.style.opacity = "0";
    setTimeout(() => {
      el.remove();
      backdrop.remove();
      onClose?.();
    }, 210);
  };

  el.querySelector("[data-x]").onclick = close;
  backdrop.onclick = close;

  if (foot) {
    const f = document.createElement("div");
    f.className = "sheet-foot";
    f.append(...(Array.isArray(foot) ? foot : [foot]));
    el.appendChild(f);
  }

  document.body.append(backdrop, el);
  return { el, body, close };
}

/** 确认框。返回 Promise<boolean>。 */
export function confirmSheet(title, message, { danger = false, okText = "确定" } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const settle = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };

    const cancel = button("取消", "btn");
    const confirm = button(okText, danger ? "btn btn-danger" : "btn btn-primary");

    const s = sheet({ title, foot: [cancel, confirm], onClose: () => settle(false) });
    const p = document.createElement("p");
    p.style.margin = "0";
    p.style.color = "var(--ink-2)";
    p.style.lineHeight = "1.7";
    p.textContent = message;
    s.body.appendChild(p);

    cancel.onclick = () => {
      settle(false);
      s.close();
    };
    confirm.onclick = () => {
      settle(true);
      s.close();
    };
  });
}

export function button(label, cls = "btn") {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = label;
  return b;
}

/** 简单的 el 构造 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v != null && v !== false) {
      el.setAttribute(k, v === true ? "" : v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

/** 从对象表生成选项网格（交通方式、地点类型选择） */
export function optionGrid(table, current, onPick) {
  const grid = h("div", { class: "opt-grid" });
  for (const [k, meta] of Object.entries(table)) {
    const b = h(
      "button",
      { class: "opt", "aria-selected": k === current ? "true" : "false" },
      h("span", { class: "ic", text: meta.icon }),
      h("span", { text: meta.label })
    );
    b.onclick = () => onPick(k);
    grid.appendChild(b);
  }
  return grid;
}

/** 加载中遮罩（导出这种耗时操作用） */
export function busy(text = "处理中…") {
  const el = h(
    "div",
    {
      style:
        "position:fixed;inset:0;z-index:400;background:rgba(250,247,242,.88);" +
        "backdrop-filter:blur(3px);display:grid;place-items:center;text-align:center;padding:24px",
    },
    h(
      "div",
      { style: "max-width:280px;width:100%" },
      h("div", { style: "font-size:15px;font-weight:600;margin-bottom:4px", text }),
      h("div", { class: "hint", style: "margin:0", text: "别关页面" }),
      h("div", { class: "progress", html: "<i style='width:0%'></i>" })
    )
  );
  document.body.appendChild(el);
  const bar = el.querySelector(".progress i");
  const label = el.querySelector("div > div");
  return {
    set(pct, msg) {
      if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
      if (msg && label) label.textContent = msg;
    },
    done() {
      el.remove();
    },
  };
}

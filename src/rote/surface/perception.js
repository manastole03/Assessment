// Perception layer injected into every frame (document start) by the web surface.
//
// It gives Python a small, surface-neutral vocabulary over a hostile DOM:
//   snapshot()   what a human operator can see: controls, cells and text, with role + name + the
//                *visual* label (the adjacent table cell on legacy table-layout forms)
//   resolve()    find elements by a recorded locator (attribute | role | label | table_cell | css)
//   synthesize() generate every locator that uniquely identifies an element *right now*
//   mask()       blank sensitive text before a screenshot is taken
// plus capture of operator input while a human holds control of the session.
(() => {
  if (window.__rote) return;

  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "TITLE"]);
  const CONTROL = "input:not([type=hidden]),select,textarea,button";
  const INTERACTIVE_ROLES = new Set([
    "link", "button", "textbox", "combobox", "listbox", "checkbox", "radio", "tab", "menuitem", "option",
  ]);
  const state = { refs: new Map(), ids: new WeakMap(), seq: 0 };

  const norm = (s) => (s || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
  const key = (s) => norm(s).replace(/[\s:*]+$/, "").replace(/^[\s*]+/, "").toLowerCase();

  function visible(el) {
    if (!(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function role(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = el.tagName;
    if (tag === "A") return el.hasAttribute("href") || el.hasAttribute("onclick") ? "link" : null;
    if (tag === "BUTTON") return "button";
    if (tag === "INPUT") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(t)) return "button";
      if (t === "checkbox" || t === "radio") return t;
      if (t === "hidden") return null;
      return "textbox";
    }
    if (tag === "SELECT") return el.multiple || el.size > 1 ? "listbox" : "combobox";
    if (tag === "TEXTAREA") return "textbox";
    if (/^H[1-6]$/.test(tag)) return "heading";
    if (tag === "TH") return "columnheader";
    if (tag === "TD") return "cell";
    if (tag === "IMG") return "img";
    if (el.hasAttribute("onclick")) return "button";
    return null;
  }

  function isInteractive(el, r) {
    return INTERACTIVE_ROLES.has(r) && !(el.tagName === "A" && !el.hasAttribute("href") && !el.hasAttribute("onclick"));
  }

  function ownText(el) {
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === 3) t += " " + n.textContent;
    return norm(t);
  }

  function text(el) {
    return norm(el.innerText !== undefined ? el.innerText : el.textContent);
  }

  // Accessible name: the subset of accname that legacy markup actually uses.
  function accName(el, r) {
    const doc = el.ownerDocument;
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const t = norm(labelledby.split(/\s+/).map((id) => doc.getElementById(id)).filter(Boolean)
        .map((n) => n.innerText).join(" "));
      if (t) return t;
    }
    const aria = norm(el.getAttribute("aria-label"));
    if (aria) return aria;
    if (el.id) {
      const lbl = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl && text(lbl)) return text(lbl);
    }
    const wrap = el.closest("label");
    if (wrap && wrap !== el && text(wrap)) return text(wrap);
    if (el.tagName === "INPUT") {
      const t = (el.getAttribute("type") || "").toLowerCase();
      if (["button", "submit", "reset"].includes(t)) return norm(el.value) || (t === "submit" ? "Submit" : "");
      if (t === "image") return norm(el.alt) || norm(el.title) || norm(el.value);
    }
    if (el.tagName === "IMG") return norm(el.alt) || norm(el.title);
    if (["link", "button", "heading", "cell", "columnheader", "tab", "menuitem", "option"].includes(r)) {
      let t = text(el);
      if (!t) {
        const img = el.querySelector("img[alt]");
        if (img) t = norm(img.alt);
      }
      if (t) return t.slice(0, 160);
    }
    return norm(el.getAttribute("title")) || norm(el.getAttribute("placeholder"));
  }

  function hasHeaderRow(table) {
    return Array.from(table.rows).some((row) => row.querySelector(":scope > th"));
  }

  function labelLike(cell, forControl) {
    if (!cell || cell.querySelector(CONTROL) || cell.querySelector("table")) return "";
    const t = text(cell);
    if (!t || t.length > 60) return "";
    if (forControl) return t;
    const bold = cell.querySelector("b,strong");
    const emphasised = cell.tagName === "TH" || /\blbl\b/.test(cell.className) || (bold && text(bold) === t);
    return t.endsWith(":") || emphasised ? t : "";
  }

  // The text a human reads as this control's (or value's) label.
  function visualLabel(el) {
    const isControl = el.matches(CONTROL);
    if (el.matches("input[type=checkbox],input[type=radio]")) {
      // Checkbox and radio labels follow the control ("[x] I confirm ...").
      let n = el.nextSibling;
      while (n && !(n.nodeType === 3 && norm(n.textContent)) && !(n.nodeType === 1 && text(n))) n = n.nextSibling;
      if (n) return (n.nodeType === 3 ? norm(n.textContent) : text(n)).slice(0, 80);
    }
    const cell = el.tagName === "TD" || el.tagName === "TH" ? el : el.closest("td,th");
    if (cell && !(el === cell && hasHeaderRow(cell.closest("table")))) {
      let prev = cell.previousElementSibling;
      while (prev) {
        const t = labelLike(prev, isControl);
        if (t) return key(t) ? norm(t).replace(/[\s:*]+$/, "") : "";
        if (text(prev)) break;
        prev = prev.previousElementSibling;
      }
      if (isControl) {
        const row = cell.parentElement;
        const above = row && row.previousElementSibling;
        if (above && above.cells && above.cells[cell.cellIndex]) {
          const t = labelLike(above.cells[cell.cellIndex], true);
          if (t) return norm(t).replace(/[\s:*]+$/, "");
        }
      }
    }
    if (isControl) {
      let n = el.previousSibling;
      while (n) {
        if (n.nodeType === 3 && norm(n.textContent)) return norm(n.textContent).replace(/[\s:*]+$/, "");
        if (n.nodeType === 1) {
          if (n.matches(CONTROL)) break;
          if (text(n)) return text(n).replace(/[\s:*]+$/, "");
        }
        n = n.previousSibling;
      }
    }
    return "";
  }

  function effectiveCells(row) {
    const out = [];
    let col = 0;
    for (const cell of row.cells) {
      out.push({ cell, col });
      col += cell.colSpan || 1;
    }
    return out;
  }

  // Column header and row cells for a cell (or a control inside a cell) in a data grid.
  function gridContext(el) {
    const cell = el.tagName === "TD" || el.tagName === "TH" ? el : el.closest("td,th");
    if (!cell) return null;
    const table = cell.closest("table");
    if (!table || !hasHeaderRow(table)) return null;
    const rows = Array.from(table.rows);
    const headerIdx = rows.findIndex((r) => r.querySelector(":scope > th"));
    const row = cell.parentElement;
    if (rows.indexOf(row) <= headerIdx) return null;
    const cells = effectiveCells(row);
    const me = cells.find((c) => c.cell === cell);
    const header = effectiveCells(rows[headerIdx]).find((h) => h.col === me.col);
    return {
      table, row, cells, col: me.col, headerIdx, rows,
      column: header ? text(header.cell) : "",
    };
  }

  function describe(el) {
    const r = role(el);
    const grid = gridContext(el);
    const info = {
      role: r,
      name: accName(el, r),
      label: visualLabel(el),
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type"),
      attrs: {},
      text: "",
      value: null,
      disabled: !!el.disabled,
      column: grid ? grid.column : null,
      row: grid ? grid.cells.map((c) => text(c.cell)) : null,
    };
    for (const a of ["name", "id", "href"]) if (el.hasAttribute(a)) info.attrs[a] = el.getAttribute(a);
    if (el.matches("input,textarea")) {
      info.value = (el.type || "").toLowerCase() === "password" ? (el.value ? "••••••" : "") : el.value;
    }
    if (el.tagName === "SELECT") {
      info.options = Array.from(el.options).map((o) => norm(o.text));
      info.value = el.selectedIndex >= 0 ? norm(el.options[el.selectedIndex].text) : "";
    }
    if (r === "checkbox" || r === "radio") info.checked = !!el.checked;
    if (!el.matches(CONTROL)) info.text = text(el).slice(0, 300);
    const b = el.getBoundingClientRect();
    info.bbox = [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
    return info;
  }

  function register(el, prefix) {
    let ref = state.ids.get(el);
    if (!ref || state.refs.get(ref) !== el) {
      ref = `${prefix || "x"}${++state.seq}`;
      state.ids.set(el, ref);
      state.refs.set(ref, el);
    }
    return ref;
  }

  // ------------------------------------------------------------------------------------ snapshot

  function snapshot(offset) {
    state.refs = new Map();
    state.ids = new WeakMap();
    let n = offset || 0;
    const items = [];
    const add = (el, extra) => {
      const ref = `e${++n}`;
      state.refs.set(ref, el);
      state.ids.set(el, ref);
      items.push(Object.assign({ ref }, describe(el), extra || {}));
    };
    const walk = (el) => {
      if (SKIP.has(el.tagName)) return;
      if (el.tagName !== "BODY" && !visible(el)) return;
      const r = role(el);
      if (isInteractive(el, r)) {
        add(el);
        return;
      }
      const hasControls = !!el.querySelector(CONTROL + ",a[href],[onclick]");
      if ((el.tagName === "TD" || el.tagName === "TH") && !hasControls && !el.querySelector("table")) {
        if (text(el)) add(el);
        return;
      }
      if (/^H[1-6]$/.test(el.tagName) && text(el)) {
        add(el);
        return;
      }
      const own = ownText(el);
      if (own.replace(/[|\-\s]/g, "").length > 1) {
        if (!hasControls && !el.querySelector("table") && el.tagName !== "BODY") {
          add(el, { role: r || "text" });
          return;
        }
        add(el, { role: "text", text: own.slice(0, 300) });
      }
      for (const child of el.children) walk(child);
    };
    if (document.body && document.body.tagName === "BODY") walk(document.body);
    return { items, count: n - (offset || 0), title: document.title };
  }

  // ------------------------------------------------------------------------------------ resolve

  function candidates() {
    return Array.from(document.querySelectorAll("a,button,input,select,textarea,td,th,h1,h2,h3,h4,h5,h6,[onclick],[role]"))
      .filter(visible);
  }

  function resolveTableCell(loc) {
    const out = [];
    for (const table of document.querySelectorAll("table")) {
      const rows = Array.from(table.rows);
      const headerIdx = rows.findIndex((r) => r.querySelector(":scope > th"));
      if (headerIdx < 0) continue;
      const header = effectiveCells(rows[headerIdx]).find((h) => key(text(h.cell)) === key(loc.column));
      if (!header) continue;
      for (const row of rows.slice(headerIdx + 1)) {
        const cells = effectiveCells(row);
        if (!cells.some((c) => key(text(c.cell)) === key(loc.row))) continue;
        const hit = cells.find((c) => c.col === header.col);
        if (!hit) continue;
        let el = hit.cell;
        if (loc.role) el = Array.from(el.querySelectorAll("*")).find((d) => role(d) === loc.role && visible(d));
        if (el && visible(el)) out.push(el);
      }
    }
    return out;
  }

  function resolve(loc) {
    switch (loc.by) {
      case "attribute":
        return Array.from(document.querySelectorAll(loc.tag)).filter(
          (el) => el.getAttribute(loc.attribute) === loc.value && visible(el));
      case "role":
        return candidates().filter((el) => role(el) === loc.role && key(accName(el, loc.role)) === key(loc.name));
      case "label":
        return candidates().filter((el) => role(el) === loc.role && key(visualLabel(el)) === key(loc.label));
      case "table_cell":
        return resolveTableCell(loc);
      case "css":
        try {
          return Array.from(document.querySelectorAll(loc.selector)).filter(visible);
        } catch (e) {
          return [];
        }
      default:
        return [];
    }
  }

  function resolveRefs(loc) {
    return resolve(loc).map((el) => register(el, "r"));
  }

  // ------------------------------------------------------------------------------------ synthesize

  const stable = (v) => !!v && v.length <= 48 && !/\d{4,}/.test(v) && !/[0-9a-f]{8}-[0-9a-f]{4}/i.test(v);

  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id && stable(node.id)) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  }

  function rowKey(grid, preferValues) {
    const dataRows = grid.rows.slice(grid.headerIdx + 1).map((r) => effectiveCells(r));
    const uniqueInColumn = (c) => dataRows.filter((cells) => {
      const other = cells.find((x) => x.col === c.col);
      return other && key(text(other.cell)) === key(text(c.cell));
    }).length === 1;
    const options = grid.cells.filter((c) => text(c.cell) && uniqueInColumn(c));
    const preferred = options.find((c) => preferValues.includes(text(c.cell)));
    if (preferred) return text(preferred.cell);
    const labelish = options.find((c) => c.col !== grid.col && /[A-Za-z]{3,}/.test(text(c.cell)) && !/[$\d]/.test(text(c.cell)));
    if (labelish) return text(labelish.cell);
    const any = options.find((c) => c.col !== grid.col) || options[0];
    return any ? text(any.cell) : null;
  }

  function synthesize(el, opts) {
    opts = opts || {};
    const volatile = opts.volatileParams || [];
    const preferValues = opts.preferValues || [];
    const out = [];
    const add = (loc) => {
      const hits = resolve(loc);
      if (hits.length === 1 && hits[0] === el) out.push(loc);
    };
    const tag = el.tagName.toLowerCase();
    const r = role(el);
    if (el.matches(CONTROL) && stable(el.getAttribute("name"))) {
      add({ by: "attribute", tag, attribute: "name", value: el.getAttribute("name") });
    } else if (el.id && stable(el.id)) {
      add({ by: "attribute", tag, attribute: "id", value: el.id });
    }
    const href = el.tagName === "A" ? el.getAttribute("href") : null;
    if (href && !/^javascript:/i.test(href)) {
      const query = href.includes("?") ? href.split("?")[1] : "";
      const params = query.split("&").map((p) => p.split("=")[0]).filter(Boolean);
      if (!params.some((p) => volatile.includes(p))) add({ by: "attribute", tag: "a", attribute: "href", value: href });
    }
    const name = r ? accName(el, r) : "";
    if (r && name) add({ by: "role", role: r, name });
    const grid = gridContext(el);
    if (grid && grid.column) {
      const row = rowKey(grid, preferValues);
      if (row) add({ by: "table_cell", row, column: grid.column, ...(el.matches("td,th") ? {} : { role: r }) });
    }
    const label = visualLabel(el);
    if (r && label) add({ by: "label", role: r, label });
    add({ by: "css", selector: cssPath(el) });
    return out;
  }

  // ------------------------------------------------------------------------------------ misc

  function hasText(needle, isRegex) {
    const body = document.body;
    if (!body || body.tagName !== "BODY") return false;
    const hay = body.innerText || "";
    if (isRegex) {
      try {
        return new RegExp(needle, "i").test(hay);
      } catch (e) {
        return false;
      }
    }
    return norm(hay).toLowerCase().includes(norm(needle).toLowerCase());
  }

  function visibleText() {
    const body = document.body;
    return body && body.tagName === "BODY" ? (body.innerText || "").slice(0, 4000) : "";
  }

  function ensureMaskStyle() {
    if (document.getElementById("__rote_mask_style") || !document.head) return;
    const style = document.createElement("style");
    style.id = "__rote_mask_style";
    style.textContent = "[data-rote-mask]{color:transparent!important;background:#1b1b1b!important;" +
      "text-shadow:none!important;-webkit-text-security:disc!important}";
    document.head.appendChild(style);
  }

  function mask(values, patterns, labelPatterns) {
    const res = patterns.map((p) => new RegExp(p, "i"));
    const lres = labelPatterns.map((p) => new RegExp(p, "i"));
    let count = 0;
    for (const el of document.querySelectorAll("td,th,span,font,b,strong,div,p,li,a,label,input,textarea")) {
      if (!visible(el)) continue;
      const t = el.matches("input,textarea") ? el.value : ownText(el);
      if (!t) continue;
      const label = visualLabel(el);
      if (values.some((v) => v && t.includes(v)) || res.some((re) => re.test(t)) ||
          (label && lres.some((re) => re.test(label)))) {
        el.setAttribute("data-rote-mask", "1");
        count++;
      }
    }
    if (count) ensureMaskStyle();
    return count;
  }

  function unmask() {
    for (const el of document.querySelectorAll("[data-rote-mask]")) el.removeAttribute("data-rote-mask");
  }

  function interactiveAncestor(el) {
    return el.closest("a,button,input,select,textarea,[onclick],[role=button],[role=link]") ||
      el.closest("td,th") || el;
  }

  function elementAt(x, y) {
    const hit = document.elementFromPoint(x, y);
    if (!hit) return null;
    const el = interactiveAncestor(hit);
    return { ref: register(el, "p"), info: describe(el) };
  }

  // ------------------------------------------------------------------------------------ human capture

  function onHuman(kind, ev) {
    if (typeof window.__roteHumanEvent !== "function" || !(ev.target instanceof Element)) return;
    const el = kind === "click" ? interactiveAncestor(ev.target) : ev.target;
    let value = null;
    const secret = (el.getAttribute("type") || "").toLowerCase() === "password";
    if (kind === "change" && !secret) {
      value = el.tagName === "SELECT" ? norm((el.selectedOptions[0] || {}).text) : el.value;
    }
    if (kind === "change" && (el.type === "checkbox" || el.type === "radio")) value = el.checked ? "checked" : "unchecked";
    let locators = [];
    try {
      locators = synthesize(el, {});
    } catch (e) { /* capture must never break the page */ }
    try {
      window.__roteHumanEvent({ kind, element: describe(el), locators, value, secret, url: location.href })
        .catch(() => {});
    } catch (e) { /* binding not installed */ }
  }

  document.addEventListener("click", (e) => onHuman("click", e), true);
  document.addEventListener("change", (e) => onHuman("change", e), true);
  document.addEventListener("keydown", (e) => { if (e.key === "Enter") onHuman("enter", e); }, true);

  window.__rote = {
    version: 1,
    snapshot,
    byRef: (ref) => state.refs.get(ref) || null,
    describeRef: (ref) => (state.refs.get(ref) ? describe(state.refs.get(ref)) : null),
    resolveRefs,
    synthesizeRef: (ref, opts) => (state.refs.get(ref) ? synthesize(state.refs.get(ref), opts) : []),
    hasText,
    visibleText,
    mask,
    unmask,
    elementAt,
  };
})();

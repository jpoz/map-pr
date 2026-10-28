"use strict";
// ZoomMap draws a PR map on a canvas as one zoomable space with three levels
// of detail: packages when zoomed out, declarations (functions, methods,
// types, constants, variables) in the middle, and their code when zoomed in.
// The layout never changes between levels. Each level fades into the next,
// so the eye can follow a package down into one line of code.
function ZoomMap(canvas, opts) {
  const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
  const SANS = 'ui-sans-serif, -apple-system, "Segoe UI", sans-serif';
  const CH = 0.6; // width of a monospace character, in font sizes

  // World sizes. One world unit is one screen pixel at zoom 1.
  const S = {
    nameFont: 13, metaFont: 9.5, header: 42, radius: 0,
    codeFont: 4.2, codeLine: 5.8, bodyPad: 6, maxLines: 140, maxCols: 110,
    cardMinW: 250, cardMaxW: 460,
    gap: 28, sectionGap: 40, sectionLabel: 30, pkgPad: 36, pkgHeader: 78, pkgRadius: 22,
  };
  // Zoom bands. Package summaries fade out while declarations fade in; a
  // card's name and code fade in when their text is readable on the screen.
  const PKG_FADE = [0.24, 0.4];
  // A package also opens when it fills this part of the view, so a big
  // package shows its declarations before the small ones do.
  const FILL = [0.55, 0.8];
  const NAME_PX = [5.5, 8];
  const CODE_PX = [4.5, 6.5];
  const MAX_Z = 16;

  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const lerp = (a, b, t) => a + (b - a) * t;
  const hit = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  const ctx = canvas.getContext("2d");
  let W = 1, H = 1, dpr = 1;
  const cam = { x: 0, y: 0, z: 1 };
  let C = {};
  let cards = new Map(), pkgs = new Map(), edges = [], pkgEdges = [], bounds = { x: 0, y: 0, w: 1, h: 1 };
  let leaving = []; // cards that fade out after a layout change
  let hover = null, selected = null, focus = null;
  // Comment pins: {id, node, line, pkg, x, y, state, count}. In comment mode
  // a click drops a new comment where it lands.
  let notePins = [], activePin = null, commentMode = false;
  let fly = null, wheel = null, inertia = null, tween = null;
  let dirty = true, frame = 0, lastLevel = "", drawMs = 0;
  const tokens = new Map();
  const tokenQueue = [];
  let tokenBusy = false;

  // ---------- colors ----------

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = n => cs.getPropertyValue(n).trim();
    C = {
      bg: v("--bg"), panel: v("--panel"), ink: v("--ink"), muted: v("--muted"), line: v("--line"),
      pkgBg: v("--pkg-bg"), codeBg: v("--code-bg"), hl: v("--hl"), grid: v("--grid"),
      added: v("--added"), addedBg: v("--added-bg"), modified: v("--modified"), modifiedBg: v("--modified-bg"),
      caller: v("--caller"), callerBg: v("--caller-bg"), note: v("--note-line"), removed: v("--removed"), removedBg: v("--removed-bg"),
      entry: v("--entry"), entryBg: v("--entry-bg"),
    };
  }
  const statusColor = s => s === "added" ? C.added : s === "modified" ? C.modified : s === "entry" ? C.entry : C.caller;
  const statusBg = s => s === "added" ? C.addedBg : s === "modified" ? C.modifiedBg : s === "entry" ? C.entryBg : C.callerBg;
  const isChanged = n => n.status === "added" || n.status === "modified";
  // entryTag is the short label of how execution enters at a declaration.
  const entryTag = e => ({ http: "▶ HTTP", goroutine: "▶ GO", main: "▶ MAIN", root: "NO CALLERS" })[e.kind] || "▶ ENTRY";

  // ---------- layout ----------

  // rowsOf lists the rows a card shows: its source lines, with the lines the
  // change deleted before the line they came before, as a diff shows them.
  // no holds each row's line number, 0 on a deleted row.
  function rowsOf(n) {
    const lines = (n.source || "").replace(/\t/g, "    ").split("\n");
    const removed = n.removed || {}, text = [], no = [];
    const del = l => { for (const t of removed[l] || []) { text.push(t.replace(/\t/g, "    ")); no.push(0); } };
    lines.forEach((t, i) => { del(n.line + i); text.push(t); no.push(n.line + i); });
    del(n.line + lines.length);
    return { text, no };
  }

  // wantWidth is the width a card needs for its name and code.
  function wantWidth(n) {
    const lines = rowsOf(n).text;
    const cols = clamp(Math.max(...lines.map(l => l.trimEnd().length)), 24, S.maxCols);
    const gutterCols = String(n.line + lines.length).length + 2;
    const tag = (n.kind || "func").length * 10 * CH + 12;
    const extra = (n.tests ? 64 : 0) + (n.exported ? 58 : 0) + (n.hasNote ? 16 : 0);
    const nameW = 22 + tag + n.name.length * S.nameFont * CH + 18 + extra;
    const codeW = (cols + gutterCols) * S.codeFont * CH + S.bodyPad * 2 + 4;
    return clamp(Math.max(nameW, codeW), S.cardMinW, S.cardMaxW);
  }

  // measure sizes a card of width w so its whole declaration fits: long or
  // wide code gets a smaller font, so it needs a deeper zoom to read.
  function measure(n, w) {
    const { text: lines, no } = rowsOf(n);
    const cols = clamp(Math.max(...lines.map(l => l.trimEnd().length)), 24, S.maxCols);
    const gutterCols = String(n.line + lines.length).length + 2;
    const shown = Math.min(lines.length, S.maxLines);
    const font = Math.min(S.codeFont * shown / lines.length, (w - S.bodyPad * 2 - 4) / ((cols + gutterCols) * CH));
    const lh = font * S.codeLine / S.codeFont;
    const rowOf = new Map(no.flatMap((l, i) => l ? [[l, i]] : []));
    return {
      w, h: S.header + lines.length * lh + S.bodyPad * 2, lines, rowNo: no, rowOf,
      refs: refSpans(n, lines, rowOf), locals: localSpans(n, rowOf), font, lh, gutter: gutterCols * font * CH,
      textCols: Math.max(...lines.map(l => l.trimEnd().length)),
    };
  }

  // localSpans places the uses of each local name on the card's rows, so
  // hovering one marks the others. It maps a row to its spans of columns;
  // g numbers the local.
  function localSpans(n, rowOf) {
    const out = new Map();
    const raw = (n.source || "").split("\n");
    (n.locals || []).forEach((group, g) => {
      for (const [line, col, len] of group) {
        const i = rowOf.get(line), text = raw[line - n.line];
        if (i === undefined || text === undefined) continue;
        const c0 = displayCol(text, col - 1), c1 = displayCol(text, col - 1 + len);
        if (!out.has(i)) out.set(i, []);
        out.get(i).push({ c0, c1, g });
      }
    });
    return out;
  }

  // displayCol turns a byte offset in a source line into the column the card
  // draws it at: a tab is four columns, as the card shows it.
  function displayCol(text, bytes) {
    let b = 0, col = 0;
    for (const ch of text) {
      if (b >= bytes) break;
      const cp = ch.codePointAt(0);
      b += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      col += ch === "\t" ? 4 : ch.length;
    }
    return col;
  }

  // refSpans finds, on each row, the names that refer to another
  // declaration, so a reader can click one to go to it. It maps a row to
  // its spans of columns.
  function refSpans(n, lines, rowOf) {
    const out = new Map();
    for (const r of opts.refsOf?.(n.id) || []) {
      const re = new RegExp(`(?<![\\w$])${r.name.replace(/[$]/g, "\\$&")}(?![\\w$])`, "g");
      for (const l of r.lines) {
        const i = rowOf.get(l);
        if (i === undefined) continue;
        if (!out.has(i)) out.set(i, []);
        for (const m of lines[i].matchAll(re)) out.get(i).push({ c0: m.index, c1: m.index + r.name.length, to: r.to });
      }
    }
    return out;
  }

  // masonry places cards of one width in columns, each card in the column
  // that is shortest so far, so the cards read in order across the rows.
  function masonry(list, cols, cardW) {
    const heights = new Array(cols).fill(0);
    for (const c of list) {
      const i = heights.indexOf(Math.min(...heights));
      c.lx = i * (cardW + S.gap);
      c.ly = heights[i];
      heights[i] += c.h + S.gap;
    }
    return { w: cols * cardW + (cols - 1) * S.gap, h: Math.max(...heights) - S.gap };
  }

  // A package lists its changed declarations first, then the code that uses
  // them, each in file and line order.
  function layoutPackage(p) {
    const byPos = (a, b) => a.node.file.localeCompare(b.node.file) || a.node.line - b.node.line;
    const groups = [
      ["Entry points", p.cards.filter(c => c.node.status === "entry")],
      ["Changed", p.cards.filter(c => isChanged(c.node))],
      ["Uses a change", p.cards.filter(c => c.node.status === "caller")],
    ].filter(g => g[1].length);
    // Every card in a package has the same width, so the columns line up.
    const wants = p.cards.map(c => wantWidth(c.node)).sort((a, b) => a - b);
    const cardW = wants[Math.floor((wants.length - 1) * 0.9)];
    for (const c of p.cards) Object.assign(c, measure(c.node, cardW));
    const area = p.cards.reduce((s, c) => s + (cardW + S.gap) * (c.h + S.gap), 0);
    // Aim for a package about 1.6 times as wide as it is tall.
    const cols = clamp(Math.round(Math.sqrt(area * 1.6) / (cardW + S.gap)), 1, p.cards.length);
    const headerW = Math.max(p.name.length * 24 * CH, p.path.length * 12 * CH) + 150;
    let y = S.pkgHeader, w = headerW;
    p.sections = [];
    for (const [label, list] of groups) {
      list.sort(byPos);
      p.sections.push({ label: `${label.toUpperCase()} · ${list.length}`, ly: y + 12 });
      y += S.sectionLabel;
      const box = masonry(list, Math.min(cols, list.length), cardW);
      for (const c of list) { c.lx += S.pkgPad; c.ly += y; }
      y += box.h + S.sectionGap;
      w = Math.max(w, box.w);
    }
    p.w = w + S.pkgPad * 2;
    p.h = y - S.sectionGap + S.pkgPad;
  }

  function layout(data) {
    const nextCards = new Map(), nextPkgs = new Map();
    for (const n of data.nodes) {
      const c = { id: n.id, node: n, dim: 1, fade: 1 };
      nextCards.set(n.id, c);
      let p = nextPkgs.get(n.package);
      if (!p) {
        p = { id: n.package, path: n.package, name: n.package.split("/").slice(-2).join("/"), cards: [], dim: 1, fade: 1 };
        nextPkgs.set(n.package, p);
      }
      p.cards.push(c);
    }
    // A package's files are the changed files in its folder. An external
    // test package (path ending in _test) shares the folder and shows none.
    const stats = data.stats || {};
    const dirOf = f => f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".";
    const owner = new Map();
    for (const p of nextPkgs.values()) {
      const dir = dirOf(p.cards[0].node.file);
      if (!owner.has(dir) || owner.get(dir).path.endsWith("_test")) owner.set(dir, p);
    }
    for (const p of nextPkgs.values()) {
      layoutPackage(p);
      p.changed = p.cards.filter(c => isChanged(c.node)).length;
      p.tops = p.cards.filter(c => c.node.top).map(c => c.node);
      p.users = p.cards.length - p.changed;
      const dir = dirOf(p.cards[0].node.file);
      p.files = owner.get(dir) === p ? Object.keys(stats).filter(f => dirOf(f) === dir) : [];
      p.added = p.files.reduce((n, f) => n + stats[f].added, 0);
      p.deleted = p.files.reduce((n, f) => n + stats[f].deleted, 0);
    }

    const nextEdges = data.edges.filter(e => nextCards.has(e.from) && nextCards.has(e.to))
      .map(e => ({ ...e, a: nextCards.get(e.from), b: nextCards.get(e.to) }));
    const counts = new Map();
    for (const e of nextEdges) {
      const [from, to] = [e.a.node.package, e.b.node.package];
      if (from === to) continue;
      const k = from + "\n" + to;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const nextPkgEdges = [...counts].map(([k, count]) => {
      const [from, to] = k.split("\n");
      return { a: nextPkgs.get(from), b: nextPkgs.get(to), count };
    });

    // Packages are placed with dagre, users below the code they use. Each
    // package gets a slot big enough for its zoomed-out label at the zoom
    // that fits the whole map; that zoom depends on the slots, so it repeats
    // until it settles.
    if (window.dagre) {
      let z = 0;
      for (let pass = 0; pass < 4; pass++) {
        const g = new dagre.graphlib.Graph();
        g.setGraph({ rankdir: "BT", nodesep: 140, ranksep: 180, marginx: 0, marginy: 0 });
        g.setDefaultEdgeLabel(() => ({}));
        for (const p of nextPkgs.values()) {
          const [lw, lh] = labelSize(p, 13);
          p.slotW = z ? Math.max(p.w, (lw + 36) / z) : p.w;
          p.slotH = z ? Math.max(p.h, (lh + 28) / z) : p.h;
          g.setNode(p.id, { width: p.slotW, height: p.slotH });
        }
        for (const e of nextPkgEdges) g.setEdge(e.a.id, e.b.id);
        dagre.layout(g);
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const p of nextPkgs.values()) {
          const d = g.node(p.id);
          p.x = d.x - p.w / 2; p.y = d.y - p.h / 2;
          x1 = Math.min(x1, d.x - p.slotW / 2); x2 = Math.max(x2, d.x + p.slotW / 2);
          y1 = Math.min(y1, d.y - p.slotH / 2); y2 = Math.max(y2, d.y + p.slotH / 2);
        }
        const next = fitZoom({ w: x2 - x1, h: y2 - y1 }, 40);
        if (z && Math.abs(next - z) / z < 0.03) break;
        z = next;
      }
    } else {
      let x = 0;
      for (const p of nextPkgs.values()) { p.x = x; p.y = 0; x += p.w + 140; }
    }
    for (const c of nextCards.values()) {
      const p = nextPkgs.get(c.node.package);
      c.x = p.x + c.lx; c.y = p.y + c.ly;
    }
    return { cards: nextCards, pkgs: nextPkgs, edges: nextEdges, pkgEdges: nextPkgEdges };
  }

  function computeBounds() {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const p of pkgs.values()) {
      x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y);
      x2 = Math.max(x2, p.x + p.w); y2 = Math.max(y2, p.y + p.h);
    }
    bounds = isFinite(x1) ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : { x: 0, y: 0, w: 1, h: 1 };
  }

  // setData lays the map out. With animate, cards and packages move from
  // their old places to the new ones; new cards fade in and old ones out.
  function setData(data, animate) {
    const old = { cards, pkgs };
    const next = layout(data);
    if (animate && old.cards.size) {
      const from = new Map();
      for (const c of next.cards.values()) {
        const o = old.cards.get(c.id);
        from.set(c, o ? { x: o.x, y: o.y, fade: 1 } : { x: c.x, y: c.y, fade: 0 });
      }
      for (const p of next.pkgs.values()) {
        const o = old.pkgs.get(p.id);
        from.set(p, o ? { x: o.x, y: o.y, w: o.w, h: o.h, fade: 1 } : { x: p.x, y: p.y, w: p.w, h: p.h, fade: 0 });
      }
      leaving = [...old.cards.values()].filter(c => !next.cards.has(c.id));
      tween = { start: performance.now(), dur: 520, from, to: new Map([...from.keys()].map(k => [k, { x: k.x, y: k.y, w: k.w, h: k.h }])) };
      for (const [k, f] of from) { k.x = f.x; k.y = f.y; if (k.cards) { k.w = f.w; k.h = f.h; } k.fade = f.fade; }
    } else {
      leaving = [];
      tween = null;
    }
    ({ cards, pkgs, edges, pkgEdges } = next);
    if (tween) {
      // Bounds use the end positions, so a fit during the tween is right.
      const now = new Map([...tween.to].map(([k, t]) => [k, { x: k.x, y: k.y, w: k.w, h: k.h }]));
      for (const [k, t] of tween.to) { k.x = t.x; k.y = t.y; if (k.cards) { k.w = t.w; k.h = t.h; } }
      computeBounds();
      for (const [k, t] of now) { k.x = t.x; k.y = t.y; if (k.cards) { k.w = t.w; k.h = t.h; } }
    } else {
      computeBounds();
    }
    hover = null;
    if (selected && !cards.has(selected)) selected = null;
    updateEmphasis();
    request();
  }

  // ---------- camera ----------

  const minZ = () => Math.min(0.05, fitZoom(bounds, 40) * 0.5);
  function fitZoom(r, pad) {
    return clamp(Math.min((W - pad * 2) / Math.max(r.w, 1), (H - pad * 2) / Math.max(r.h, 1)), 0.01, MAX_Z);
  }
  const toWorld = (sx, sy) => [(sx - W / 2) / cam.z + cam.x, (sy - H / 2) / cam.z + cam.y];
  const viewRect = (m = 0) => ({ x: cam.x - W / 2 / cam.z - m, y: cam.y - H / 2 / cam.z - m, w: W / cam.z + 2 * m, h: H / cam.z + 2 * m });

  function zoomAt(sx, sy, z) {
    const [wx, wy] = toWorld(sx, sy);
    cam.z = clamp(z, minZ(), MAX_Z);
    cam.x = wx - (sx - W / 2) / cam.z;
    cam.y = wy - (sy - H / 2) / cam.z;
  }

  function stopMotion() { fly = null; wheel = null; inertia = null; }

  // flyTo moves the camera along a zoom-out, pan, zoom-in path (van Wijk and
  // Nuij, "Smooth and efficient zooming and panning"), so a long move first
  // shows where it goes.
  function flyTo(target) {
    stopMotion();
    target.z = clamp(target.z, minZ(), MAX_Z);
    const rho = 1.4, rho2 = rho * rho, rho4 = rho2 * rho2;
    const [ux0, uy0, w0] = [cam.x, cam.y, W / cam.z];
    const [ux1, uy1, w1] = [target.x, target.y, W / target.z];
    const dx = ux1 - ux0, dy = uy1 - uy0, d2 = dx * dx + dy * dy;
    let path, S0;
    if (d2 < 1e-6) {
      S0 = Math.log(w1 / w0) / rho;
      path = t => [ux0 + t * dx, uy0 + t * dy, w0 * Math.exp(rho * t * S0)];
    } else {
      const d1 = Math.sqrt(d2);
      const b0 = (w1 * w1 - w0 * w0 + rho4 * d2) / (2 * w0 * rho2 * d1);
      const b1 = (w1 * w1 - w0 * w0 - rho4 * d2) / (2 * w1 * rho2 * d1);
      const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
      const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
      S0 = (r1 - r0) / rho;
      path = t => {
        const s = t * S0, u = w0 / (rho2 * d1) * (Math.cosh(r0) * Math.tanh(rho * s + r0) - Math.sinh(r0));
        return [ux0 + u * dx, uy0 + u * dy, w0 * Math.cosh(r0) / Math.cosh(rho * s + r0)];
      };
    }
    const dur = clamp(Math.abs(S0) * 520, 320, 1300);
    fly = { start: performance.now(), dur, path };
    request();
  }

  // openness is how far package p shows its declarations at zoom z, from
  // 0 (a solid summary) to 1.
  function openness(p, z = cam.z) {
    const fill = Math.max(p.w * z / W, p.h * z / H);
    return Math.max(smooth(PKG_FADE[0], PKG_FADE[1], z), smooth(FILL[0], FILL[1], fill));
  }
  // closedZoom is the largest zoom at which package p is still closed.
  const closedZoom = p => Math.max(PKG_FADE[0], FILL[0] * 0.97 * Math.min(W / p.w, H / p.h));

  // fitRect returns a camera that shows r. It never stops where a package
  // in r is half open: half of each level reads as neither.
  function fitRect(r, { pad = 60, maxZ = MAX_Z, minZoom = 0 } = {}) {
    let z = clamp(fitZoom(r, pad), minZoom, maxZ);
    for (const p of pkgs.values()) {
      if (!overlaps(p, r)) continue;
      const t = openness(p, z);
      if (t > 0.01 && t < 0.99) z = Math.min(z, closedZoom(p));
    }
    return { x: r.x + r.w / 2, y: r.y + r.h / 2, z };
  }
  function union(rects) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const r of rects) {
      x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y);
      x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
    }
    return isFinite(x1) ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null;
  }
  // Rects at the end of a running layout tween, so a flight aims where things will be.
  const finalRect = k => (tween && tween.to.get(k)) || k;

  function fit(animate = true) {
    const t = fitRect(bounds, { pad: 40 });
    if (animate) flyTo(t); else { stopMotion(); Object.assign(cam, t); request(); }
  }

  // showCode flies to a card close enough to read its code. A long card is
  // shown from its top.
  function showCode(id) {
    const c = cards.get(id);
    if (!c) return;
    const r = finalRect(c);
    // Aim for code text of 11 to 14 screen pixels. A card too big for the
    // view is shown from its top left, where the code starts.
    const z = clamp(fitZoom(r, 40), 11 / c.font, 14 / c.font);
    const x = r.w * z > W - 80 ? r.x + (W / 2 - 40) / z : r.x + r.w / 2;
    const y = r.h * z > H - 80 ? r.y + (H / 2 - 40) / z : r.y + r.h / 2;
    flyTo({ x, y, z });
  }

  function showIds(ids, { maxZ = 1.1, pad = 70 } = {}) {
    const r = union(ids.map(id => cards.get(id)).filter(Boolean).map(finalRect));
    if (r) flyTo(fitRect(r, { pad, maxZ }));
  }

  function showPackage(id) {
    const p = pkgs.get(id);
    if (p) flyTo(fitRect(finalRect(p), { pad: 50, maxZ: 1.2 }));
  }

  // ---------- emphasis ----------

  // updateEmphasis sets how strongly each card and package is drawn: a
  // selection or a focus dims everything else.
  function updateEmphasis() {
    let keep = null, keepPkg = null;
    if (selected) {
      keep = new Set([selected]);
      for (const e of edges) {
        if (e.from === selected) keep.add(e.to);
        if (e.to === selected) keep.add(e.from);
      }
    } else if (focus && focus.ids) {
      keep = new Set(focus.ids);
      if (focus.neighbors) for (const e of edges) {
        if (focus.ids.includes(e.from)) keep.add(e.to);
        if (focus.ids.includes(e.to)) keep.add(e.from);
      }
    } else if (focus && focus.pkg) {
      keepPkg = focus.pkg;
    }
    for (const c of cards.values()) {
      c.dimTo = keep ? (keep.has(c.id) ? 1 : 0.16) : keepPkg ? (c.node.package === keepPkg ? 1 : 0.22) : 1;
    }
    for (const p of pkgs.values()) {
      p.dimTo = keep ? (p.cards.some(c => keep.has(c.id)) ? 1 : 0.35) : keepPkg ? (p.id === keepPkg ? 1 : 0.35) : 1;
    }
    request();
  }

  function setFocus(f) { focus = f; updateEmphasis(); }
  function select(id) { selected = id && cards.has(id) ? id : null; updateEmphasis(); }

  // ---------- tokens ----------

  function wantTokens(c) {
    if (tokens.has(c.id) || !opts.tokenize) return null;
    tokens.set(c.id, null);
    tokenQueue.push(c);
    pumpTokens();
    return null;
  }
  async function pumpTokens() {
    if (tokenBusy) return;
    tokenBusy = true;
    while (tokenQueue.length) {
      // Coloring code takes main-thread time, so it waits while the camera moves.
      while (fly || wheel || inertia || drag) await new Promise(r => setTimeout(r, 60));
      await new Promise(r => setTimeout(r, 0));
      const c = tokenQueue.shift();
      try {
        tokens.set(c.id, await opts.tokenize(c.node, c.lines.join("\n")));
      } catch (err) {
        console.warn("map-pr: syntax colors unavailable", err);
        tokenQueue.length = 0;
        break;
      }
      request();
    }
    tokenBusy = false;
  }
  function clearTokens() { tokens.clear(); tokenQueue.length = 0; request(); }

  // ---------- drawing ----------

  function request() {
    dirty = true;
    if (!frame) frame = requestAnimationFrame(tick);
  }

  function tick(now) {
    frame = 0;
    let active = false;
    if (fly) {
      const t = clamp((now - fly.start) / fly.dur, 0, 1);
      const [x, y, w] = fly.path(ease(t));
      cam.x = x; cam.y = y; cam.z = W / w;
      if (t >= 1) fly = null; else active = true;
    }
    if (wheel) {
      const k = wheel.fast ? 0.45 : 0.28;
      const z = Math.exp(lerp(Math.log(cam.z), Math.log(wheel.target), k));
      zoomAt(wheel.sx, wheel.sy, z);
      if (Math.abs(Math.log(wheel.target / cam.z)) < 0.002 || cam.z <= minZ() || cam.z >= MAX_Z) wheel = null; else active = true;
    }
    if (inertia) {
      const dt = Math.min(now - inertia.last, 40);
      inertia.last = now;
      cam.x -= inertia.vx * dt; cam.y -= inertia.vy * dt;
      const decay = Math.exp(-dt / 260);
      inertia.vx *= decay; inertia.vy *= decay;
      if (Math.hypot(inertia.vx, inertia.vy) * cam.z < 0.02) inertia = null; else active = true;
    }
    if (tween) {
      const t = ease(clamp((now - tween.start) / tween.dur, 0, 1));
      for (const [k, f] of tween.from) {
        const to = tween.to.get(k);
        k.x = lerp(f.x, to.x, t); k.y = lerp(f.y, to.y, t);
        if (k.cards) { k.w = lerp(f.w, to.w, t); k.h = lerp(f.h, to.h, t); }
        k.fade = lerp(f.fade, 1, t);
      }
      if (t >= 1) { tween = null; leaving = []; } else active = true;
    }
    for (const k of [...cards.values(), ...pkgs.values()]) {
      const d = (k.dimTo ?? 1) - k.dim;
      if (Math.abs(d) > 0.005) { k.dim += d * 0.2; active = true; } else k.dim = k.dimTo ?? 1;
    }
    if (dirty || active) {
      dirty = false;
      const t = performance.now();
      draw(now);
      drawMs = performance.now() - t;
    }
    // A draw that left bitmaps to make sets dirty again.
    if (active || dirty) request();
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  function setWorld() {
    const z = cam.z;
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (W / 2 - cam.x * z), dpr * (H / 2 - cam.y * z));
  }
  function setScreen() { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
  const sx = x => (x - cam.x) * cam.z + W / 2;
  const sy = y => (y - cam.y) * cam.z + H / 2;

  function draw() {
    minimapDeadline = performance.now() + 4;
    setScreen();
    ctx.globalAlpha = 1;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    drawGrid();

    const view = viewRect(40 / cam.z);
    arrows = [];
    let open = 0;
    for (const p of pkgs.values()) {
      p.t = openness(p);
      if (overlaps(p, view)) open = Math.max(open, p.t);
    }
    setWorld();
    for (const p of pkgs.values()) if (overlaps(p, view)) drawPackage(p, p.t);
    // Cards under a solid package summary are covered, so they are not drawn.
    if (open > 0.01) {
      drawPackageEdges((A, B) => 0.3 * Math.max(A.t, B.t));
      drawEdges(view);
      for (const c of leaving) if (overlaps(c, view)) drawCard(c, openOf(c), 1 - (c.fadeOut = Math.max(0, (c.fadeOut ?? 1) - 0.08)));
      for (const c of cards.values()) if (overlaps(c, view)) drawCard(c, openOf(c), c.fade);
      drawArrows();
    }
    for (const p of pkgs.values()) if (overlaps(p, view)) drawSummary(p, p.t);
    drawPackageEdges((A, B) => 1 - Math.max(A.t, B.t));
    drawLabels(view);
    drawMarks(view);
    setScreen();
    drawPins();

    const level = open < 0.5 ? "packages" : cam.z * S.codeFont >= (CODE_PX[0] + CODE_PX[1]) / 2 ? "code" : "decls";
    if (level !== lastLevel) { lastLevel = level; opts.onLevel?.(level); }
  }

  // The dot grid moves and scales with the map, so a pan or zoom always shows motion.
  function drawGrid() {
    const base = 26;
    const step = Math.pow(2, Math.ceil(Math.log2(base / cam.z)));
    const px = step * cam.z;
    const a = smooth(base, base * 1.6, px);
    ctx.fillStyle = C.grid;
    for (const [s, alpha] of [[step, a], [step / 2, 1 - a]]) {
      if (alpha < 0.03) continue;
      const g = s * cam.z;
      ctx.globalAlpha = alpha;
      const ox = ((W / 2 - cam.x * cam.z) % g + g) % g, oy = ((H / 2 - cam.y * cam.z) % g + g) % g;
      for (let x = ox; x < W; x += g) for (let y = oy; y < H; y += g) ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
    }
    ctx.globalAlpha = 1;
  }

  // openOf is how far the package of card c is open.
  const openOf = c => pkgs.get(c.node.package)?.t ?? 1;

  // drawPackage draws a package as a container with a header, as seen at
  // the declaration level.
  function drawPackage(p, t1) {
    const z = cam.z, a = p.fade * lerp(0.35, 1, p.dim);
    ctx.globalAlpha = a;
    roundRect(p.x, p.y, p.w, p.h, S.pkgRadius);
    ctx.fillStyle = C.pkgBg;
    ctx.fill();
    ctx.lineWidth = 1 / z;
    ctx.strokeStyle = C.line;
    ctx.stroke();
    const textA = smooth(5, 8, 22 * z) * t1;
    if (textA > 0.01) {
      ctx.globalAlpha = a * textA;
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = C.ink;
      ctx.font = `600 24px ${SANS}`;
      ctx.fillText(p.name, p.x + S.pkgPad, p.y + 42);
      ctx.fillStyle = C.muted;
      ctx.font = `12px ${MONO}`;
      ctx.fillText(p.path, p.x + S.pkgPad, p.y + 62);
      ctx.font = `600 12px ${SANS}`;
      drawParts(statsParts(p), p.x + p.w - S.pkgPad, p.y + 42, "right");
      ctx.fillStyle = C.muted;
      ctx.font = `600 11px ${SANS}`;
      for (const s of p.sections) {
        ctx.fillText(s.label, p.x + S.pkgPad, p.y + s.ly + 4);
      }
    }
    // A package that opens while small on the screen gets a header in
    // screen pixels, as its own header is too small to read.
    const compactA = t1 * (1 - smooth(5, 8, 22 * z));
    if (compactA > 0.01) {
      setScreen();
      const size = clamp(S.pkgHeader * z * 0.55, 10, 13);
      const x = sx(p.x) + 14, y = sy(p.y) + Math.max(S.pkgHeader * z / 2, size);
      ctx.globalAlpha = a * compactA;
      ctx.textBaseline = "middle";
      ctx.font = `600 ${size}px ${SANS}`;
      ctx.fillStyle = C.ink;
      ctx.fillText(p.name, x, y);
      const nw = ctx.measureText(p.name).width;
      ctx.font = `600 ${size - 1}px ${SANS}`;
      drawParts(statsParts(p), Math.max(sx(p.x + p.w) - 14, x + nw + 120), y, "right");
      setWorld();
    }
    ctx.globalAlpha = 1;
  }
  // statsParts is a package's diff summary as colored pieces: the top
  // functions it holds (★, where to start reading), files, +added, −deleted.
  const statsParts = p => [
    ...(p.tops.length ? [[`★ ${p.tops.length}`, statusColor(p.tops[0].status)]] : []),
    ...(p.files.length
      ? [[`${p.files.length} file${p.files.length > 1 ? "s" : ""}`, C.muted], [`+${p.added}`, C.added], [`−${p.deleted}`, C.removed]]
      : [["no changed files", C.muted]]),
  ];
  const statsText = p => statsParts(p).map(x => x[0]).join(" ");

  // drawParts draws colored pieces of text on one line, aligned like fillText.
  function drawParts(parts, x, y, align) {
    const gap = ctx.measureText(" ").width * 1.6;
    const widths = parts.map(([t]) => ctx.measureText(t).width);
    const total = widths.reduce((a, b) => a + b, 0) + gap * (parts.length - 1);
    let left = align === "center" ? x - total / 2 : align === "right" ? x - total : x;
    const saved = ctx.textAlign;
    ctx.textAlign = "left";
    parts.forEach(([t, color], i) => {
      ctx.fillStyle = color;
      ctx.fillText(t, left, y);
      left += widths[i] + gap;
    });
    ctx.textAlign = saved;
    return total;
  }

  // labelSize measures a package's zoomed-out label at a name size in pixels.
  function labelSize(p, size, name = p.name) {
    ctx.save();
    ctx.font = `600 ${size}px ${SANS}`;
    const nw = ctx.measureText(name).width;
    ctx.font = `${Math.max(size * 0.62, 9)}px ${SANS}`;
    const sw = ctx.measureText(statsText(p)).width * 1.08;
    ctx.restore();
    return [Math.max(nw, sw), size * 2.3];
  }

  const toneOf = p => p.changed ? (p.cards.every(c => c.node.status !== "modified") ? "added" : "modified") : p.cards.every(c => c.node.status === "entry") ? "entry" : "caller";

  // drawSummary covers a package with a solid card and a large label when
  // zoomed out. It fades away as the declarations inside become visible.
  function drawSummary(p, t1) {
    const a = (1 - t1) * p.fade;
    if (a < 0.01) return;
    const z = cam.z, dimA = lerp(0.35, 1, p.dim);
    const tone = toneOf(p);
    ctx.globalAlpha = a * dimA;
    roundRect(p.x, p.y, p.w, p.h, S.pkgRadius);
    ctx.fillStyle = statusBg(tone);
    ctx.fill();
    ctx.lineWidth = 2 / z;
    ctx.strokeStyle = statusColor(tone);
    ctx.stroke();

    ctx.globalAlpha = 1;
  }

  // drawLabels draws the zoomed-out package labels in screen pixels, sized
  // to fit each package. Big packages are labeled first. A label that
  // would cover one already drawn tries the short name, then is left out;
  // the tooltip still names that package.
  function drawLabels(view) {
    const z = cam.z;
    const placed = [];
    const list = [...pkgs.values()].filter(p => overlaps(p, view) && p.t < 0.99).sort((x, y) => y.w * y.h - x.w * x.h);
    if (!list.length) return;
    setScreen();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const p of pkgs.values()) p.labelHidden = true;
    for (const p of list) {
      const w = p.w * z, h = p.h * z;
      const cx = sx(p.x + p.w / 2), cy = sy(p.y + p.h / 2);
      const short = p.name.split("/").pop();
      let pick = null;
      for (const name of short === p.name ? [p.name] : [p.name, short]) {
        const [fw] = labelSize(p, 22, name);
        const size = clamp(Math.min(22, 22 * (w - 20) / fw, h / 2.6), 11, 22);
        const [lw, lh] = labelSize(p, size, name);
        const box = { x: cx - lw / 2 - 8, y: cy - lh / 2 - 2, w: lw + 16, h: lh + 4 };
        if (!placed.some(b => overlaps(b, box))) { pick = { name, size, box, inside: lw + 16 <= w && lh <= h }; break; }
      }
      if (!pick) continue;
      p.labelHidden = false;
      placed.push(pick.box);
      const tone = toneOf(p);
      ctx.globalAlpha = (1 - p.t) * p.fade * lerp(0.35, 1, p.dim);
      if (!pick.inside) {
        ctx.fillStyle = C.panel;
        roundRect(pick.box.x, pick.box.y, pick.box.w, pick.box.h, 8);
        ctx.fill();
        ctx.strokeStyle = statusColor(tone);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.fillStyle = C.ink;
      ctx.font = `600 ${pick.size}px ${SANS}`;
      ctx.fillText(pick.name, cx, cy - pick.size * 0.5);
      ctx.font = `${Math.max(pick.size * 0.62, 9)}px ${SANS}`;
      drawParts(statsParts(p), cx, cy + pick.size * 0.62, "center");
    }
    ctx.textAlign = "left";
    setWorld();
    ctx.globalAlpha = 1;
  }

  // drawPackageEdges draws the edges between packages; alpha gives each
  // edge's strength from its two packages.
  function drawPackageEdges(alpha) {
    const z = cam.z;
    for (const e of pkgEdges) {
      const A = e.a, B = e.b;
      const a = alpha(A, B);
      if (a < 0.01) continue;
      const ax = A.x + A.w / 2, ay = A.y, bx = B.x + B.w / 2, by = B.y + B.h;
      // From the top of the user package to the bottom of the used one, or sideways when level.
      const [p0, p3] = by <= ay ? [[ax, ay], [bx, by]] : sideAnchors(A, B);
      const dim = Math.min(A.dim, B.dim);
      const width = (1.5 + Math.min(4.5, Math.log2(e.count) * 1.2)) / z;
      ctx.globalAlpha = a * lerp(0.15, 0.85, dim) * Math.min(A.fade, B.fade);
      ctx.strokeStyle = C.muted;
      ctx.fillStyle = C.muted;
      ctx.lineWidth = width;
      const [c1, c2] = controls(p0, p3, by <= ay);
      curve(p0, c1, c2, p3);
      arrow(c2, p3, 9 / z + width);
      if (e.count > 1 && dim > 0.5 && a > 0.5) {
        const m = bez(p0, c1, c2, p3, 0.5);
        setScreen();
        const label = String(e.count), x = sx(m[0]), y = sy(m[1]);
        ctx.font = `600 11px ${SANS}`;
        const tw = ctx.measureText(label).width + 10;
        ctx.fillStyle = C.bg;
        roundRect(x - tw / 2, y - 9, tw, 18, 9);
        ctx.fill();
        ctx.strokeStyle = C.line;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = C.muted;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, x, y + 0.5);
        ctx.textAlign = "left";
        setWorld();
      }
    }
    ctx.globalAlpha = 1;
  }

  function sideAnchors(A, B) {
    const left = B.x + B.w / 2 < A.x + A.w / 2;
    return [[left ? A.x : A.x + A.w, A.y + A.h / 2], [left ? B.x + B.w : B.x, B.y + B.h / 2]];
  }
  function controls(p0, p3, vertical) {
    if (vertical) {
      const d = Math.max(40, Math.abs(p3[1] - p0[1]) * 0.5);
      return [[p0[0], p0[1] - d], [p3[0], p3[1] + d]];
    }
    const d = Math.max(40, Math.abs(p3[0] - p0[0]) * 0.5) * Math.sign(p3[0] - p0[0] || 1);
    return [[p0[0] + d, p0[1]], [p3[0] - d, p3[1]]];
  }
  function curve(p0, c1, c2, p3) {
    ctx.beginPath();
    ctx.moveTo(p0[0], p0[1]);
    ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], p3[0], p3[1]);
    ctx.stroke();
  }
  function bez(p0, c1, c2, p3, t) {
    const u = 1 - t;
    return [0, 1].map(i => u * u * u * p0[i] + 3 * u * u * t * c1[i] + 3 * u * t * t * c2[i] + t * t * t * p3[i]);
  }
  function arrow(from, to, size) {
    const ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
    ctx.beginPath();
    ctx.moveTo(to[0], to[1]);
    ctx.lineTo(to[0] - size * Math.cos(ang - 0.42), to[1] - size * Math.sin(ang - 0.42));
    ctx.lineTo(to[0] - size * Math.cos(ang + 0.42), to[1] - size * Math.sin(ang + 0.42));
    ctx.closePath();
    ctx.fill();
  }

  const codeAlpha = c => smooth(CODE_PX[0], CODE_PX[1], c.font * cam.z);
  // A card whose code is wider than the card scrolls sideways. maxScroll is
  // how far, in world units; scrollOf is where it is now.
  const codeLeft = c => c.x + S.bodyPad + 4 + c.gutter;
  const maxScroll = c => Math.max(0, (c.textCols + 1) * c.font * CH - (c.x + c.w - S.bodyPad - codeLeft(c)));
  const scrollOf = c => clamp(c.scroll || 0, 0, maxScroll(c));
  // rowOf is the row of a card that shows a source line.
  const rowOf = (c, line) => c.rowOf.get(line) ?? clamp(line - c.node.line, 0, c.lines.length - 1);
  const lineY = (c, line) => c.y + S.header + S.bodyPad + (rowOf(c, line) + 0.5) * c.lh;

  // edgePath runs from the user to the declaration it uses. When the user's
  // code is readable, the edge starts at the line that makes the call.
  function edgePath(e) {
    const A = e.a, B = e.b;
    let p0, p3, vertical;
    if (B.y + B.h <= A.y - 8) {
      p0 = [A.x + A.w / 2, A.y]; p3 = [B.x + B.w / 2, B.y + B.h]; vertical = true;
    } else if (B.y >= A.y + A.h + 8) {
      p0 = [A.x + A.w / 2, A.y + A.h]; p3 = [B.x + B.w / 2, B.y]; vertical = true;
    } else {
      [p0, p3] = sideAnchors(A, B); vertical = false;
    }
    let [c1, c2] = vertical
      ? (() => { const d = Math.max(30, Math.abs(p3[1] - p0[1]) * 0.45) * Math.sign(p3[1] - p0[1]); return [[p0[0], p0[1] + d], [p3[0], p3[1] - d]]; })()
      : controls(p0, p3, false);
    const ca = codeAlpha(A);
    const line = e.lines && e.lines.find(l => l >= A.node.line && l <= A.node.endLine);
    if (ca > 0 && line) {
      const right = B.x + B.w / 2 >= A.x + A.w / 2;
      const q0 = [right ? A.x + A.w : A.x, lineY(A, line)];
      const d = Math.max(40, Math.abs(p3[0] - q0[0]) * 0.4) * (right ? 1 : -1);
      p0 = [lerp(p0[0], q0[0], ca), lerp(p0[1], q0[1], ca)];
      c1 = [lerp(c1[0], q0[0] + d, ca), lerp(c1[1], q0[1], ca)];
    }
    return [p0, c1, c2, p3];
  }

  // arrows holds the head of each edge drawn this frame. The heads are drawn
  // after the cards, so a card never covers one, and a reader can point at
  // one to see every edge that arrives there.
  let arrows = [];
  // arrowPx is an arrow head's size on screen: base when zoomed out, growing
  // with the zoom up to a limit, so it stays easy to see and to hit.
  const arrowPx = base => Math.min(base * (1 + 0.9 * Math.log2(Math.max(cam.z, 1))), 26);
  function drawArrows() {
    for (const a of arrows) {
      ctx.globalAlpha = a.alpha;
      ctx.fillStyle = a.color;
      arrow(a.from, a.p, a.px / cam.z);
    }
    ctx.globalAlpha = 1;
  }
  // hoverPort holds the edges that end where the pointer is.
  let hoverPort = null;

  function drawEdges(view) {
    const z = cam.z;
    const hot = selected || hover;
    const portSet = hoverPort ? new Set(hoverPort.edges) : null;
    const focusSet = focus && focus.ids ? new Set(focus.ids) : null;
    const later = [];
    for (const e of edges) {
      const box = union([e.a, e.b]);
      if (!overlaps(box, view)) continue;
      const t1 = Math.min(openOf(e.a), openOf(e.b));
      if (t1 < 0.01) continue;
      const isHot = hot && (e.from === hot || e.to === hot) || portSet && portSet.has(e);
      const isFocus = focusSet && focusSet.has(e.from) && focusSet.has(e.to);
      if (isHot || isFocus) { later.push([e, isHot, t1]); continue; }
      // Edges to other packages show as package edges until zoomed in; at
      // the declaration level they show for the hovered or selected card.
      const same = e.a.node.package === e.b.node.package;
      const dim = Math.min(e.a.dim, e.b.dim);
      if (!same) continue;
      // An edge from an entry point skips code that is not on the map, so
      // it is dashed.
      ctx.setLineDash(e.via ? [6 / z, 5 / z] : []);
      ctx.globalAlpha = t1 * lerp(0.06, 0.38, dim) * Math.min(e.a.fade, e.b.fade);
      ctx.strokeStyle = C.muted;
      ctx.fillStyle = C.muted;
      ctx.lineWidth = 1.2 / z;
      const [p0, c1, c2, p3] = edgePath(e);
      curve(p0, c1, c2, p3);
      arrows.push({ e, p: p3, from: c2, px: arrowPx(7), color: C.muted, alpha: ctx.globalAlpha });
    }
    for (const [e, isHot, t1] of later) {
      ctx.setLineDash(e.via ? [8 / z, 6 / z] : []);
      ctx.globalAlpha = t1 * 0.95;
      const color = isHot ? C.caller : (focus.color || C.note);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 2.2 / z;
      const [p0, c1, c2, p3] = edgePath(e);
      curve(p0, c1, c2, p3);
      arrows.push({ e, p: p3, from: c2, px: arrowPx(9), color, alpha: ctx.globalAlpha });
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  function ellipsize(text, maxChars) {
    if (maxChars <= 1) return "";
    return text.length <= maxChars ? text : text.slice(0, maxChars - 1) + "…";
  }

  function drawCard(c, t1, fade) {
    if (t1 < 0.01) return;
    const n = c.node, z = cam.z;
    const a = fade * lerp(0.35, 1, t1) * lerp(0.12, 1, c.dim);
    if (a < 0.01) return;
    ctx.globalAlpha = a;
    const sw = c.w * z;
    if (sw < 5) {
      ctx.fillStyle = statusColor(n.status);
      ctx.fillRect(c.x, c.y, c.w, c.h);
      ctx.globalAlpha = 1;
      return;
    }
    const r = S.radius;
    roundRect(c.x, c.y, c.w, c.h, r);
    ctx.fillStyle = C.panel;
    ctx.fill();
    ctx.lineWidth = (hover === c.id ? 1.6 : 1) / z;
    ctx.strokeStyle = hover === c.id ? C.muted : C.line;
    ctx.stroke();
    // The code area and the status stripe.
    ctx.fillStyle = C.codeBg;
    ctx.beginPath();
    ctx.roundRect(c.x + 1 / z, c.y + S.header, c.w - 2 / z, c.h - S.header - 1 / z, [0, 0, r, r]);
    ctx.fill();
    ctx.fillStyle = statusColor(n.status);
    ctx.beginPath();
    ctx.roundRect(c.x, c.y, 5, c.h, [r, 0, 0, r]);
    ctx.fill();

    if (c.h * z > 18) drawBody(c, a);

    const nameA = smooth(NAME_PX[0], NAME_PX[1], S.nameFont * z);
    if (nameA > 0.01) {
      // Deep in, the header text stops growing at 26 pixels and stays
      // centered in its band, so it does not crowd out the code.
      const hs = Math.min(1, 26 / (S.nameFont * z));
      ctx.globalAlpha = a * nameA;
      ctx.save();
      ctx.translate(c.x, c.y + S.header / 2);
      ctx.scale(hs, hs);
      ctx.translate(0, -S.header / 2);
      drawHeader(n, c.w / hs, z * hs);
      ctx.restore();
    }
    // While the name is too small to read, a card wide enough on the
    // screen shows it in screen pixels, cut to fit.
    const compactA = (1 - nameA) * smooth(34, 56, sw) * smooth(12, 18, c.h * z);
    if (compactA > 0.01) drawCompactName(c, a * compactA);
    ctx.globalAlpha = 1;
  }

  function drawCompactName(c, alpha) {
    const z = cam.z;
    setScreen();
    ctx.globalAlpha = alpha;
    ctx.font = `600 10px ${MONO}`;
    ctx.textBaseline = "middle";
    ctx.fillStyle = C.ink;
    const x = sx(c.x) + Math.max(5 * z, 2) + 4, maxW = c.w * z - (x - sx(c.x)) - 4;
    let text = (c.node.top ? "★ " : "") + c.node.name;
    const w = ctx.measureText(text).width;
    if (w > maxW) text = ellipsize(text, Math.floor(text.length * maxW / w));
    ctx.fillText(text, x, sy(c.y) + Math.max(S.header * z / 2, 7));
    setWorld();
  }

  // drawHeader draws a card's kind, name, place and badges in card-local
  // units, w wide; z is the zoom those units are drawn at.
  function drawHeader(n, w, z) {
    ctx.textBaseline = "alphabetic";
    let x = 18;
    const right = w - 14;
    ctx.font = `600 10px ${SANS}`;
    ctx.fillStyle = C.muted;
    const kind = (n.kind || "func").toUpperCase();
    ctx.fillText(kind, x, 19);
    x += ctx.measureText(kind).width + 8;
    // A star marks the highest changed function: start reading here.
    if (n.top) {
      ctx.font = `${S.nameFont}px ${SANS}`;
      ctx.fillStyle = statusColor(n.status);
      ctx.fillText("★", x, 20);
      x += ctx.measureText("★").width + 6;
    }
    // Right side: tests, exported, note.
    let rx = right;
    ctx.textAlign = "right";
    if (n.hasNote) {
      ctx.fillStyle = C.note;
      ctx.beginPath();
      ctx.arc(rx - 4, 15, 3.5, 0, Math.PI * 2);
      ctx.fill();
      rx -= 16;
    }
    if (n.exported) {
      ctx.font = `600 9.5px ${SANS}`;
      const tw = ctx.measureText("EXPORTED").width + 10;
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 1 / z;
      roundRect(rx - tw, 8, tw, 14, 7);
      ctx.stroke();
      ctx.fillStyle = C.muted;
      ctx.textAlign = "center";
      ctx.fillText("EXPORTED", rx - tw / 2, 18.5);
      ctx.textAlign = "right";
      rx -= tw + 8;
    }
    if (n.entry) {
      const label = entryTag(n.entry);
      ctx.font = `700 9.5px ${SANS}`;
      const tw = ctx.measureText(label).width + 12;
      ctx.fillStyle = n.entry.kind === "root" ? C.muted : C.entry;
      roundRect(rx - tw, 8, tw, 14, 7);
      ctx.fill();
      ctx.fillStyle = C.panel;
      ctx.textAlign = "center";
      ctx.fillText(label, rx - tw / 2, 18.5);
      ctx.textAlign = "right";
      rx -= tw + 8;
    }
    if (n.tests) {
      ctx.font = `11px ${SANS}`;
      ctx.fillStyle = C.muted;
      const label = `${n.tests} test${n.tests > 1 ? "s" : ""}`;
      ctx.fillText(label, rx, 19);
      rx -= ctx.measureText(label).width + 10;
    }
    ctx.textAlign = "left";
    ctx.font = `600 ${S.nameFont}px ${MONO}`;
    ctx.fillStyle = C.ink;
    ctx.fillText(ellipsize(n.name, Math.floor((rx - x) / (S.nameFont * CH))), x, 20);
    ctx.font = `${S.metaFont}px ${MONO}`;
    ctx.fillStyle = C.muted;
    // A handler shows its route, the first thing a reviewer looks for.
    const route = n.entry && n.entry.routes && n.entry.routes[0];
    // A long path loses its start, not its end, so the file name stays.
    const prefix = route ? route + "  ·  " : "";
    const pos = `${n.file}:${n.line}`;
    const room = Math.floor((right - 18) / (S.metaFont * CH)) - prefix.length;
    const loc = room > 1 && pos.length > room ? prefix + "…" + pos.slice(pos.length - room + 1) : prefix + pos;
    ctx.fillText(ellipsize(loc, Math.floor((right - 18) / (S.metaFont * CH))), 18, 34);
  }

  // drawBody draws a card's code: colored bars like a minimap when small,
  // then the text when it is readable. Changed lines and lines that call
  // something on the map are marked at every size.
  function drawBody(c, a) {
    const n = c.node, z = cam.z;
    const top = c.y + S.header + S.bodyPad, lh = c.lh;
    const x0 = c.x + 5, w0 = c.w - 5 - 1 / z;
    const changed = n.changed || [];
    ctx.globalAlpha = a;
    if (changed.length) {
      ctx.fillStyle = C.addedBg;
      for (const l of changed) ctx.fillRect(x0, top + rowOf(c, l) * lh, w0, lh + 0.01);
      ctx.fillStyle = C.added;
      for (const l of changed) ctx.fillRect(x0, top + rowOf(c, l) * lh, 2, lh + 0.01);
    }
    if (n.removed) {
      ctx.fillStyle = C.removedBg;
      c.rowNo.forEach((l, i) => { if (!l) ctx.fillRect(x0, top + i * lh, w0, lh + 0.01); });
      ctx.fillStyle = C.removed;
      c.rowNo.forEach((l, i) => { if (!l) ctx.fillRect(x0, top + i * lh, 2, lh + 0.01); });
    }
    if (c.callLines) {
      ctx.fillStyle = C.hl;
      for (const l of c.callLines) ctx.fillRect(x0 + 2, top + rowOf(c, l) * lh, w0 - 2, lh + 0.01);
    }
    const px = c.font * z;
    if (px < 0.5 || c.h * z < 24) return;
    const toks = tokens.get(c.id) ?? (px > 0.7 ? wantTokens(c) : null);
    const codeA = codeAlpha(c);
    const cw = c.font * CH;
    const left = c.x + S.bodyPad + 4 + c.gutter;
    const maxX = c.x + c.w - S.bodyPad;
    ctx.save();
    ctx.beginPath();
    ctx.rect(c.x, c.y + S.header, c.w, c.h - S.header);
    ctx.clip();
    if (codeA < 1) {
      const m = minimap(c, toks);
      if (m) {
        ctx.globalAlpha = a * (1 - codeA);
        ctx.drawImage(m.canvas, c.x, c.y + S.header, c.w, c.h - S.header);
      }
    }
    if (codeA > 0) {
      ctx.globalAlpha = a * codeA;
      ctx.textBaseline = "middle";
      ctx.font = `${c.font}px ${MONO}`;
      const view = viewRect();
      const first = Math.max(0, Math.floor((view.y - top) / lh)), last = Math.min(c.lines.length, Math.ceil((view.y + view.h - top) / lh));
      ctx.fillStyle = C.muted;
      ctx.textAlign = "right";
      for (let i = first; i < last; i++) {
        ctx.fillStyle = c.rowNo[i] ? C.muted : C.removed;
        ctx.fillText(c.rowNo[i] ? String(c.rowNo[i]) : "−", left - cw, top + (i + 0.5) * lh);
      }
      ctx.textAlign = "left";
      // The code scrolls sideways under the line numbers, which stay put.
      const scroll = scrollOf(c), ox = left - scroll;
      if (scroll > 0) {
        ctx.beginPath();
        ctx.rect(left - cw * 0.5, c.y + S.header, c.x + c.w - (left - cw * 0.5), c.h - S.header);
        ctx.clip();
      }
      if (hoverRef && hoverRef.card === c) {
        ctx.fillStyle = C.callerBg;
        ctx.fillRect(ox + hoverRef.c0 * cw, top + hoverRef.row * lh, (hoverRef.c1 - hoverRef.c0) * cw, lh);
      }
      // Every use of the hovered local name is marked, as an editor does.
      if (hoverLocal && hoverLocal.card === c) {
        const alpha = ctx.globalAlpha;
        ctx.globalAlpha = alpha * 0.35;
        ctx.fillStyle = C.note;
        for (const [i, spans] of c.locals) {
          for (const r of spans) if (r.g === hoverLocal.g) ctx.fillRect(ox + r.c0 * cw, top + i * lh, (r.c1 - r.c0) * cw, lh);
        }
        ctx.globalAlpha = alpha;
        for (const [i, spans] of c.locals) {
          for (const r of spans) if (r.g === hoverLocal.g) ctx.fillRect(ox + r.c0 * cw, top + (i + 0.9) * lh, (r.c1 - r.c0) * cw, Math.max(lh * 0.06, 1 / z));
        }
      }
      for (let i = first; i < last; i++) {
        const y = top + (i + 0.5) * lh;
        if (toks && toks[i]) {
          let col = 0;
          for (const t of toks[i]) {
            if (t.text.trim()) {
              ctx.fillStyle = t.color || C.ink;
              ctx.fillText(t.text, ox + col * cw, y);
            }
            col += t.text.length;
          }
        } else {
          ctx.fillStyle = C.ink;
          ctx.fillText(c.lines[i], ox, y);
        }
      }
      // A name that refers to another declaration is underlined, as a link.
      const thin = Math.max(lh * 0.05, 1 / z);
      for (let i = first; i < last; i++) {
        for (const r of c.refs.get(i) || []) {
          const on = hoverRef && hoverRef.card === c && hoverRef.row === i && hoverRef.c0 === r.c0;
          ctx.fillStyle = on ? C.caller : C.muted;
          ctx.globalAlpha = a * codeA * (on ? 1 : 0.5);
          ctx.fillRect(ox + r.c0 * cw, top + (i + 0.9) * lh, (r.c1 - r.c0) * cw, on ? thin * 1.5 : thin);
        }
      }
      // A thin bar shows that the code scrolls sideways, and where it is.
      const max = maxScroll(c);
      if (max > 0) {
        const track = maxX - left, view = track / (track + max);
        const thumb = Math.max(track * view, 12 / z);
        ctx.globalAlpha = a * codeA * 0.5;
        ctx.fillStyle = C.muted;
        ctx.fillRect(left + (track - thumb) * scroll / max, c.y + c.h - S.bodyPad * 0.7, thumb, Math.max(S.bodyPad * 0.35, 2 / z));
      }
    }
    ctx.restore();
  }

  // pins labels marked cards while their own names are too small to read,
  // as a map labels places. A label that would cover another is left out.
  function pins(list, alpha, color) {
    setScreen();
    ctx.font = `600 12px ${MONO}`;
    ctx.textBaseline = "middle";
    const placed = [];
    for (const c of list) {
      const text = c.node.name.length > 42 ? c.node.name.slice(0, 41) + "…" : c.node.name;
      const w = ctx.measureText(text).width + 18, h = 22;
      const x = sx(c.x + c.w / 2) - w / 2, y = sy(c.y) - h - 6;
      const box = { x, y, w, h };
      if (placed.some(b => overlaps(b, { x: box.x - 4, y: box.y - 2, w: box.w + 8, h: box.h + 4 }))) continue;
      placed.push(box);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = C.panel;
      roundRect(x, y, w, h, 11);
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.beginPath(); // the pointer under the label
      ctx.moveTo(x + w / 2 - 5, y + h);
      ctx.lineTo(x + w / 2, y + h + 5);
      ctx.lineTo(x + w / 2 + 5, y + h);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.fillStyle = C.ink;
      ctx.fillText(text, x + 9, y + h / 2 + 0.5);
    }
    setWorld();
    ctx.globalAlpha = 1;
  }

  // minimap returns a bitmap of a card's code drawn as colored bars, at a
  // resolution that suits the zoom. Bitmaps are kept, up to a pixel budget,
  // so a frame draws one image per card instead of a bar per token.
  const minimaps = new Map();
  let minimapPixels = 0, minimapDeadline = 0;
  function minimap(c, toks) {
    const bodyH = c.h - S.header;
    const want = Math.pow(2, Math.ceil(Math.log2(Math.max(cam.z * dpr, 1 / 16))));
    const scale = Math.min(want, 4, 2048 / c.w, 4096 / bodyH);
    let m = minimaps.get(c.id);
    const fresh = m && m.scale === scale && m.colored === !!toks && m.w === c.w;
    // Making bitmaps is limited per frame; until a card gets its turn, its
    // old bitmap is drawn scaled, or none at all.
    if (fresh || performance.now() > minimapDeadline) {
      if (!fresh) dirty = true;
      if (!m) return null;
      minimaps.delete(c.id);
      minimaps.set(c.id, m); // most recently used last
      return m;
    }
    if (m) minimapPixels -= m.pixels;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(c.w * scale));
    canvas.height = Math.max(1, Math.ceil(bodyH * scale));
    const g = canvas.getContext("2d");
    g.scale(scale, scale);
    g.globalAlpha = 0.6;
    const lh = c.lh, cw = c.font * CH, bh = lh * 0.56;
    const left = S.bodyPad + 4 + c.gutter, maxX = c.w - S.bodyPad;
    c.lines.forEach((text, i) => {
      const y = S.bodyPad + i * lh + (lh - bh) / 2;
      if (toks && toks[i]) {
        let col = 0;
        for (const t of toks[i]) {
          if (t.text.trim()) {
            g.fillStyle = t.color || C.muted;
            g.fillRect(left + col * cw, y, Math.max(0, Math.min(t.text.length * cw, maxX - left - col * cw)), bh);
          }
          col += t.text.length;
        }
      } else {
        const start = text.length - text.trimStart().length, len = text.trim().length;
        if (len) {
          g.fillStyle = C.muted;
          g.fillRect(left + start * cw, y, Math.max(0, Math.min(len * cw, maxX - left - start * cw)), bh);
        }
      }
    });
    m = { canvas, scale, colored: !!toks, w: c.w, pixels: canvas.width * canvas.height };
    minimaps.set(c.id, m);
    minimapPixels += m.pixels;
    for (const [id, old] of minimaps) {
      if (minimapPixels < 48e6) break;
      if (id === c.id) continue;
      minimaps.delete(id);
      minimapPixels -= old.pixels;
    }
    return m;
  }
  function clearMinimaps() { minimaps.clear(); minimapPixels = 0; }

  // drawMarks draws rings for the selection and the focus on top of
  // everything, so they show at the package level too.
  function drawMarks(view) {
    const z = cam.z;
    const ring = (r, color, gap, width, alpha, radius) => {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = width / z;
      roundRect(r.x - gap / z, r.y - gap / z, r.w + 2 * gap / z, r.h + 2 * gap / z, radius + gap / z);
      ctx.stroke();
    };
    if (focus && focus.ids) {
      const shown = focus.ids.map(id => cards.get(id)).filter(c => c && overlaps(c, view));
      for (const c of shown) {
        const t1 = openOf(c);
        ring(c, focus.color || C.note, 5, 3, 0.85, S.radius);
        if (t1 < 1) { // a solid mark shows where it is inside a package summary
          ctx.globalAlpha = (1 - t1) * 0.9;
          ctx.fillStyle = focus.color || C.note;
          roundRect(c.x, c.y, c.w, c.h, S.radius);
          ctx.fill();
        }
      }
      const closed = shown.filter(c => openOf(c) < 0.9);
      if (closed.length) pins(closed, (1 - Math.max(...closed.map(openOf))) / 0.9, focus.color || C.note);
    }
    if (focus && focus.pkg) {
      const p = pkgs.get(focus.pkg);
      if (p) ring(p, C.caller, 6, 3, 0.9, S.pkgRadius);
    }
    if (selected) {
      const c = cards.get(selected);
      if (c && overlaps(c, view)) {
        const t1 = openOf(c);
        ring(c, C.ink, 4, 2.5, 1, S.radius);
        if (t1 < 1) {
          ctx.globalAlpha = (1 - t1);
          ctx.fillStyle = C.caller;
          roundRect(c.x, c.y, c.w, c.h, S.radius);
          ctx.fill();
        }
        if (t1 < 0.9) pins([c], (1 - t1) / 0.9, C.caller);
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---------- comments ----------

  // pinPoint is where a comment pin sits in map space: after the code of
  // its line, after its card's name, at its package's corner, or at its own
  // point.
  function pinPoint(pin) {
    const c = pin.node && cards.get(pin.node);
    if (c) {
      const n = c.node, right = c.x + c.w - 8;
      if (pin.line >= n.line && pin.line <= n.endLine) {
        const text = (c.lines[rowOf(c, pin.line)] || "").trimEnd();
        return [clamp(codeLeft(c) - scrollOf(c) + (text.length + 1) * c.font * CH, codeLeft(c), right), lineY(c, pin.line)];
      }
      return [Math.min(right, c.x + 22 + (n.kind || "func").length * 6 + n.name.length * S.nameFont * CH + 12), c.y + 15];
    }
    const p = pin.pkg && pkgs.get(pin.pkg);
    if (p) return [p.x + p.w, p.y + S.pkgHeader / 2];
    if (pin.node || pin.pkg) return null; // hidden, for example a test while tests are off
    return [pin.x, pin.y];
  }

  const PIN_R = 11;
  // pinScreen is a pin's point on the screen. A pin on a card stays inside
  // the visible part of the card, so a wide card does not hide it.
  function pinScreen(pin) {
    const pt = pinPoint(pin);
    if (!pt) return null;
    let x = sx(pt[0]);
    const c = pin.node && cards.get(pin.node);
    if (c) x = Math.max(Math.min(x, W - 2.4 * PIN_R), Math.min(sx(c.x) + 12, x));
    return [x, sy(pt[1])];
  }
  // drawPins draws each pin as a speech bubble of a fixed screen size, so
  // a question is visible at every zoom.
  function drawPins() {
    const colors = { open: C.note, answered: C.caller, resolved: C.muted };
    for (const pin of notePins) {
      const pt = pinScreen(pin);
      if (!pt) continue;
      const [x, y] = pt;
      if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
      const r = pin.id === activePin ? PIN_R + 2 : PIN_R;
      ctx.globalAlpha = pin.state === "resolved" ? 0.7 : 1;
      ctx.fillStyle = colors[pin.state] || C.note;
      ctx.strokeStyle = C.panel;
      ctx.lineWidth = 2;
      ctx.beginPath(); // a round bubble with a tail toward its point
      ctx.moveTo(x, y);
      ctx.lineTo(x + r * 0.35, y - r * 0.9);
      ctx.arc(x + r * 0.9, y - r * 1.6, r, Math.PI * 0.72, Math.PI * 2.48);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      if (pin.id === activePin) {
        ctx.strokeStyle = C.ink;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.fillStyle = "#fff";
      ctx.font = `700 11px ${SANS}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(pin.state === "open" ? "?" : String(pin.count), x + r * 0.9, y - r * 1.6 + 0.5);
      ctx.textAlign = "left";
    }
    ctx.globalAlpha = 1;
  }

  function pickPin(x0, y0) {
    for (let i = notePins.length - 1; i >= 0; i--) {
      const pt = pinScreen(notePins[i]);
      if (!pt) continue;
      if (Math.hypot(x0 - (pt[0] + PIN_R * 0.9), y0 - (pt[1] - PIN_R * 1.6)) <= PIN_R + 3) return notePins[i].id;
    }
    return null;
  }

  // anchorAt names what is under a screen point, for a new comment: a card
  // and, when its lines can be told apart, a line; else a package; else the
  // point itself.
  function anchorAt(x0, y0) {
    const [x, y] = toWorld(x0, y0);
    const found = pick(x0, y0);
    if (found.card) {
      const c = found.card, n = c.node;
      const top = c.y + S.header + S.bodyPad;
      let line = 0;
      if (c.lh * cam.z >= 4 && y >= top) {
        // A deleted row has no line of its own; it is asked about at the line it came before.
        let i = clamp(Math.floor((y - top) / c.lh), 0, c.lines.length - 1);
        while (i < c.lines.length - 1 && !c.rowNo[i]) i++;
        line = c.rowNo[i] || n.endLine;
      }
      return { node: c.id, line };
    }
    if (found.pkg) return { pkg: found.pkg.id };
    return { x: Math.round(x), y: Math.round(y) };
  }

  // showPin flies to a pin: to its code line, its card, its package, or its point.
  function showPin(id) {
    const pin = notePins.find(p => p.id === id);
    const pt = pin && pinPoint(pin);
    if (!pt) return;
    if (pin.node && cards.has(pin.node)) {
      const c = cards.get(pin.node);
      const z = clamp(fitZoom(c, 40), 11 / c.font, 14 / c.font);
      const x = c.w * z > W - 80 ? c.x + (W / 2 - 40) / z : c.x + c.w / 2;
      flyTo({ x, y: pin.line ? pt[1] : (c.h * z > H - 80 ? c.y + (H / 2 - 40) / z : c.y + c.h / 2), z });
    } else if (pin.pkg) showPackage(pin.pkg);
    else flyTo({ x: pt[0], y: pt[1], z: Math.max(cam.z, 0.6) });
  }

  // ---------- input ----------

  // refAt is the name under a screen point that refers to another
  // declaration, when the card's code is open enough to read.
  let hoverRef = null;
  function refAt(c, sx0, sy0) {
    const hit = spanAt(c, c.refs, sx0, sy0);
    return hit && { card: c, row: hit.row, c0: hit.span.c0, c1: hit.span.c1, to: hit.span.to };
  }
  // hoverLocal is the local name under the pointer: its card and number.
  let hoverLocal = null;
  function localAt(c, sx0, sy0) {
    const hit = spanAt(c, c.locals, sx0, sy0);
    return hit && { card: c, g: hit.span.g };
  }
  // spanAt finds the span of rows under a screen point, when the card's code
  // is open enough to read.
  function spanAt(c, spans, sx0, sy0) {
    if (!spans.size || codeAlpha(c) < 0.5) return null;
    const [x, y] = toWorld(sx0, sy0);
    const top = c.y + S.header + S.bodyPad, left = codeLeft(c), cw = c.font * CH;
    if (x < left) return null;
    const row = Math.floor((y - top) / c.lh), col = Math.floor((x - left + scrollOf(c)) / cw);
    const span = (spans.get(row) || []).find(r => col >= r.c0 && col < r.c1);
    return span ? { row, span } : null;
  }
  // portAt finds the edges that end within a few pixels of a screen point:
  // the nearest arrow end, and every other edge that ends at the same place.
  function portAt(sx0, sy0) {
    let best = null, bestD = Infinity;
    for (const a of arrows) {
      // Measure from the middle of the head, which points out from the card.
      const ang = Math.atan2(a.p[1] - a.from[1], a.p[0] - a.from[0]);
      const cx = sx(a.p[0]) - Math.cos(ang) * a.px / 2, cy = sy(a.p[1]) - Math.sin(ang) * a.px / 2;
      const d = Math.hypot(cx - sx0, cy - sy0);
      if (d < Math.max(22, a.px * 1.5) && d < bestD) { best = a; bestD = d; }
    }
    if (!best) return null;
    const at = best.p;
    const here = arrows.filter(a => a.e.to === best.e.to && Math.hypot(sx(a.p[0]) - sx(at[0]), sy(a.p[1]) - sy(at[1])) < 3);
    return { to: best.e.to, x: sx(at[0]), y: sy(at[1]), edges: [...new Set(here.map(a => a.e))] };
  }
  // clearPort closes the list of callers when the map moves under it.
  function clearPort() {
    if (!hoverPort) return;
    hoverPort = null;
    opts.onPort?.(null, true);
    request();
  }
  const samePort = (a, b) => a === b || !!a && !!b && a.to === b.to && a.edges.length === b.edges.length && a.edges.every((e, i) => e === b.edges[i]);
  const sameRef = (a, b) => a === b || !!a && !!b && a.card === b.card && a.row === b.row && a.c0 === b.c0;

  function pick(sx0, sy0) {
    const [x, y] = toWorld(sx0, sy0);
    for (const c of cards.values()) if (openOf(c) > 0.5 && hit(c, x, y)) return { card: c };
    for (const p of pkgs.values()) if (hit(p, x, y)) return { pkg: p };
    return {};
  }

  const pointers = new Map();
  let drag = null, pinch = null;

  canvas.addEventListener("pointerdown", e => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
    stopMotion();
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: cam.z };
      drag = null;
      return;
    }
    drag = { x: e.offsetX, y: e.offsetY, moved: false, last: performance.now(), vx: 0, vy: 0 };
  });

  canvas.addEventListener("pointermove", e => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, pinch.z * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d);
      request();
      return;
    }
    if (drag) {
      const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      canvas.classList.add("dragging");
      const now = performance.now(), dt = Math.max(1, now - drag.last);
      cam.x -= dx / cam.z; cam.y -= dy / cam.z;
      drag.vx = lerp(drag.vx, dx / cam.z / dt, 0.4);
      drag.vy = lerp(drag.vy, dy / cam.z / dt, 0.4);
      drag.x = e.offsetX; drag.y = e.offsetY; drag.last = now;
      opts.onTip?.(null);
      clearPort();
      request();
      return;
    }
    const port = commentMode ? null : portAt(e.offsetX, e.offsetY);
    if (!samePort(port, hoverPort)) {
      hoverPort = port;
      opts.onPort?.(port && {
        x: port.x, y: port.y, to: port.to,
        from: port.edges.map(e => ({ id: e.from, line: (e.lines || []).find(l => l >= e.a.node.line && l <= e.a.node.endLine) || 0, via: e.via })),
      });
      request();
    }
    if (port) {
      canvas.style.cursor = "pointer";
      opts.onTip?.(null);
      return;
    }
    const found = pick(e.offsetX, e.offsetY);
    const id = found.card ? found.card.id : null;
    if (id !== hover) { hover = id; request(); }
    const ref = found.card && !commentMode ? refAt(found.card, e.offsetX, e.offsetY) : null;
    if (!sameRef(ref, hoverRef)) { hoverRef = ref; request(); }
    const local = found.card && !commentMode && !ref ? localAt(found.card, e.offsetX, e.offsetY) : null;
    if ((local && local.card) !== (hoverLocal && hoverLocal.card) || (local && local.g) !== (hoverLocal && hoverLocal.g)) { hoverLocal = local; request(); }
    const onPin = pickPin(e.offsetX, e.offsetY);
    canvas.style.cursor = onPin || (!commentMode && (found.card || found.pkg)) ? "pointer" : commentMode ? "crosshair" : "grab";
    if (onPin) { opts.onTip?.(null); return; }
    // A tooltip names what is under the pointer while its own label is too small to read.
    let tip = null;
    if (found.card && S.nameFont * cam.z < NAME_PX[1]) tip = { title: found.card.node.name, sub: `${found.card.node.kind} · ${found.card.node.file}:${found.card.node.line}` };
    else if (found.pkg && found.pkg.t < 0.5 && found.pkg.labelHidden) tip = { title: found.pkg.path, sub: statsText(found.pkg) };
    opts.onTip?.(tip && { ...tip, x: e.offsetX, y: e.offsetY });
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pinch) { if (pointers.size < 2) pinch = null; return; }
    if (!drag) return;
    canvas.classList.remove("dragging");
    if (drag.moved) {
      if (performance.now() - drag.last < 80 && Math.hypot(drag.vx, drag.vy) * cam.z > 0.15) {
        inertia = { vx: drag.vx, vy: drag.vy, last: performance.now() };
        request();
      }
    } else if (e.type === "pointerup") {
      const pin = pickPin(e.offsetX, e.offsetY);
      if (pin) { opts.onPin?.(pin); drag = null; return; }
      if (commentMode) { opts.onDrop?.(anchorAt(e.offsetX, e.offsetY)); drag = null; return; }
      // An arrow end with one edge goes straight to its caller; with more,
      // the list of callers stays open to choose from.
      const port = portAt(e.offsetX, e.offsetY);
      if (port) { if (port.edges.length === 1) opts.onNode?.(port.edges[0].from, true); drag = null; return; }
      const found = pick(e.offsetX, e.offsetY);
      const ref = found.card ? refAt(found.card, e.offsetX, e.offsetY) : null;
      if (ref) opts.onRef?.(ref.to);
      else if (found.card) opts.onNode?.(found.card.id);
      else if (found.pkg) opts.onPackage?.(found.pkg.id);
      else opts.onBackground?.();
    }
    drag = null;
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", () => {
    if (!drag && (hover || hoverRef || hoverPort || hoverLocal)) { hover = null; hoverRef = null; hoverPort = null; hoverLocal = null; request(); }
    opts.onTip?.(null);
    opts.onPort?.(null);
  });

  canvas.addEventListener("dblclick", e => {
    const found = pick(e.offsetX, e.offsetY);
    if (found.card) showCode(found.card.id);
    else if (found.pkg && found.pkg.t < 0.5) showPackage(found.pkg.id);
    else {
      const [x, y] = toWorld(e.offsetX, e.offsetY);
      flyTo({ x: lerp(cam.x, x, 0.5), y: lerp(cam.y, y, 0.5), z: cam.z * 2 });
    }
  });

  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    // A sideways swipe, or shift and the wheel, over code wider than its
    // card scrolls that card's code instead of zooming the map.
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const c = pick(e.offsetX, e.offsetY).card;
      if (c && codeAlpha(c) > 0.5 && maxScroll(c) > 0) {
        const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
        const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit / cam.z;
        c.scroll = clamp(scrollOf(c) + d, 0, maxScroll(c));
        hoverRef = null; hoverLocal = null;
        request();
        return;
      }
    }
    fly = null; inertia = null;
    const scale = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    const k = e.ctrlKey ? 0.011 : 0.0024;
    const factor = Math.exp(-e.deltaY * scale * k);
    const target = clamp((wheel ? wheel.target : cam.z) * factor, minZ(), MAX_Z);
    wheel = { sx: e.offsetX, sy: e.offsetY, target, fast: e.ctrlKey };
    opts.onTip?.(null);
    clearPort();
    request();
  }, { passive: false });

  // zoomBy zooms around the middle of the view, as the + and − buttons do.
  function zoomBy(f) {
    stopMotion();
    flyTo({ x: cam.x, y: cam.y, z: cam.z * f });
  }

  // goLevel moves to a zoom where the named level shows, around what is in
  // the middle of the view.
  function goLevel(level) {
    const [x, y] = [cam.x, cam.y];
    const nearest = () => {
      let best = null, bd = Infinity;
      for (const c of cards.values()) {
        const d = Math.hypot(clamp(x, c.x, c.x + c.w) - x, clamp(y, c.y, c.y + c.h) - y);
        if (d < bd) { bd = d; best = c; }
      }
      return best;
    };
    if (level === "packages") {
      const p = [...pkgs.values()].find(p => hit(p, x, y));
      const z = Math.min(fitZoom(bounds, 40), PKG_FADE[0] * 0.8, p ? closedZoom(p) : Infinity);
      flyTo(z >= fitZoom(bounds, 40) * 0.999 ? fitRect(bounds, { pad: 40 }) : { x, y, z });
    } else if (level === "decls") {
      const p = [...pkgs.values()].find(p => hit(p, x, y));
      const target = p ? fitRect(p, { pad: 50, maxZ: 0.9 }) : { x, y, z: 0.7 };
      // A package that fills the view is open; a smaller one needs the zoom.
      if (!p || openness(p, target.z) < 0.99) target.z = clamp(target.z, PKG_FADE[1] * 1.15, 0.9);
      flyTo(target);
    } else if (level === "code") {
      const c = (selected && cards.get(selected)) || nearest();
      if (c) showCode(c.id);
    }
  }

  // ---------- size ----------

  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    request();
  }
  new ResizeObserver(resize).observe(canvas.parentElement);
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", () => { readColors(); clearMinimaps(); clearTokens(); });
  readColors();
  resize();

  // setCallLines marks, in each card, the lines that use something on the map.
  function markCallLines() {
    for (const c of cards.values()) c.callLines = null;
    for (const e of edges) {
      const lines = (e.lines || []).filter(l => l >= e.a.node.line && l <= e.a.node.endLine);
      if (!lines.length) continue;
      e.a.callLines = [...new Set([...(e.a.callLines || []), ...lines])];
    }
  }

  return {
    setData(data, animate = false) { setData(data, animate); markCallLines(); },
    fit, flyTo, showIds, showCode, showPackage, setFocus, select, zoomBy, goLevel, resize,
    clearTokens, showPin,
    setPins(list) { notePins = list; request(); },
    setActivePin(id) { activePin = id; request(); },
    setCommentMode(on) { commentMode = on; canvas.style.cursor = on ? "crosshair" : "grab"; },
    get camera() { return { ...cam }; },
    get level() { return lastLevel; },
    get drawMs() { return drawMs; },
  };
}

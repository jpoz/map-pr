"use strict";
// The app joins the zoomable map (engine.js) to the side panel: the summary,
// themes, the guided tour, declaration details and browser history.
const NOTES = window.MAPR_NOTES || {};
NOTES.themes = NOTES.themes || [];
NOTES.tour = NOTES.tour || [];
NOTES.nodes = NOTES.nodes || {};
const DATA = window.MAPR_DATA;

const nodes = DATA.nodes || [];
const edges = DATA.edges || [];
const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
// Defs are the definitions of code the map uses but does not show; USES
// says which names on which lines refer to a node or a def.
const DEFS = Object.fromEntries((DATA.defs || []).map(d => [d.id, d]));
const USES = DATA.uses || {};
const declOf = id => byId[id] || DEFS[id];
// identName is the name a declaration is called by in code: Foo for (*T).Foo.
const identName = d => d.name.slice(d.name.lastIndexOf(".") + 1);
let usedByCache = null;
function usersOfDecl(id) {
  if (!usedByCache) {
    usedByCache = {};
    for (const [from, us] of Object.entries(USES)) for (const u of us) (usedByCache[u.to] ||= []).push(from);
  }
  return usedByCache[id] || [];
}
const idOf = Object.fromEntries(nodes.map(n => [n.key, n.id]));
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
// Notes and comments are written in a small part of Markdown: `code`,
// **bold**, blank-line paragraphs, and line breaks.
const md = s => String(s || "").trim().split(/\n\s*\n/).map(p => "<p>" + esc(p)
  .replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
  .replace(/\n/g, "<br>") + "</p>").join("");
const shortPkg = p => p.split("/").slice(-2).join("/");
const shortRef = r => /^[0-9a-f]{40}$/.test(r) ? r.slice(0, 7) : r;
const isChange = n => n.status === "added" || n.status === "modified";
const kindOf = n => n.kind || "func";
const code = nodes.filter(n => !n.isTest);
const tests = nodes.filter(n => n.isTest);
const noteOf = n => NOTES.nodes[n.key];
const statusLabel = n => ({ caller: "uses a change", entry: "entry point" })[n.status] || n.status;

// ---------- entry points ----------

// Entry points are where execution starts: HTTP handlers, main, functions
// started with go, and code with no callers. They are a good place to start
// a review: each one shows how the changes are reached.
const entryTag = e => ({ http: "HTTP", goroutine: "go", main: "main", root: "no callers" })[e.kind] || "entry";
function entryText(e) {
  switch (e.kind) {
    case "http": return e.routes && e.routes.length ? e.routes.join(", ") : "HTTP handler";
    case "goroutine": return "started with a go statement";
    case "main": return "the program's main()";
    default: return "no callers outside tests: called through an interface, by reflection, or not used yet";
  }
}
const entryPill = n => n.entry ? `<span class="entry-pill ${n.entry.kind}">${entryTag(n.entry)}</span>` : "";
// walk follows edges from id, up to the users or down to what it uses.
function walk(id, up) {
  const seen = new Map([[id, 0]]), queue = [id];
  while (queue.length) {
    const cur = queue.shift();
    for (const e of edges) {
      const next = up ? (e.to === cur && e.from) : (e.from === cur && e.to);
      if (next && !seen.has(next) && !byId[next].isTest) {
        seen.set(next, seen.get(cur) + 1 + (e.via ? e.via.length : 0));
        queue.push(next);
      }
    }
  }
  seen.delete(id);
  return seen;
}
const changesReached = id => [...walk(id, false).keys()].filter(x => isChange(byId[x]) && kindOf(byId[x]) !== "type").sort();
const entries = nodes.filter(n => n.entry && !n.isTest)
  .map(n => { const ids = changesReached(n.id); return { n, reach: ids.length, sig: n.entry.kind + ":" + ids.join("|") }; })
  .sort((a, b) => (a.n.entry.kind === "root") - (b.n.entry.kind === "root") || b.reach - a.reach || a.n.name.localeCompare(b.n.name));
// Entry points of one kind that reach the same changes, such as many routes
// that share one auth check, make one row.
const entryGroups = [...entries.reduce((m, x) => m.set(x.sig, [...(m.get(x.sig) || []), x]), new Map()).values()];

const THEME_COLORS = ["#7c5cff", "#e8590c", "#0ca678", "#d6336c", "#1c7ed6", "#f59f00", "#5c940d", "#ae3ec9"];
NOTES.themes.forEach((t, i) => { t.color = THEME_COLORS[i % THEME_COLORS.length]; });
const themeById = Object.fromEntries(NOTES.themes.map(t => [t.id, t]));
const themesOf = n => NOTES.themes.filter(t => (t.nodes || []).includes(n.key));

if (NOTES.title) {
  document.getElementById("title").textContent = NOTES.title;
  document.title = NOTES.title;
}
document.getElementById("meta").innerHTML =
  `<code>${esc(shortRef(DATA.base))}</code> (${esc(DATA.mergeBase.slice(0, 7))}) → <code>${esc(DATA.head)}</code> + work tree · ` +
  `${code.filter(isChange).length} changed · ${code.filter(n => n.status === "caller").length} users · ${entries.length} entry points · ${tests.length} tests`;

// Tests often outnumber the code they cover, so they start hidden and each
// card counts the tests that use it instead.
const testsToggle = document.getElementById("show-tests");
testsToggle.checked = code.length === 0;
const testUsers = id => edges.filter(e => e.to === id && byId[e.from].isTest).length;

// ---------- syntax colors ----------

// @pierre/diffs (diffs.com) colors diffs and code with Shiki. It loads on
// first use; offline, diffs and code stay plain.
let diffsLib;
const loadDiffs = () => diffsLib ??= import("https://esm.sh/@pierre/diffs@1.5.2");
// The page uses Shiki's WebAssembly regex engine. The JavaScript engine can
// hang the page on some Go code (seen on a comment with "({a,b})" in a struct).
const ENGINE = "shiki-wasm";
async function highlighter(file) {
  const { getSharedHighlighter, getFiletypeFromFileName } = await loadDiffs();
  const lang = getFiletypeFromFileName(file);
  return [await getSharedHighlighter({ themes: ["pierre-light", "pierre-dark"], langs: [lang], preferredHighlighter: ENGINE }), lang];
}
const dark = matchMedia("(prefers-color-scheme: dark)");

async function tokenize(n, text) {
  const [hl, lang] = await highlighter(n.file);
  const { tokens } = hl.codeToTokens(text, { lang, theme: dark.matches ? "pierre-dark" : "pierre-light" });
  return tokens.map(line => line.map(t => ({ text: t.content, color: t.color })));
}

// ---------- map ----------

const tip = document.getElementById("tip");
const map = ZoomMap(document.getElementById("map"), {
  tokenize,
  onNode: id => selectNode(id, { fly: false }),
  onPackage: pkg => selectPackage(pkg),
  onBackground: () => { if (location.hash) home({ fly: false }); },
  onPin: id => showThread(id),
  onDrop: anchor => { setCommentMode(false); newComment(anchor); },
  onLevel: level => {
    for (const b of document.querySelectorAll("[data-level]")) b.classList.toggle("on", b.dataset.level === level);
  },
  onTip: t => {
    if (!t) { tip.hidden = true; return; }
    tip.innerHTML = `<b>${esc(t.title)}</b><span>${esc(t.sub)}</span>`;
    tip.hidden = false;
    tip.style.transform = `translate(${t.x + 14}px, ${t.y + 14}px)`;
  },
});

function mapData() {
  const shown = nodes.filter(n => testsToggle.checked || !n.isTest).map(n => ({
    ...n,
    tests: testsToggle.checked ? 0 : testUsers(n.id),
    hasNote: !!noteOf(n),
  }));
  return { nodes: shown, edges, stats: STATS };
}

// ---------- panel ----------

function codeBlock(n, highlight = []) {
  const changed = new Set(n.changed || []);
  const hl = new Set(highlight);
  return `<pre class="src" data-node="${esc(n.id)}">` + n.source.split("\n").map((text, i) => {
    const no = n.line + i;
    const cls = [changed.has(no) && "chg", hl.has(no) && "hl"].filter(Boolean).join(" ");
    return `<span class="ln ${cls}"><span class="no">${no}</span><span class="code">${esc(text)}</span></span>`;
  }).join("") + "</pre>";
}

const badge = n => `<span class="badge ${n.status}">${statusLabel(n)}</span>`;
const kindTag = n => `<span class="kind">${kindOf(n)}</span>`;

function linkList(items) {
  if (!items.length) return `<p class="empty">None on the map.</p>`;
  return `<ul class="links">${items.map(([id, text]) =>
    `<li data-id="${esc(id)}">${text}</li>`).join("")}</ul>`;
}

// nodeList shows nodes with their notes, for theme and tour panels.
function nodeList(keys) {
  return linkList(keys.filter(k => idOf[k]).map(k => {
    const n = byId[idOf[k]];
    const note = noteOf(n);
    return [n.id, `<span class="name">${badge(n)} ${kindTag(n)} ${esc(n.name)}</span>` +
      ` <span class="loc">${esc(n.file)}</span>` + (note ? `<div class="note small">${md(note)}</div>` : "")];
  }));
}

const PATCHES = DATA.patches || {};
const deletedFiles = new Set(DATA.deleted || []);
// Line counts per file. A map saved before map-pr kept them counts the patches.
const STATS = DATA.stats || Object.fromEntries(Object.entries(PATCHES).map(([f, patch]) => {
  const lines = patch.split("\n");
  return [f, { added: lines.filter(l => l.startsWith("+")).length, deleted: lines.filter(l => l.startsWith("-")).length }];
}));

function patchBlock(patch) {
  return "<pre class=\"diff\">" + patch.split("\n").map(line => {
    const cls = line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "";
    return `<span class="ln ${cls}">${esc(line) || " "}</span>`;
  }).join("") + "</pre>";
}

// fileList shows each file's diff in a section that opens on click.
function fileList(title, files, open = false) {
  if (!files || !files.length) return "";
  return `<h3>${title}</h3>` + files.map(f => {
    const patch = PATCHES[f];
    const st = STATS[f];
    const counts = st ? ` <span class="add-count">+${st.added}</span> <span class="del-count">−${st.deleted}</span>` : "";
    const label = `${esc(f)}${deletedFiles.has(f) ? ` <span class="badge deleted">deleted</span>` : ""}${counts}`;
    if (!patch) return `<div class="file"><div class="file-name">${label}</div></div>`;
    return `<details class="file" data-file="${esc(f)}" ${open ? "open" : ""}><summary class="file-name">${label}</summary>` +
      `<div class="diff-view">${patchBlock(patch)}</div></details>`;
  }).join("");
}

// The plain diff shows at once and the highlighted one replaces it.
async function highlightFile(details) {
  if (details.dataset.highlighted) return;
  details.dataset.highlighted = "1";
  const path = details.dataset.file;
  const body = PATCHES[path].split("\n").filter(l => /^[ +\-@\\]/.test(l)).join("\n");
  const added = /^@@ -0,0 /.test(body);
  const header = `--- ${added ? "/dev/null" : "a/" + path}\n+++ ${deletedFiles.has(path) ? "/dev/null" : "b/" + path}\n`;
  try {
    const { FileDiff, processFile } = await loadDiffs();
    const fileDiff = processFile(header + body + "\n");
    if (!fileDiff) return;
    const view = details.querySelector(".diff-view");
    const target = document.createElement("div");
    new FileDiff({
      themeType: "system", diffStyle: "unified", disableFileHeader: true,
      overflow: "wrap", lineDiffType: "word-alt", hunkSeparators: "line-info",
      preferredHighlighter: ENGINE,
    }).render({ fileDiff, containerWrapper: target });
    view.replaceChildren(target);
  } catch (err) {
    console.warn("map-pr: syntax-highlighted diff unavailable, showing plain diff", err);
  }
}

// linkRefs turns each name in a source block that refers to another
// declaration into a link to its definition. It runs on the plain source
// and again after syntax coloring replaces it.
function linkRefs(pre) {
  const n = declOf(pre.dataset.node);
  const rows = pre.querySelectorAll(".code");
  for (const u of USES[n.id] || []) {
    const to = declOf(u.to);
    if (!to) continue;
    const name = identName(to);
    for (const line of u.lines) {
      const cell = rows[line - n.line];
      if (!cell) continue;
      const spans = [...cell.querySelectorAll("span")].filter(sp => sp.textContent === name && !sp.classList.contains("ref"));
      if (spans.length) {
        for (const sp of spans) { sp.classList.add("ref"); sp.dataset.ref = u.to; }
      } else if (!cell.querySelector("span")) {
        const re = new RegExp(`\\b${name.replace(/[$]/g, "\\$&")}\\b`, "g");
        cell.innerHTML = cell.innerHTML.replace(re, m => `<span class="ref" data-ref="${esc(u.to)}">${m}</span>`);
      } else {
        // A token holds more than the name: wrap the name inside it.
        for (const sp of cell.querySelectorAll("span:not(.ref)")) {
          if (sp.children.length || !new RegExp(`\\b${name}\\b`).test(sp.textContent)) continue;
          sp.innerHTML = sp.innerHTML.replace(new RegExp(`\\b${name}\\b`, "g"), m => `<span class="ref" data-ref="${esc(u.to)}">${m}</span>`);
        }
      }
    }
  }
}

// openDecl shows a declaration: on the map if it is there, else its definition.
const openDecl = id => byId[id] ? selectNode(id) : showDef(id);

// showDef shows the definition of code the PR does not change, with the
// declarations on this map that use it.
function showDef(id) {
  const d = DEFS[id];
  if (!d) return;
  tourStep = -1;
  const users = usersOfDecl(id).filter(x => declOf(x));
  const total = d.endLine - d.line + 1, shown = d.source.split("\n").length;
  setPanel(`
    <span class="back" data-back>← Back</span>
    <h2><span class="kind">${esc(d.kind)}</span> ${esc(d.name)}</h2>
    <span class="badge unchanged">not changed in this PR</span>
    <div class="loc">${esc(d.file)}:${d.line}</div>
    <h3>Used here by</h3>
    ${linkList(users.map(x => [x, `<span class="name">${byId[x] ? badge(byId[x]) + " " : ""}<span class="kind">${esc(declOf(x).kind)}</span> ${esc(declOf(x).name)}</span> <span class="loc">${esc(declOf(x).file)}</span>`]))}
    <h3>Definition</h3>
    <div class="src-path">${esc(d.file)}:${d.line}</div>
    ${codeBlock(d)}
    ${shown < total ? `<p class="empty">The first ${shown} of ${total} lines. The rest is in the file.</p>` : ""}`);
  record("def=" + id);
}

// highlightCode colors a declaration's source in place, so the line numbers
// and the changed and call-site marks stay.
async function highlightCode(pre) {
  const n = declOf(pre.dataset.node);
  try {
    const [hl, lang] = await highlighter(n.file);
    const { tokens } = hl.codeToTokens(n.source, { lang, themes: { light: "pierre-light", dark: "pierre-dark" } });
    const cells = pre.querySelectorAll(".code");
    tokens.forEach((line, i) => {
      if (!cells[i]) return;
      cells[i].innerHTML = line.map(t => {
        const style = typeof t.htmlStyle === "string" ? t.htmlStyle
          : Object.entries(t.htmlStyle || { color: t.color }).map(([k, v]) => `${k}:${v}`).join(";");
        return `<span style="${esc(style)}">${esc(t.content)}</span>`;
      }).join("");
    });
    linkRefs(pre);
  } catch (err) {
    console.warn("map-pr: syntax-highlighted source unavailable, showing plain source", err);
  }
}

const panel = document.getElementById("panel");
panel.addEventListener("click", e => {
  const ref = e.target.closest(".ref");
  if (ref) { e.preventDefault(); openDecl(ref.dataset.ref); }
});

// setPanel fills the side panel. A wide panel gives diffs room in a step
// that shows only files.
function setPanel(html, wide = false) {
  if (!/data-resolve/.test(html)) { openThread = null; map.setActivePin(null); }
  panel.classList.toggle("wide", wide);
  panel.innerHTML = html;
  panel.scrollTop = 0;
  for (const li of panel.querySelectorAll("li[data-id], li.group > div[data-id]")) li.onclick = () => openDecl(li.dataset.id);
  for (const b of panel.querySelectorAll("[data-back]")) b.onclick = () => history.length > 1 ? history.back() : home();
  for (const pre of panel.querySelectorAll("pre.src[data-node]")) linkRefs(pre);
  for (const li of panel.querySelectorAll("li[data-theme]")) li.onclick = () => showTheme(li.dataset.theme);
  for (const li of panel.querySelectorAll("li[data-pkg]")) li.onclick = () => selectPackage(li.dataset.pkg);
  for (const b of panel.querySelectorAll("[data-step]")) b.onclick = () => showStep(+b.dataset.step);
  for (const b of panel.querySelectorAll("[data-home]")) b.onclick = () => home();
  for (const b of panel.querySelectorAll("[data-code]")) b.onclick = () => map.showCode(b.dataset.code);
  for (const b of panel.querySelectorAll("[data-entries]")) b.onclick = () => {
    const ids = entries.map(x => x.n.id);
    map.select(null);
    map.setFocus({ ids, color: cssVar("--entry") });
    map.showIds(ids);
  };
  for (const li of panel.querySelectorAll("li[data-thread]")) li.onclick = () => showThread(li.dataset.thread, { fly: true });
  for (const b of panel.querySelectorAll("[data-ask]")) b.onclick = () => newComment({ node: b.dataset.ask, line: 0 });
  if (comments.on) {
    for (const pre of panel.querySelectorAll("pre.src[data-node]")) {
      pre.classList.add("askable");
      pre.querySelectorAll(".no").forEach(no => {
        no.title = "Ask about this line";
        no.onclick = () => newComment({ node: pre.dataset.node, line: +no.textContent });
      });
    }
  }
  for (const pre of panel.querySelectorAll("pre[data-node]")) highlightCode(pre);
  for (const d of panel.querySelectorAll("details[data-file]")) {
    if (d.open) highlightFile(d);
    d.addEventListener("toggle", () => d.open && highlightFile(d));
  }
}

// ensureShown turns tests on when a view needs one that is hidden.
function ensureShown(ids) {
  if (ids.some(id => byId[id].isTest) && !testsToggle.checked) {
    testsToggle.checked = true;
    map.setData(mapData(), true);
  }
}

// where says where an edge's call is: its lines, or for an edge from an
// entry point, the calls off the map in between.
const where = (e, prefix = "") => e.via
  ? `through ${e.via.length ? e.via.map(esc).join(" → ") : "a direct call"}`
  : prefix + (e.lines || []).join(", ");

function showNode(id) {
  const n = byId[id];
  const uses = edges.filter(e => e.from === id);
  const usedBy = edges.filter(e => e.to === id);
  let usedByNote = "";
  if (n.hidden > 0) usedByNote = `<p class="empty">${n.hidden} more not on the map.</p>`;
  else if (!n.expanded && n.callers > 0) usedByNote = `<p class="empty">${n.callers} more not shown (raise -depth).</p>`;
  const exported = n.exported
    ? `<span class="badge exported">exported</span><p class="empty">Code outside this repository can use it. The map shows only users in this repository.</p>`
    : "";
  const themes = themesOf(n).map(t =>
    `<li data-theme="${esc(t.id)}"><span class="chip" style="background:${t.color}"></span><span class="title">${esc(t.title)}</span></li>`).join("");
  const note = noteOf(n);
  const viaEdges = n.status === "entry" ? uses.filter(e => e.via) : [];
  const entryInfo = n.entry ? `<h3>Entry point</h3><p>${entryPill(n)} ${esc(entryText(n.entry))}</p>` +
    (viaEdges.length ? `<p class="empty">Reaches the changes through code that is not on the map:</p>` +
      linkList(viaEdges.map(e => [e.to, `<span class="path">${esc(n.name)} → ${e.via.map(v => esc(v) + " → ").join("")}</span>` +
        `<span class="name">${kindTag(byId[e.to])} ${esc(byId[e.to].name)}</span>`])) : "") : "";
  const from = [...walk(id, true)].filter(([x]) => byId[x].entry).sort((a, b) => a[1] - b[1]);
  const reachedFrom = !n.entry || n.status !== "entry" ? `<h3>Reached from</h3>` + (from.length
    ? linkList(from.slice(0, 12).map(([x, hops]) => [x, `<span class="name">${entryPill(byId[x])} ${esc(byId[x].name)}</span>` +
      ` <span class="loc">${esc(byId[x].entry.kind === "http" && byId[x].entry.routes ? byId[x].entry.routes[0] : entryText(byId[x].entry))} · ${hops} call${hops === 1 ? "" : "s"} up</span>`])) +
      (from.length > 12 ? `<p class="empty">${from.length - 12} more.</p>` : "")
    : `<p class="empty">No entry point found within reach on the map.</p>`) : "";

  setPanel(`
    <span class="back" data-home>← Overview</span>
    <h2>${kindTag(n)} ${esc(n.name)}</h2>
    ${badge(n)} ${entryPill(n)} ${exported}
    <div class="loc">${esc(n.package)}<br>${esc(n.file)}:${n.line}</div>
    ${note ? `<div class="note">${md(note)}</div>` : ""}
    ${themes ? `<h3>Part of</h3><ul class="links themes">${themes}</ul>` : ""}
    ${entryInfo}
    ${reachedFrom}
    <h3>Uses these changes</h3>
    ${linkList(uses.filter(e => !viaEdges.includes(e)).map(e => [e.to, `<span class="name">${kindTag(byId[e.to])} ${esc(byId[e.to].name)}</span> <span class="loc">${where(e, "line ")}</span>`]))}
    ${(() => {
      const plain = (USES[id] || []).filter(u => DEFS[u.to]);
      return plain.length ? `<h3>Also uses (not changed)</h3>` + linkList(plain.map(u => [u.to,
        `<span class="name"><span class="kind">${esc(DEFS[u.to].kind)}</span> ${esc(DEFS[u.to].name)}</span> <span class="loc">line ${u.lines.join(", ")}</span>`])) : "";
    })()}
    <h3>Used by</h3>
    ${linkList(usedBy.map(e => [e.from, `<span class="name">${kindTag(byId[e.from])} ${esc(byId[e.from].name)}</span> <span class="loc">${e.via ? where(e) : esc(byId[e.from].file) + ":" + where(e)}</span>`]))}
    ${usedByNote}
    ${comments.on ? `<h3>Questions <button class="mini" data-ask="${esc(id)}">Ask about this</button></h3>
    <div class="questions" data-for="${esc(n.key)}">${threadList(threadsAt(n.key))}</div>` : ""}
    <h3>Source <button class="mini" data-code="${esc(id)}">Zoom to code</button></h3>
    <div class="src-path">${esc(n.file)}:${n.line}${comments.on ? ` <span class="hint">· click a line number to ask about it</span>` : ""}</div>
    ${codeBlock(n, uses.flatMap(e => e.lines || []))}`);
}

// selectNode shows a declaration. From the panel or a link the map flies to
// it with its neighbors; a click on the map leaves the camera alone.
function selectNode(id, { fly = true } = {}) {
  tourStep = -1;
  ensureShown([id]);
  map.setFocus(null);
  map.select(id);
  // The map zooms in to the declaration's code; its edges to callers and
  // callees stay lit while it is selected.
  if (fly) map.showCode(id);
  showNode(id);
  record("node=" + byId[id].key);
}

function showTheme(themeId) {
  const t = themeById[themeId];
  tourStep = -1;
  const ids = (t.nodes || []).map(k => idOf[k]).filter(Boolean);
  ensureShown(ids);
  map.select(null);
  map.setFocus({ ids, color: t.color });
  map.showIds(ids);
  setPanel(`
    <span class="back" data-home>← Overview</span>
    <h2><span class="chip" style="background:${t.color}"></span>${esc(t.title)}</h2>
    <div class="prose">${md(t.summary)}</div>
    <h3>Declarations</h3>
    ${nodeList(t.nodes || [])}
    ${fileList("Files", t.files)}`);
  record("theme=" + themeId);
}

let tourStep = -1;

function showStep(i) {
  const steps = NOTES.tour;
  if (i < 0 || i >= steps.length) return;
  tourStep = i;
  const s = steps[i];
  const t = themeById[s.theme];
  const ids = (s.nodes || []).map(k => idOf[k]).filter(Boolean);
  ensureShown(ids);
  map.select(null);
  if (ids.length) {
    map.setFocus({ ids, color: t ? t.color : cssVar("--note-line") });
    map.showIds(ids);
  } else {
    map.setFocus(null);
    map.fit();
  }
  setPanel(`
    <span class="back" data-home>← Overview</span>
    <div class="tour-nav">
      <span class="count">Step ${i + 1} of ${steps.length}${t ? ` · <span class="chip" style="background:${t.color}"></span>${esc(t.title)}` : ""}</span>
      <button data-step="${i - 1}" ${i === 0 ? "disabled" : ""}>← Back</button>
      <button class="primary" data-step="${i + 1}" ${i === steps.length - 1 ? "disabled" : ""}>Next →</button>
    </div>
    <h2>${esc(s.title)}</h2>
    <div class="prose">${md(s.body)}</div>
    ${(s.nodes || []).length ? `<h3>On the map</h3>${nodeList(s.nodes)}` : ""}
    ${fileList("Files", s.files, !(s.nodes || []).length)}`, !(s.nodes || []).length && (s.files || []).length > 0);
  record("step=" + (i + 1));
}

function home({ fly = true } = {}) {
  tourStep = -1;
  map.select(null);
  map.setFocus(null);
  if (fly) map.fit();
  showSummary();
  record("");
}

// selectPackage shows one package: the map flies to it and the panel lists
// what changed in it.
function selectPackage(pkg) {
  tourStep = -1;
  const ns = nodes.filter(n => n.package === pkg && (testsToggle.checked || !n.isTest));
  if (!ns.length) return home();
  map.select(null);
  map.setFocus({ pkg });
  map.showPackage(pkg);
  const list = group => linkList(group.map(n => [n.id, `<span class="name">${badge(n)} ${kindTag(n)} ${esc(n.name)}</span>`]));
  const changed = ns.filter(isChange);
  const users = ns.filter(n => n.status === "caller");
  const starts = ns.filter(n => n.status === "entry");
  const dir = ns[0].file.includes("/") ? ns[0].file.slice(0, ns[0].file.lastIndexOf("/")) : ".";
  const files = Object.keys(STATS).filter(f => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".") === dir).sort();
  const added = files.reduce((n, f) => n + STATS[f].added, 0), deleted = files.reduce((n, f) => n + STATS[f].deleted, 0);
  setPanel(`
    <span class="back" data-home>← Overview</span>
    <h2>${esc(shortPkg(pkg))}</h2>
    <div class="loc">${esc(pkg)}</div>
    <p>${files.length} changed file${files.length === 1 ? "" : "s"} · <span class="add-count">+${added}</span> <span class="del-count">−${deleted}</span></p>
    ${starts.length ? `<h3>Entry points</h3>${list(starts)}` : ""}
    ${changed.length ? `<h3>Changed here</h3>${list(changed)}` : ""}
    ${users.length ? `<h3>Uses a change</h3><p class="empty">Unchanged code in this package that uses a change.</p>${list(users)}` : ""}
    ${fileList("Files", files)}`);
  record("pkg=" + pkg);
}

// Each view has a URL hash (#step=N, #theme=ID, #node=KEY, #pkg=PATH, or none
// for the overview), so the browser's back and forward buttons move between
// views and a link can open one.
let restoring = false;

function record(view) {
  if (restoring) return;
  const eq = view.indexOf("=");
  const hash = view ? "#" + view.slice(0, eq + 1) + encodeURIComponent(view.slice(eq + 1)) : "";
  if (hash === location.hash) return;
  history.pushState(null, "", hash || location.pathname + location.search);
}

function route() {
  const view = decodeURIComponent(location.hash.slice(1));
  const [kind, value] = [view.slice(0, view.indexOf("=")), view.slice(view.indexOf("=") + 1)];
  restoring = true;
  try {
    if (kind === "step" && NOTES.tour[+value - 1]) showStep(+value - 1);
    else if (kind === "theme" && themeById[value]) showTheme(value);
    else if (kind === "node" && idOf[value]) selectNode(idOf[value]);
    else if (kind === "pkg" && nodes.some(n => n.package === value)) selectPackage(value);
    else if (kind === "thread" && comments.threads.some(t => t.id === value)) showThread(value, { fly: true });
    else if (kind === "def" && DEFS[value]) showDef(value);
    else home();
  } finally {
    restoring = false;
  }
}

window.addEventListener("popstate", route);

function showSummary() {
  const changes = group => linkList(group.filter(isChange).map(n => [n.id,
    `<span class="name">${badge(n)} ${kindTag(n)} ${esc(n.name)}</span>` +
    (n.exported ? ` <span class="badge exported">exported</span>` : "") +
    (n.isTest ? "" : ` <span class="loc">${n.callers - testUsers(n.id)} code · ${testUsers(n.id)} tests</span>`)]));
  const themes = NOTES.themes.map(t => `<li data-theme="${esc(t.id)}">
      <div><span class="chip" style="background:${t.color}"></span><span class="title">${esc(t.title)}</span>
      <span class="loc">${(t.nodes || []).length} declarations</span></div>
      <div class="sum">${md(t.summary.split(/\n\s*\n/)[0])}</div></li>`).join("");

  setPanel(`
    ${NOTES.summary ? `<div class="prose">${md(NOTES.summary)}</div>` : ""}
    ${NOTES.tour.length ? `<div class="tour-nav"><button class="primary" data-step="0">Start the tour (${NOTES.tour.length} steps) →</button></div>` : ""}
    ${comments.on && comments.threads.length ? `<h3>Questions</h3><div class="questions" data-for="">${threadList(comments.threads)}</div>` : ""}
    ${themes ? `<h3>Themes</h3><ul class="links themes">${themes}</ul>` : ""}
    ${entries.length ? `<h3>Entry points · start here <button class="mini" data-entries>Show on map</button></h3>
    <p class="empty">Where execution starts and reaches the changes, most changes first.</p>
    <ul class="links">${entryGroups.map(group => {
      const row = ({ n, reach }, more) => `<span class="name">${entryPill(n)} ${kindTag(n)} ${esc(n.name)}</span>` +
        ` <span class="loc">${n.entry.kind === "http" && n.entry.routes ? esc(n.entry.routes[0]) + " · " : ""}reaches ${reach} change${reach === 1 ? "" : "s"}${more}</span>`;
      const [first, ...rest] = group;
      if (!rest.length) return `<li data-id="${esc(first.n.id)}">${row(first, "")}</li>`;
      return `<li class="group"><div data-id="${esc(first.n.id)}">${row(first, "")}</div>
        <details><summary>${rest.length} more ${first.n.entry.kind === "http" ? "routes" : "entry points"} that reach the same changes</summary>
        <ul class="links">${rest.map(x => `<li data-id="${esc(x.n.id)}">${row(x, "")}</li>`).join("")}</ul></details></li>`;
    }).join("")}</ul>` : ""}
    <h3>Changed code</h3>
    ${changes(code)}
    ${tests.some(isChange) ? `<h3>Changed tests</h3>${changes(tests)}` : ""}
    ${fileList("Other changed files", DATA.otherFiles)}
    ${fileList("Deleted files", DATA.deleted)}`);
}

// ---------- comments ----------

// When `map-pr serve` serves the page, a reader can drop questions anywhere on
// the map and Claude answers them with `map-pr reply`. The threads live in
// comments.json next to the page. Opened as a file, the page has no comments.
const comments = { on: false, threads: [], sig: "" };
let commentMode = false;
let openThread = null;
const commentBtn = document.getElementById("comment-btn");

const threadState = t => t.resolved ? "resolved" : t.messages[t.messages.length - 1].author === "claude" ? "answered" : "open";
const threadsAt = key => comments.threads.filter(t => t.anchor.node === key);
const when = at => new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

async function api(path, body) {
  const res = await fetch(path, body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : { cache: "no-store" });
  if (!res.ok) throw new Error((await res.text()).trim() || res.statusText);
  return res.json();
}

// apiAnchor turns the map's anchor (node IDs) into a stored one (node keys,
// which stay the same when the map is built again).
function apiAnchor(a) {
  if (a.node) return { node: byId[a.node].key, line: a.line || 0 };
  if (a.pkg) return { package: a.pkg };
  return { x: a.x, y: a.y };
}

function anchorLabel(a) {
  if (a.node) {
    const n = byId[idOf[a.node]];
    if (!n) return `<span class="loc">${esc(a.node)} (not on this map)</span>`;
    return `<span class="name" data-goto="${esc(n.id)}">${kindTag(n)} ${esc(n.name)}</span>` +
      ` <span class="loc">${esc(n.file)}${a.line ? ":" + a.line : ""}</span>`;
  }
  if (a.package) return `<span class="name">package ${esc(shortPkg(a.package))}</span>`;
  return `<span class="name">a point on the map</span>`;
}

// excerpt shows the lines around an anchored line, or the start of the declaration.
function excerpt(a) {
  const n = a.node && byId[idOf[a.node]];
  if (!n) return "";
  const lines = n.source.split("\n");
  const at = a.line ? a.line - n.line : 0;
  const from = Math.max(0, at - 3), to = Math.min(lines.length, a.line ? at + 4 : 8);
  return `<pre class="excerpt">` + lines.slice(from, to).map((text, i) => {
    const no = n.line + from + i;
    return `<span class="ln ${a.line === no ? "hl" : ""}"><span class="no">${no}</span>${esc(text)}</span>`;
  }).join("") + `</pre>`;
}

function threadList(ts) {
  if (!ts.length) return `<p class="empty">No questions yet.</p>`;
  return `<ul class="links">${ts.map(t => {
    const first = t.messages[0].body;
    return `<li data-thread="${esc(t.id)}"><span class="state ${threadState(t)}">${threadState(t)}</span> ` +
      `${esc(first.length > 90 ? first.slice(0, 89) + "…" : first)}<div class="loc">${t.anchor.node ? esc(t.anchor.node.split(":").pop()) + (t.anchor.line ? ":" + t.anchor.line : "") : t.anchor.package ? esc(shortPkg(t.anchor.package)) : "map"} · ${t.messages.length} message${t.messages.length > 1 ? "s" : ""}</div></li>`;
  }).join("")}</ul>`;
}

function messagesHTML(t) {
  const state = threadState(t);
  return t.messages.map(m => `<div class="msg ${m.author === "claude" ? "claude" : "you"}">
      <div class="who">${m.author === "claude" ? "Claude" : "You"} <span>${when(m.at)}</span></div>
      <div class="prose">${md(m.body)}</div></div>`).join("") +
    (state === "open" ? `<p class="waiting">Waiting for Claude. Answers show here when they come.</p>` : "");
}

function setCommentMode(on) {
  commentMode = on;
  map.setCommentMode(on);
  commentBtn.classList.toggle("on", on);
  document.getElementById("stage").classList.toggle("commenting", on);
}

// newComment opens a box to write a question at an anchor from the map.
function newComment(anchor) {
  const a = apiAnchor(anchor);
  tourStep = -1;
  if (anchor.node) map.select(anchor.node);
  setPanel(`
    <span class="back" data-home>← Overview</span>
    <h2>New question</h2>
    <div class="anchor">${anchorLabel(a)}</div>
    ${excerpt(a)}
    <textarea id="compose" rows="5" placeholder="Ask about this code. Claude gets it in the session that serves this map."></textarea>
    <div class="tour-nav"><span class="count">⌘↵ to send</span><button data-cancel>Cancel</button><button class="primary" data-send>Send</button></div>
    <p class="error" hidden></p>`);
  const box = panel.querySelector("#compose");
  box.focus();
  const send = async () => {
    if (!box.value.trim()) return;
    try {
      const t = await api("api/threads", { anchor: a, body: box.value });
      await loadThreads(true);
      showThread(t.id);
    } catch (err) {
      showError(err);
    }
  };
  panel.querySelector("[data-send]").onclick = send;
  panel.querySelector("[data-cancel]").onclick = () => anchor.node ? selectNode(anchor.node, { fly: false }) : home({ fly: false });
  box.onkeydown = e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); };
}

function showError(err) {
  const p = panel.querySelector(".error");
  if (p) { p.textContent = String(err.message || err); p.hidden = false; }
}

// showThread shows a question with its answers and a box to reply.
function showThread(id, { fly = false } = {}) {
  const t = comments.threads.find(t => t.id === id);
  if (!t) return;
  tourStep = -1;
  openThread = id;
  map.setActivePin(id);
  const n = t.anchor.node && byId[idOf[t.anchor.node]];
  map.select(n ? n.id : null);
  if (fly) map.showPin(id);
  setPanel(`
    <span class="back" data-home>← Overview</span>
    <h2>Question</h2>
    <div class="anchor">${anchorLabel(t.anchor)}</div>
    ${excerpt(t.anchor)}
    <div class="thread">${messagesHTML(t)}</div>
    <textarea id="compose" rows="3" placeholder="Reply"></textarea>
    <div class="tour-nav"><span class="count">⌘↵ to send</span>
      <button data-resolve>${t.resolved ? "Reopen" : "Resolve"}</button><button class="primary" data-send>Reply</button></div>
    <p class="error" hidden></p>`);
  const box = panel.querySelector("#compose");
  const send = async () => {
    if (!box.value.trim()) return;
    try {
      await api(`api/threads/${id}/messages`, { body: box.value });
      box.value = "";
      await loadThreads(true);
    } catch (err) {
      showError(err);
    }
  };
  panel.querySelector("[data-send]").onclick = send;
  box.onkeydown = e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); };
  panel.querySelector("[data-resolve]").onclick = async () => {
    try {
      await api(`api/threads/${id}/resolve`, { resolved: !comments.threads.find(t => t.id === id).resolved });
      await loadThreads(true);
    } catch (err) {
      showError(err);
    }
  };
  const goto = panel.querySelector("[data-goto]");
  if (goto) goto.onclick = () => selectNode(goto.dataset.goto);
  record("thread=" + id);
}

// refreshComments updates what is on screen after the threads change, but
// leaves a reply being written alone.
function refreshComments() {
  map.setPins(comments.threads.map(t => ({
    id: t.id, node: t.anchor.node ? idOf[t.anchor.node] || "missing" : null, line: t.anchor.line || 0,
    pkg: t.anchor.package || null, x: t.anchor.x || 0, y: t.anchor.y || 0,
    state: threadState(t), count: t.messages.length,
  })));
  const thread = panel.querySelector(".thread");
  const t = openThread && comments.threads.find(t => t.id === openThread);
  if (thread && t) {
    thread.innerHTML = messagesHTML(t);
    panel.querySelector("[data-resolve]").textContent = t.resolved ? "Reopen" : "Resolve";
  }
  for (const q of panel.querySelectorAll(".questions")) {
    q.innerHTML = threadList(q.dataset.for ? threadsAt(q.dataset.for) : comments.threads);
    for (const li of q.querySelectorAll("li[data-thread]")) li.onclick = () => showThread(li.dataset.thread, { fly: true });
  }
}

async function loadThreads(force = false) {
  const ts = await api("api/threads");
  const sig = JSON.stringify(ts);
  if (!force && sig === comments.sig) return;
  comments.sig = sig;
  comments.threads = ts;
  refreshComments();
}

async function startComments() {
  if (!location.protocol.startsWith("http")) return;
  try {
    await loadThreads(true);
  } catch {
    return; // a plain file server: no comments API
  }
  comments.on = true;
  commentBtn.hidden = false;
  commentBtn.onclick = () => setCommentMode(!commentMode);
  route(); // show the comment parts of the current view, or open a #thread= link
  setInterval(() => { if (!document.hidden) loadThreads().catch(() => {}); }, 2500);
}

// ---------- controls ----------

document.addEventListener("keydown", evt => {
  if (evt.target.closest("input, textarea") || evt.metaKey || evt.ctrlKey) return;
  if (evt.key === "ArrowRight" && NOTES.tour.length) showStep(tourStep + 1);
  if (evt.key === "ArrowLeft" && tourStep > 0) showStep(tourStep - 1);
  if (evt.key === "Escape") { if (commentMode) setCommentMode(false); else home(); }
  if ((evt.key === "c" || evt.key === "C") && comments.on) setCommentMode(!commentMode);
  if (evt.key === "+" || evt.key === "=") map.zoomBy(1.6);
  if (evt.key === "-") map.zoomBy(1 / 1.6);
  if (evt.key === "0") map.fit();
});

for (const b of document.querySelectorAll("[data-level]")) b.onclick = () => map.goLevel(b.dataset.level);
document.querySelector("[data-zoom=in]").onclick = () => map.zoomBy(1.6);
document.querySelector("[data-zoom=out]").onclick = () => map.zoomBy(1 / 1.6);
document.querySelector("[data-zoom=fit]").onclick = () => map.fit();

testsToggle.onchange = () => {
  map.setData(mapData(), true);
  map.fit();
};

const split = document.getElementById("split");
split.addEventListener("pointerdown", evt => {
  split.setPointerCapture(evt.pointerId);
  split.classList.add("dragging");
  const move = e => {
    panel.style.width = Math.max(320, Math.min(window.innerWidth - 200, window.innerWidth - e.clientX)) + "px";
  };
  const up = () => {
    split.classList.remove("dragging");
    split.removeEventListener("pointermove", move);
    split.removeEventListener("pointerup", up);
  };
  split.addEventListener("pointermove", move);
  split.addEventListener("pointerup", up);
});

if (!nodes.length) {
  document.getElementById("stage").insertAdjacentHTML("beforeend",
    `<p class="empty" style="position:absolute;inset:24px">No changed Go declarations found.</p>`);
}
map.setData(mapData());
map.fit(false);
route();
startComments();

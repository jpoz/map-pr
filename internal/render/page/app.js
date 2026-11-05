"use strict";
// The app joins the zoomable map (engine.js) to the side panel: the summary,
// themes, code paths, declaration details and browser history.
const NOTES = window.MAPR_NOTES || {};
NOTES.themes = NOTES.themes || [];
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
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const kindOf = n => n.kind || "func";
const code = nodes.filter(n => !n.isTest);
const tests = nodes.filter(n => n.isTest);
const noteOf = n => NOTES.nodes[n.key];
const statusLabel = n => ({ caller: "uses a change", entry: "entry point" })[n.status] || n.status;

// callTips gives each line that calls a change a hover text that names what
// it calls, so a call line does not read as a changed line.
function callTips(uses) {
  const to = new Map();
  for (const e of uses) for (const l of e.lines || []) {
    const names = to.get(l) || [];
    const d = byId[e.to];
    if (d && !names.includes(d)) names.push(d);
    to.set(l, names);
  }
  return new Map([...to].map(([l, ds]) => [l, "Calls " + ds.map(d => `${d.name} (${statusLabel(d)})`).join(", ") + ". This line is not changed."]));
}

// ---------- links to the PR ----------

// A declaration in a file the PR changes links to that file's diff in the
// PR, at its line when the diff shows the line. Any other file links to its
// source at the PR's head commit. A map with no GitHub PR link has no links.
const PR = (NOTES.url || "").match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/pull\/\d+/);
const DIFF_IDS = window.MAPR_LINKS || {};
const diffLines = {};
// inDiff says whether the diff of file shows line: it is in the new side of one of its hunks.
function inDiff(file, line) {
  diffLines[file] ??= [...(PATCHES[file] || "").matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)]
    .map(m => [+m[1], +m[1] + (m[2] === undefined ? 1 : +m[2]) - 1]);
  return diffLines[file].some(([a, b]) => line >= a && line <= b);
}
function fileURL(file, line) {
  if (!PR) return null;
  const id = DIFF_IDS[file];
  if (id) return `${PR[0]}/files#${id}` + (line && inDiff(file, line) ? "R" + line : "");
  return `${PR[1]}/blob/${encodeURIComponent(DATA.head)}/${file.split("/").map(encodeURIComponent).join("/")}` + (line ? "#L" + line : "");
}
// fileLink is file:line as a link to it in the PR, or as text when there is none.
function fileLink(file, line) {
  const text = esc(file) + (line ? ":" + line : ""), url = fileURL(file, line);
  return url ? `<a class="file-link" href="${esc(url)}" target="_blank" rel="noopener" title="Open in the pull request">${text}</a>` : text;
}

// ---------- entry points ----------

// Entry points are where execution starts: HTTP handlers, main, functions
// started with go, top-level module code, and code with no callers. They are a good place to start
// a review: each one shows how the changes are reached.
const entryTag = e => ({ http: "HTTP", goroutine: "go", main: "main", module: "top level", root: "no callers" })[e.kind] || "entry";
function entryText(e) {
  switch (e.kind) {
    case "http": return e.routes && e.routes.length ? e.routes.join(", ") : "HTTP handler";
    case "goroutine": return "started with a go statement";
    case "main": return "the program's main()";
    case "module": return "top-level code of a module, run when the module is loaded";
    default: return "no callers outside tests: called through an interface, by reflection, or not used yet";
  }
}
const entryPill = n => n.entry ? `<span class="entry-pill ${n.entry.kind}">${entryTag(n.entry)}</span>` : "";
// reach follows edges from id, up to the users or down to what it uses.
function reach(id, up) {
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
const changesReached = id => [...reach(id, false).keys()].filter(x => isChange(byId[x]) && kindOf(byId[x]) !== "type").sort();
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
  const h1 = document.getElementById("title");
  h1.textContent = NOTES.title;
  // The title links to the PR. The notes check allows only http(s) links.
  if (/^https?:\/\//.test(NOTES.url || "")) {
    const a = document.createElement("a");
    a.href = NOTES.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = NOTES.title;
    h1.replaceChildren(a);
  }
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
  onNode: (id, fly = false) => selectNode(id, { fly }),
  // A name in a card's code that refers to another declaration goes to it:
  // its card when it is on the map, else its definition in the panel.
  refsOf: id => (USES[id] || []).flatMap(u => declOf(u.to) ? [{ to: u.to, name: identName(declOf(u.to)), lines: u.lines }] : []),
  onRef: to => refTo(to),
  onPackage: pkg => selectPackage(pkg),
  onFlow: i => showPath(i),
  // The file and line in a card's header open the declaration in the PR.
  fileURL: n => fileURL(n.file, n.line),
  onFile: url => window.open(url, "_blank", "noopener"),
  onBackground: () => { if (location.hash) home({ fly: false }); },
  onPin: id => { goToThread(id); focusThread(id); },
  onDrop: anchor => { setCommentMode(false); attachTo(anchor); },
  // A click on a line number in a card's code attaches that line to a chat message.
  onLine: (id, line) => attachTo({ node: id, line }),
  onLevel: level => {
    for (const b of document.querySelectorAll("[data-level]")) b.classList.toggle("on", b.dataset.level === level);
  },
  onPort: (p, now) => showPort(p, now),
  onTip: t => {
    if (!t) { tip.hidden = true; return; }
    tip.innerHTML = `<b>${esc(t.title)}</b><span>${esc(t.sub)}</span>`;
    tip.hidden = false;
    tip.style.transform = `translate(${t.x + 14}px, ${t.y + 14}px)`;
  },
});

// ---------- callers at an arrow ----------

// showPort lists the declarations whose edges end at the arrow under the
// pointer, so a reader can go back to any of them. The list stays open while
// the pointer moves onto it, and closes a moment after it leaves both.
const portMenu = document.getElementById("ports");
let portTimer = 0;
function showPort(p, now = false) {
  clearTimeout(portTimer);
  if (!p) {
    if (now) portMenu.hidden = true;
    else portTimer = setTimeout(() => { if (!portMenu.matches(":hover")) portMenu.hidden = true; }, 300);
    return;
  }
  const to = declOf(p.to);
  const from = p.from.filter(f => byId[f.id]).sort((a, b) => byId[a.id].name.localeCompare(byId[b.id].name));
  portMenu.innerHTML = `<div class="head">${from.length} ${from.length === 1 ? "use" : "uses"} of <b>${esc(to ? to.name : "")}</b></div>` +
    `<ul>${from.map(f => {
      const n = byId[f.id];
      const via = f.via && f.via.length ? ` · via ${esc(f.via.join(" → "))}` : "";
      return `<li data-id="${esc(f.id)}"><span class="name">${badge(n)} ${kindTag(n)} ${esc(n.name)}</span>` +
        `<span class="loc">${esc(n.file)}${f.line ? ":" + f.line : ""}${via}</span></li>`;
    }).join("")}</ul>`;
  portMenu.hidden = false;
  const box = portMenu.parentElement.getBoundingClientRect();
  const x = Math.min(p.x + 12, box.width - portMenu.offsetWidth - 8), y = Math.min(p.y + 12, box.height - portMenu.offsetHeight - 8);
  portMenu.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
}
portMenu.addEventListener("mouseleave", () => { portTimer = setTimeout(() => { portMenu.hidden = true; }, 300); });
portMenu.addEventListener("mouseenter", () => clearTimeout(portTimer));
portMenu.addEventListener("click", e => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  portMenu.hidden = true;
  selectNode(li.dataset.id);
});

function mapData() {
  const shown = nodes.filter(n => testsToggle.checked || !n.isTest).map(n => ({
    ...n,
    tests: testsToggle.checked ? 0 : testUsers(n.id),
    hasNote: !!noteOf(n),
  }));
  return { nodes: shown, edges, stats: STATS, flows: codePaths };
}

// ---------- panel ----------

// codeBlock shows a declaration's source with the lines the change deleted
// before the line they came before. A deleted row has no .no or .code cell,
// so those cells stay one per source line. highlight marks lines such as
// calls. With fold, long runs of unchanged lines
// hide behind a row that shows them on a click, as a PR view does; the
// hidden rows stay in the block, so the cells still match source lines.
function codeBlock(n, highlight = [], fold = true, tips = new Map()) {
  const changed = new Set(n.changed || []);
  const hl = new Set(highlight);
  const removed = n.removed || {};
  const del = no => (removed[no] || []).map(text =>
    `<span class="ln del"><span class="gone">−</span><span class="old">${esc(text)}</span></span>`).join("");
  const lines = n.source.split("\n");
  const runs = fold ? foldPlan(n, keepLines(n, highlight)) : [];
  const runOf = no => runs.findIndex(([a, b]) => no >= a && no <= b);
  return `<pre class="src" data-node="${esc(n.id)}">` + lines.map((text, i) => {
    const no = n.line + i, r = runOf(no);
    const cls = [changed.has(no) && "chg", hl.has(no) && "hl", r >= 0 && "folded"].filter(Boolean).join(" ");
    const head = r >= 0 && runs[r][0] === no
      ? `<span class="ln fold" data-fold="${r}">⋯ ${runs[r][1] - no + 1} unchanged lines (${no}–${runs[r][1]}) · click to show</span>` : "";
    const tip = tips.has(no) ? ` title="${esc(tips.get(no))}"` : "";
    return head + del(no) + `<span class="ln ${cls}"${tip}${r >= 0 ? ` data-in="${r}"` : ""}><span class="no">${no}</span><span class="code">${esc(text)}</span></span>`;
  }).join("") + del(n.line + lines.length) + "</pre>";
}

// srcHead is the header on top of a source block: the declaration's name and
// place. It sticks to the top of the panel, so a long function keeps its
// name in view.
const srcHead = (d, extra = "") =>
  `<div class="src-path"><span class="kind">${esc(kindOf(d))}</span> <b>${esc(d.name)}</b> · ${fileLink(d.file, d.line)}${extra}</div>`;

const badge = n => `<span class="badge ${n.status}">${statusLabel(n)}</span>`;
const kindTag = n => `<span class="kind">${kindOf(n)}</span>`;

function linkList(items) {
  if (!items.length) return `<p class="empty">None on the map.</p>`;
  return `<ul class="links">${items.map(([id, text]) =>
    `<li data-id="${esc(id)}">${text}</li>`).join("")}</ul>`;
}

// nodeList shows nodes with their notes, for theme panels.
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
function fileList(title, files) {
  if (!files || !files.length) return "";
  return `<h3>${title}</h3>` + files.map(f => {
    const patch = PATCHES[f];
    const st = STATS[f];
    const counts = st ? ` <span class="add-count">+${st.added}</span> <span class="del-count">−${st.deleted}</span>` : "";
    const label = `${esc(f)}${deletedFiles.has(f) ? ` <span class="badge deleted">deleted</span>` : ""}${counts}`;
    if (!patch) return `<div class="file"><div class="file-name">${label}</div></div>`;
    return `<details class="file" data-file="${esc(f)}"><summary class="file-name">${label}</summary>` +
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
// refTo follows a name in code.
const refTo = id => openDecl(id);

// showDef shows the definition of code the PR does not change, with the
// declarations on this map that use it.
function showDef(id) {
  const d = DEFS[id];
  if (!d) return;
  leavePath();
  const users = usersOfDecl(id).filter(x => declOf(x));
  const total = d.endLine - d.line + 1, shown = d.source.split("\n").length;
  setPanel(`
    <span class="back" data-back>← Back</span>
    <h2><span class="kind">${esc(d.kind)}</span> ${esc(d.name)}</h2>
    <span class="badge unchanged">not changed in this PR</span>
    <div class="loc">${fileLink(d.file, d.line)}</div>
    <h3>Used here by</h3>
    ${linkList(users.map(x => [x, `<span class="name">${byId[x] ? badge(byId[x]) + " " : ""}<span class="kind">${esc(declOf(x).kind)}</span> ${esc(declOf(x).name)}</span> <span class="loc">${esc(declOf(x).file)}</span>`]))}
    <h3>Definition</h3>
    ${srcHead(d)}
    ${codeBlock(d, [], false)}
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
  const fold = e.target.closest(".ln.fold");
  if (fold) {
    const pre = fold.closest("pre");
    for (const ln of pre.querySelectorAll(`.ln[data-in="${fold.dataset.fold}"]`)) ln.classList.remove("folded");
    fold.remove();
    return;
  }
  const ref = e.target.closest(".ref");
  if (ref) { e.preventDefault(); refTo(ref.dataset.ref); }
});

// setPanel fills the side panel.
function setPanel(html) {
  map.setActivePin(null);
  panel.innerHTML = html;
  panel.scrollTop = 0;
  for (const li of panel.querySelectorAll("li[data-id], li.group > div[data-id]")) li.onclick = () => openDecl(li.dataset.id);
  for (const b of panel.querySelectorAll("[data-back]")) b.onclick = () => history.length > 1 ? history.back() : home();
  for (const pre of panel.querySelectorAll("pre.src[data-node]")) linkRefs(pre);
  for (const li of panel.querySelectorAll("li[data-theme]")) li.onclick = () => showTheme(li.dataset.theme);
  for (const li of panel.querySelectorAll("li[data-pkg]")) li.onclick = () => selectPackage(li.dataset.pkg);
  for (const b of panel.querySelectorAll("[data-home]")) b.onclick = () => home();
  for (const b of panel.querySelectorAll("[data-code]")) b.onclick = () => map.showCode(b.dataset.code);
  for (const b of panel.querySelectorAll("[data-path]")) b.onclick = () => showPath(+b.dataset.path);
  for (const li of panel.querySelectorAll("li[data-thread]")) li.onclick = () => focusThread(li.dataset.thread);
  for (const b of panel.querySelectorAll("[data-ask]")) b.onclick = () => attachTo({ node: b.dataset.ask, line: 0 });
  if (comments.on) {
    for (const pre of panel.querySelectorAll("pre.src[data-node]")) {
      pre.classList.add("askable");
      pre.querySelectorAll(".no").forEach(no => {
        no.title = "Ask Claude about this line";
        no.onclick = () => attachTo({ node: pre.dataset.node, line: +no.textContent });
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
  const from = [...reach(id, true)].filter(([x]) => byId[x].entry).sort((a, b) => a[1] - b[1]);
  const reachedFrom = !n.entry || n.status !== "entry" ? `<h3>Reached from</h3>` + (from.length
    ? linkList(from.slice(0, 12).map(([x, hops]) => [x, `<span class="name">${entryPill(byId[x])} ${esc(byId[x].name)}</span>` +
      ` <span class="loc">${esc(byId[x].entry.kind === "http" && byId[x].entry.routes ? byId[x].entry.routes[0] : entryText(byId[x].entry))} · ${hops} call${hops === 1 ? "" : "s"} up</span>`])) +
      (from.length > 12 ? `<p class="empty">${from.length - 12} more.</p>` : "")
    : `<p class="empty">No entry point found within reach on the map.</p>`) : "";

  setPanel(`
    <span class="back" data-home>← Overview</span>
    <h2>${kindTag(n)} ${esc(n.name)}</h2>
    ${badge(n)} ${entryPill(n)} ${exported}
    <div class="loc">${esc(n.package)}<br>${fileLink(n.file, n.line)}</div>
    ${note ? `<div class="note">${md(note)}</div>` : ""}
    ${themes ? `<h3>Part of</h3><ul class="links themes">${themes}</ul>` : ""}
    ${entryInfo}
    ${pathsThrough(id).length ? `<h3>Code paths through here</h3><ul class="links">${pathsThrough(id).map(pathRow).join("")}</ul>` : ""}
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
    ${srcHead(n, comments.on ? ` <span class="hint">· click a line number to ask Claude about it</span>` : "")}
    ${codeBlock(n, uses.flatMap(e => e.lines || []), true, callTips(uses))}`);
}

// selectNode shows a declaration. From the panel or a link the map flies to
// it with its neighbors; a click on the map leaves the camera alone.
function selectNode(id, { fly = true } = {}) {
  leavePath();
  ensureShown([id]);
  map.setFocus(null);
  map.select(id);
  // The map zooms in to the declaration's code; its edges to callers and
  // callees stay lit while it is selected.
  if (fly) map.showCode(id);
  showNode(id);
  record("node=" + byId[id].key);
}

// ---------- code paths ----------

// A code path is one chain of calls from an entry point down to a change
// that calls nothing more on the map. The map draws each path as a colored
// line through its declarations, like a transit line: where lines share a
// declaration, the paths meet. A few paths are picked so that together they
// reach every change an entry point reaches, and start at every entry point.
const PATH_COLORS = ["#e03131", "#1971c2", "#2f9e44", "#f08c00", "#9c36b5", "#0c8599", "#d6336c", "#5c940d", "#e8590c", "#3b5bdb", "#862e9c", "#495057"];
const MAX_PATHS = 12;
const isCode = n => !["const", "var", "type", "sql"].includes(kindOf(n));
const calleesOf = new Map();
for (const e of edges) {
  const t = byId[e.to];
  if (!t || t.isTest || !isCode(t) || byId[e.from].isTest) continue;
  const list = calleesOf.get(e.from) || [];
  if (!list.includes(e.to)) list.push(e.to);
  calleesOf.set(e.from, list);
}

// pathsFrom lists the chains of calls from id to each end, at most limit.
function pathsFrom(id, limit = 400) {
  const out = [], path = [id];
  (function dfs(cur) {
    const next = (calleesOf.get(cur) || []).filter(x => !path.includes(x));
    if (!next.length) { if (path.length > 1) out.push([...path]); return; }
    for (const x of next) {
      if (out.length >= limit) return;
      path.push(x);
      dfs(x);
      path.pop();
    }
  })(id);
  return out;
}

const codePaths = (() => {
  const cands = entryGroups.flatMap(g => pathsFrom(g[0].n.id));
  const covered = new Set(), started = new Set(), out = [];
  while (out.length < MAX_PATHS) {
    let best = null, bestGain = 0;
    for (const p of cands) {
      // A path from code with no callers counts half: a route or a worker
      // shows how execution really gets there.
      const weight = byId[p[0]].entry.kind === "root" ? 0.5 : 1;
      const gain = weight * (2 * p.filter(x => isChange(byId[x]) && !covered.has(x)).length + (started.has(p[0]) ? 0 : 1));
      if (gain > bestGain || gain > 0 && gain === bestGain && p.length < best.length) { best = p; bestGain = gain; }
    }
    if (!best) break;
    for (const x of best) covered.add(x);
    started.add(best[0]);
    out.push(best);
  }
  return out.map((ids, i) => {
    const start = byId[ids[0]], end = byId[ids[ids.length - 1]];
    // Top-level code has no name of its own, so its file names it.
    const from = start.entry && start.entry.kind === "http" && start.entry.routes ? start.entry.routes[0]
      : start.entry && start.entry.kind === "module" ? start.file.split("/").pop() : start.name;
    return { id: i, ids, color: PATH_COLORS[i % PATH_COLORS.length], label: `${from} → ${end.name}`, changes: ids.filter(x => isChange(byId[x])).length };
  });
})();
const pathsThrough = id => codePaths.filter(p => p.ids.includes(id));
const pathChip = p => `<span class="path-chip" style="background:${p.color}">${p.id + 1}</span>`;

// pathView is the open path and its current station, or null.
let pathView = null;

// callFrom says how station a calls station b: the lines of the call, or the
// code off the map in between.
function callFrom(a, b) {
  const es = edges.filter(e => e.from === a && e.to === b);
  const via = es.find(e => e.via);
  if (via) return `through ${via.via.length ? via.via.map(esc).join(" → ") : "a direct call"}`;
  const n = byId[a], lines = [...new Set(es.flatMap(e => e.lines || []))].sort((x, y) => x - y);
  if (!lines.length) return "";
  const src = (n.source || "").split("\n")[lines[0] - n.line];
  return `line ${lines.join(", ")}` + (src ? `: <code>${esc(src.trim())}</code>` : "");
}

// showPath shows one code path: the map lights its line, and the panel lists
// its stations in call order. With at, the map zooms in to that station's
// code, at the line that calls the next one.
function showPath(i, at = null) {
  const p = codePaths[i];
  if (!p) return home();
  at = at === null ? null : clamp(at, 0, p.ids.length - 1);
  pathView = { i, at };
  map.setFlow(i);
  map.setFocus({ ids: p.ids, color: p.color });
  const cur = at === null ? null : p.ids[at];
  map.select(cur);
  const callLines = j => j < p.ids.length - 1
    ? edges.filter(e => e.from === p.ids[j] && e.to === p.ids[j + 1]).flatMap(e => e.lines || []) : [];
  if (cur) map.showCode(cur, callLines(at)[0]); else map.showIds(p.ids);

  const start = byId[p.ids[0]];
  const stations = p.ids.map((id, j) => {
    const n = byId[id], others = pathsThrough(id).filter(o => o !== p);
    const call = j < p.ids.length - 1 ? callFrom(id, p.ids[j + 1]) : "";
    return `<li data-station="${j}" class="${j === at ? "cur" : ""}${others.length ? " interchange" : ""}"><div>` +
      `<span class="name">${badge(n)} ${kindTag(n)} ${esc(n.name)}</span>` +
      `<div class="loc">${fileLink(n.file, n.line)}</div>` +
      (noteOf(n) ? `<div class="note small">${md(noteOf(n))}</div>` : "") +
      (call ? `<div class="call">calls ${esc(byId[p.ids[j + 1]].name)} at ${call}</div>` : "") +
      (others.length ? `<div class="also">Also on ${others.map(o => `<span data-path="${o.id}" title="${esc(o.label)}">${pathChip(o)}</span>`).join(" ")}</div>` : "") +
      `</div></li>`;
  }).join("");
  const here = cur && byId[cur];
  setPanel(`
    <span class="back" data-home>← Overview</span>
    <div class="path-nav">
      <span class="count">${pathChip(p)} Path ${i + 1} of ${codePaths.length} · ${at === null ? `${p.ids.length} steps` : `step ${at + 1} of ${p.ids.length}`}</span>
      <button data-path-at="${at === null ? -1 : at - 1}" ${at === null ? "disabled" : ""}>← Back</button>
      <button class="primary" data-path-at="${at === null ? 0 : at + 1}" ${at === p.ids.length - 1 ? "disabled" : ""}>${at === null ? "Start" : "Next"} →</button>
    </div>
    <h2>${esc(p.label)}</h2>
    <p class="empty">${entryPill(start)} ${start.entry ? esc(entryText(start.entry)) : ""}. Reaches ${p.changes} change${p.changes === 1 ? "" : "s"}.</p>
    <ol class="stations" style="--path:${p.color}">${stations}</ol>
    <p class="hint">← → step through the path · click a step to go to its code</p>
    ${here ? `<h3>Source <button class="mini" data-code="${esc(cur)}">Zoom to code</button></h3>
    ${srcHead(here)}
    ${codeBlock(here, callLines(at))}` : ""}`);
  for (const li of panel.querySelectorAll("li[data-station]")) li.onclick = e => { if (!e.target.closest("[data-path], a")) showPath(i, +li.dataset.station); };
  for (const b of panel.querySelectorAll("[data-path-at]")) b.onclick = () => showPath(i, +b.dataset.pathAt < 0 ? null : +b.dataset.pathAt);
  panel.querySelector("li.cur")?.scrollIntoView({ block: "nearest" });
  record("path=" + (i + 1) + (at === null ? "" : "." + (at + 1)));
}

// leavePath clears a path's light when another view opens.
function leavePath() {
  if (!pathView) return;
  pathView = null;
  map.setFlow(null);
}

function showTheme(themeId) {
  const t = themeById[themeId];
  leavePath();
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

function home({ fly = true } = {}) {
  leavePath();
  map.select(null);
  map.setFocus(null);
  if (fly) map.fit();
  showSummary();
  record("");
}

// selectPackage shows one package: the map flies to it and the panel lists
// what changed in it.
function selectPackage(pkg) {
  leavePath();
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

// Each view has a URL hash (#path=N, #theme=ID, #node=KEY, #pkg=PATH, or none
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
    if (kind === "theme" && themeById[value]) showTheme(value);
    else if (kind === "node" && idOf[value]) selectNode(idOf[value]);
    else if (kind === "pkg" && nodes.some(n => n.package === value)) selectPackage(value);
    else if (kind === "thread" && comments.threads.some(t => t.id === value)) { goToThread(value); focusThread(value); }
    else if (kind === "def" && DEFS[value]) showDef(value);
    else if (kind === "path" && codePaths[+value.split(".")[0] - 1]) {
      const [i, at] = value.split(".");
      showPath(+i - 1, at ? +at - 1 : null);
    }
    else home();
  } finally {
    restoring = false;
  }
}

window.addEventListener("popstate", route);

function showSummary() {
  const changes = group => linkList(group.filter(isChange).sort((a, b) => !!b.top - !!a.top).map(n => [n.id,
    `<span class="name">${badge(n)} ${kindTag(n)} ${n.top ? `<span class="top" title="No other change calls it: start here">★</span> ` : ""}${esc(n.name)}</span>` +
    (n.exported ? ` <span class="badge exported">exported</span>` : "") +
    (n.isTest ? "" : ` <span class="loc">${n.callers - testUsers(n.id)} code · ${testUsers(n.id)} tests</span>`)]));
  // The top functions (★) are where to start: changed code that no other
  // change calls. The ones that reach the most changes come first.
  const tops = code.filter(n => n.top)
    .map(n => ({ n, reach: changesReached(n.id).filter(id => id !== n.id).length }))
    .sort((a, b) => b.reach - a.reach || a.n.file.localeCompare(b.n.file) || a.n.line - b.n.line);
  const startHere = tops.length ? `<h3><span class="top">★</span> Start here</h3>
    <p class="empty">Changed code that no other change calls. Click one to zoom in to its code.</p>
    ${linkList(tops.map(({ n, reach }) => [n.id, `<span class="name">${badge(n)} ${kindTag(n)} ${esc(n.name)}</span>` +
      ` <span class="loc">${esc(n.file)}:${n.line}${reach ? ` · reaches ${reach} more change${reach === 1 ? "" : "s"}` : ""}</span>`]))}` : "";
  const themes = NOTES.themes.map(t => `<li data-theme="${esc(t.id)}">
      <div><span class="chip" style="background:${t.color}"></span><span class="title">${esc(t.title)}</span>
      <span class="loc">${(t.nodes || []).length} declarations</span></div>
      <div class="sum">${md(t.summary.split(/\n\s*\n/)[0])}</div></li>`).join("");

  setPanel(`
    ${NOTES.summary ? `<div class="prose">${md(NOTES.summary)}</div>` : ""}
    ${codePaths.length ? `<h3>Code paths</h3>
    <p class="empty">Chains of calls from where execution starts down into the change, drawn as colored lines on the map. Where lines meet, the paths share code. Pick one to follow it step by step.</p>
    <ul class="links">${codePaths.map(pathRow).join("")}</ul>` : ""}
    ${startHere}
    ${themes ? `<h3>Themes</h3><ul class="links themes">${themes}</ul>` : ""}
    <h3>Changed code</h3>
    ${changes(code)}
    ${tests.some(isChange) ? `<h3>Changed tests</h3>${changes(tests)}` : ""}
    ${fileList("Other changed files", DATA.otherFiles)}
    ${fileList("Deleted files", DATA.deleted)}`);
}

// pathRow is a code path in a list.
const pathRow = p => `<li data-path="${p.id}"><span class="name">${pathChip(p)} ${esc(p.label)}</span>` +
  ` <span class="loc">${p.ids.length} steps · ${p.changes} change${p.changes === 1 ? "" : "s"}</span></li>`;

// ---------- comments ----------

// When `map-pr serve` serves the page, a chat with Claude runs down its left
// side. A message can carry a place on the map: a line, a declaration, a
// package or a point. Each message the reader sends is a thread in
// comments.json, and Claude answers it with `map-pr reply`. Opened as a file,
// the page has no chat.
const comments = { on: false, threads: [], sig: "" };
let commentMode = false;
const commentBtn = document.getElementById("comment-btn");

const threadState = t => t.resolved ? "resolved" : t.messages[t.messages.length - 1].author === "claude" ? "answered" : "open";
const threadsAt = key => comments.threads.filter(t => t.anchor.node === key);
const when = at => new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
// placed is true for a thread with a place on the map; a plain chat message has none.
const placed = a => !!(a.node || a.package || a.x || a.y);

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
  if (!a) return {};
  if (a.node) return { node: byId[a.node].key, line: a.line || 0 };
  if (a.pkg) return { package: a.pkg };
  return { x: a.x, y: a.y };
}

// anchorShort names an anchor in a few words: a declaration and line, a package, or a point.
const anchorShort = a => a.node ? a.node.split(":").pop() + (a.line ? ":" + a.line : "") : a.package ? "package " + shortPkg(a.package) : "a point on the map";

// lineText is the source of an anchored line, for the chip that shows it.
function lineText(a) {
  const n = a.node && byId[idOf[a.node]];
  if (!n || !a.line) return "";
  return (n.source.split("\n")[a.line - n.line] || "").trim();
}

function chipHTML(a, attrs = "") {
  const code = lineText(a);
  return `<span class="att" ${attrs} title="Go to this place on the map"><span class="where">${esc(anchorShort(a))}</span>` +
    (code ? `<code>${esc(code)}</code>` : "") + `</span>`;
}

function threadList(ts) {
  if (!ts.length) return `<p class="empty">No questions yet.</p>`;
  return `<ul class="links">${ts.map(t => {
    const first = t.messages[0].body;
    return `<li data-thread="${esc(t.id)}"><span class="state ${threadState(t)}">${threadState(t)}</span> ` +
      `${esc(first.length > 90 ? first.slice(0, 89) + "…" : first)}<div class="loc">${esc(anchorShort(t.anchor))} · ${t.messages.length} message${t.messages.length > 1 ? "s" : ""}</div></li>`;
  }).join("")}</ul>`;
}

function setCommentMode(on) {
  commentMode = on;
  map.setCommentMode(on);
  commentBtn.classList.toggle("on", on);
  document.getElementById("stage").classList.toggle("commenting", on);
}

// ---------- chat ----------

const chat = {
  el: document.getElementById("chat"), log: document.getElementById("chat-log"),
  box: document.getElementById("chat-input"), attachEl: document.getElementById("chat-attach"),
  btn: document.getElementById("chat-btn"), toast: document.getElementById("toast"),
  attach: null, seen: null, timer: 0,
};
const seenKey = "map-pr:seen:" + location.pathname;
const pageTitle = document.title;
const answersIn = t => t.messages.filter(m => m.author === "claude").length;
const unread = t => !!chat.seen && answersIn(t) > (chat.seen[t.id] || 0);
// plain is the first line of Markdown text, without its marks.
const plain = text => (text.split("\n").find(l => l.trim()) || "").replace(/[`*]/g, "").trim();
const chatOpen = () => !chat.el.hidden;

// attachTo puts a place on the map on the message being written, and opens
// the chat to write it.
function attachTo(anchor) {
  chat.attach = anchor;
  if (anchor.node) map.select(anchor.node);
  setChat(true);
  renderAttach();
  chat.box.focus();
}

function renderAttach() {
  const a = chat.attach && apiAnchor(chat.attach);
  chat.attachEl.hidden = !a;
  chat.attachEl.innerHTML = a ? chipHTML(a, "data-goto-attach") + `<button class="x" title="Remove">×</button>` : "";
  if (!a) return;
  chat.attachEl.querySelector(".x").onclick = () => { chat.attach = null; renderAttach(); chat.box.focus(); };
  chat.attachEl.querySelector("[data-goto-attach]").onclick = () => goToAnchor(a);
}

async function sendChat() {
  const body = chat.box.value;
  if (!body.trim()) return;
  chat.box.disabled = true;
  try {
    await api("api/threads", { anchor: apiAnchor(chat.attach), body });
    chat.box.value = "";
    chat.attach = null;
    renderAttach();
    await loadThreads(true);
    chat.log.scrollTop = chat.log.scrollHeight;
  } catch (err) {
    chatError(err);
  } finally {
    chat.box.disabled = false;
    chat.box.focus();
  }
}

function chatError(err) {
  const p = chat.el.querySelector(".error");
  p.textContent = String(err.message || err);
  p.hidden = false;
  setTimeout(() => { p.hidden = true; }, 6000);
}

// renderChat draws every message in time order. An answer that does not come
// right after its question quotes it.
function renderChat() {
  const items = comments.threads.flatMap(t => t.messages.map((m, i) => ({ t, m, i })))
    .sort((a, b) => a.m.at.localeCompare(b.m.at));
  const atEnd = chat.log.scrollHeight - chat.log.scrollTop - chat.log.clientHeight < 40;
  let prev = null;
  chat.log.innerHTML = items.length ? items.map(({ t, m, i }) => {
    const claude = m.author === "claude";
    const quote = claude && prev !== t.id ? `<div class="quote" data-jump="${esc(t.id)}">↪ ${esc(plain(t.messages[0].body))}</div>` : "";
    const chip = !claude && i === 0 && placed(t.anchor) ? chipHTML(t.anchor, `data-pin="${esc(t.id)}"`) : "";
    const fresh = claude && unread(t) && i >= t.messages.length - (answersIn(t) - (chat.seen[t.id] || 0)) ? " fresh" : "";
    const waiting = !claude && i === t.messages.length - 1 && threadState(t) === "open" ? `<div class="waiting">Waiting for Claude…</div>` : "";
    prev = t.id;
    return `<div class="msg ${claude ? "claude" : "you"}${fresh}" ${i === 0 ? `data-thread="${esc(t.id)}"` : ""}>
      <div class="who">${claude ? "Claude" : "You"} <span>${when(m.at)}</span></div>${quote}${chip}
      <div class="prose">${md(m.body)}</div>${waiting}</div>`;
  }).join("") : `<p class="empty">Ask Claude about this pull request. Click a line number on the map or in the panel to attach that line to your question.</p>`;
  for (const c of chat.log.querySelectorAll("[data-pin]")) c.onclick = () => goToThread(c.dataset.pin);
  for (const q of chat.log.querySelectorAll("[data-jump]")) q.onclick = () => focusThread(q.dataset.jump);
  if (atEnd) chat.log.scrollTop = chat.log.scrollHeight;
}

// goToAnchor shows a stored anchor on the map.
function goToAnchor(a) {
  const n = a.node && byId[idOf[a.node]];
  if (n) {
    selectNode(n.id, { fly: false });
    map.showCode(n.id, a.line || 0);
  } else if (a.package) selectPackage(a.package);
}

// goToThread takes the map back to the place a message is about.
function goToThread(id) {
  const t = comments.threads.find(t => t.id === id);
  if (!t) return;
  const n = t.anchor.node && byId[idOf[t.anchor.node]];
  if (n) selectNode(n.id, { fly: false });
  else if (t.anchor.package) selectPackage(t.anchor.package);
  map.setActivePin(id);
  map.showPin(id);
  record("thread=" + id);
}

// focusThread scrolls the chat to a question and marks it for a moment.
function focusThread(id) {
  setChat(true);
  const el = chat.log.querySelector(`[data-thread="${CSS.escape(id)}"]`);
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

function setChat(open) {
  chat.el.hidden = !open;
  chat.btn.classList.toggle("on", open);
  try { localStorage.setItem("map-pr:chat", open ? "open" : "closed"); } catch {}
  map.resize();
  if (open) { hideToast(); renderChat(); markSeen(); }
  refreshBadge();
}

// ---------- read state ----------
// What this viewer has read is kept in the browser as the count of Claude's
// messages seen in each thread. While the chat is open and the tab is shown,
// answers are read when they come.

function loadSeen() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(seenKey)); } catch {}
  chat.seen = saved || Object.fromEntries(comments.threads.map(t => [t.id, answersIn(t)]));
  if (!saved) saveSeen();
}
function saveSeen() {
  try { localStorage.setItem(seenKey, JSON.stringify(chat.seen)); } catch {}
}
function markSeen() {
  if (!chatOpen() || document.hidden) return;
  clearTimeout(chat.timer);
  // The "new" mark stays a moment, so the reader sees which answers came.
  chat.timer = setTimeout(() => {
    for (const t of comments.threads) chat.seen[t.id] = answersIn(t);
    saveSeen();
    for (const m of chat.log.querySelectorAll(".msg.fresh")) m.classList.remove("fresh");
    refreshBadge();
  }, 4000);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) markSeen(); });

function refreshBadge() {
  const n = comments.threads.filter(unread).length;
  const badge = chat.btn.querySelector(".badge");
  badge.hidden = !n;
  badge.textContent = n;
  document.title = n ? `(${n}) ${pageTitle}` : pageTitle;
}

function showToast(t, count) {
  chat.toast.innerHTML = `<b>${count > 1 ? `${count} new answers` : "Claude answered"}</b><span>${esc(plain(t.messages[0].body))}</span>`;
  chat.toast.hidden = false;
  clearTimeout(chat.toastTimer);
  chat.toastTimer = setTimeout(hideToast, 12000);
}
function hideToast() { chat.toast.hidden = true; }
chat.toast.onclick = () => { setChat(true); chat.log.scrollTop = chat.log.scrollHeight; };

// refreshComments updates the pins and the chat after the threads change.
function refreshComments() {
  map.setPins(comments.threads.filter(t => placed(t.anchor)).map(t => ({
    id: t.id, node: t.anchor.node ? idOf[t.anchor.node] || "missing" : null, line: t.anchor.line || 0,
    pkg: t.anchor.package || null, x: t.anchor.x || 0, y: t.anchor.y || 0,
    state: threadState(t), count: t.messages.length,
  })));
  if (chatOpen()) renderChat();
  for (const q of panel.querySelectorAll(".questions")) {
    q.innerHTML = threadList(threadsAt(q.dataset.for));
    for (const li of q.querySelectorAll("li[data-thread]")) li.onclick = () => focusThread(li.dataset.thread);
  }
  refreshBadge();
}

async function loadThreads(force = false) {
  const ts = await api("api/threads");
  const sig = JSON.stringify(ts);
  if (!force && sig === comments.sig) return;
  const before = new Map(comments.threads.map(t => [t.id, answersIn(t)]));
  comments.sig = sig;
  comments.threads = ts;
  if (!chat.seen) loadSeen();
  refreshComments();
  // A hidden tab does not poll, so a thread can come with its question and
  // answer at once.
  const fresh = ts.filter(t => answersIn(t) > (before.get(t.id) ?? 0) && unread(t));
  if (fresh.length && !chatOpen()) showToast(fresh[fresh.length - 1], fresh.length);
  if (fresh.length) markSeen();
}

chat.btn.onclick = () => setChat(!chatOpen());
document.getElementById("chat-close").onclick = () => setChat(false);
chat.box.onkeydown = e => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); }
  if (e.key === "Escape") chat.box.blur();
};

async function startComments() {
  if (!location.protocol.startsWith("http")) return;
  try {
    await loadThreads(true);
  } catch {
    return; // a plain file server: no comments API
  }
  comments.on = true;
  map.setCanAsk(true);
  commentBtn.hidden = false;
  commentBtn.onclick = () => setCommentMode(!commentMode);
  chat.btn.hidden = false;
  let saved = null;
  try { saved = localStorage.getItem("map-pr:chat"); } catch {}
  setChat(saved !== "closed");
  route(); // show the comment parts of the current view, or open a #thread= link
  setInterval(() => { if (!document.hidden) loadThreads().catch(() => {}); }, 2500);
}

// ---------- controls ----------

document.addEventListener("keydown", evt => {
  if (evt.target.closest("input, textarea") || evt.metaKey || evt.ctrlKey) return;
  if (pathView) {
    const { i, at } = pathView, last = codePaths[i].ids.length - 1;
    const go = d => { evt.preventDefault(); showPath(i, at === null ? (d > 0 ? 0 : null) : at + d < 0 ? null : Math.min(at + d, last)); };
    if (evt.key === "ArrowRight" || evt.key === "j") return go(1);
    if (evt.key === "ArrowLeft" || evt.key === "k") return go(-1);
  }
  if (evt.key === "Escape") { if (commentMode) setCommentMode(false); else home(); }
  if ((evt.key === "c" || evt.key === "C") && comments.on) setCommentMode(!commentMode);
  if (evt.key === "/" && comments.on) { evt.preventDefault(); setChat(true); chat.box.focus(); }
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

// splitter makes a bar resize the column next to it as it is dragged. width
// turns the pointer's x into the column's width.
function splitter(bar, col, width, key) {
  try { const w = localStorage.getItem(key); if (w) col.style.width = w; } catch {}
  bar.addEventListener("pointerdown", evt => {
    bar.setPointerCapture(evt.pointerId);
    bar.classList.add("dragging");
    const move = e => { col.style.width = width(e.clientX) + "px"; };
    const up = () => {
      bar.classList.remove("dragging");
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", up);
      try { localStorage.setItem(key, col.style.width); } catch {}
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
  });
}
splitter(document.getElementById("split"), panel,
  x => Math.max(320, Math.min(window.innerWidth - 200, window.innerWidth - x)), "map-pr:panel-width");
// The chat leaves the map at least 300px beside the side panel.
splitter(document.getElementById("chat-split"), chat.el,
  x => Math.max(240, Math.min(window.innerWidth - panel.offsetWidth - 300, x)), "map-pr:chat-width");

if (!nodes.length) {
  document.getElementById("stage").insertAdjacentHTML("beforeend",
    `<p class="empty" style="position:absolute;inset:24px">No changed Go or TypeScript declarations found.</p>`);
}
map.setData(mapData());
map.fit(false);
route();
startComments();

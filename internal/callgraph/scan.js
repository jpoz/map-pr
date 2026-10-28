// scan.js reads a repository's TypeScript and JavaScript with the TypeScript
// compiler and prints, as JSON, the top-level declarations of each file and
// the places that use them. map-pr runs it with "node -e" in the repository
// root and sends {root, files} on stdin; files are relative to root.
"use strict";
const fs = require("fs");
const path = require("path");

let ts;
try {
  ts = require("typescript");
} catch {
  process.stderr.write("cannot load the typescript package: install it in the repository (npm install -D typescript) or globally (npm install -g typescript)\n");
  process.exit(3);
}

const input = JSON.parse(fs.readFileSync(0, "utf8"));
const root = input.root;
const files = input.files.map(f => path.join(root, f));

// ---------- compiler options ----------

const defaultOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler ?? ts.ModuleResolutionKind.NodeJs,
  jsx: ts.JsxEmit.Preserve,
  esModuleInterop: true,
  resolveJsonModule: true,
};

// nearestConfig finds the tsconfig.json or jsconfig.json that applies to the
// files in dir: the first one in dir or above it, up to the root.
const configIn = new Map();
function nearestConfig(dir) {
  if (configIn.has(dir)) return configIn.get(dir);
  let cfg = "";
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    if (!cfg && fs.existsSync(path.join(dir, name))) cfg = path.join(dir, name);
  }
  if (!cfg && dir !== root && dir.startsWith(root + path.sep)) cfg = nearestConfig(path.dirname(dir));
  configIn.set(dir, cfg);
  return cfg;
}

const parsed = new Map();
function parse(cfg) {
  if (!parsed.has(cfg)) {
    let p = null;
    try {
      p = ts.getParsedCommandLineOfConfigFile(cfg, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} }) ?? null;
    } catch {}
    if (p) p.fileSet = new Set(p.fileNames.map(f => path.resolve(f)));
    parsed.set(cfg, p);
  }
  return parsed.get(cfg);
}

// configFor picks the config whose options a file is read with. A solution
// config lists no files and only references others; then it is the
// referenced config that includes the file, or the first one.
function configFor(file) {
  const cfg = nearestConfig(path.dirname(file));
  const p = cfg && parse(cfg);
  if (!p || p.fileNames.length > 0 || !p.projectReferences) return cfg;
  let first = "";
  for (const ref of p.projectReferences) {
    const rc = ts.resolveProjectReferencePath(ref);
    const rp = parse(rc);
    if (!rp) continue;
    if (rp.fileSet.has(file)) return rc;
    first ||= rc;
  }
  return first || cfg;
}

// ---------- declarations ----------

const decls = [];
// index maps a declaration node, by its file and position, to the ID of the
// map declaration it belongs to. Programs read the same file again, so
// nodes are named by place, not by object.
const index = new Map();
const nodeKey = n => n.getSourceFile().fileName + ":" + n.pos;
const refs = [];
const routes = [];

const VERBS = new Set(["get", "post", "put", "patch", "delete", "del", "options", "head", "all"]);
const NEXT_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

// unwrap removes parentheses and type assertions around an expression.
function unwrap(e) {
  while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) ||
    ts.isTypeAssertionExpression(e) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(e)))) e = e.expression;
  return e;
}
const isFuncLit = e => !!e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e));
// isFuncValue is true for a function, or a call that wraps one and returns
// a function, as in memo(() => ...) or withAuth(async (req) => ...).
function isFuncValue(e, checker) {
  e = unwrap(e);
  if (isFuncLit(e)) return true;
  if (!e || !ts.isCallExpression(e) || !e.arguments.some(a => isFuncLit(unwrap(a)))) return false;
  return checker.getTypeAtLocation(e).getCallSignatures().length > 0;
}
const hasExport = n => !!(ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Export);
const hasDefault = n => !!(ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Default);

// nextRoute names the route of a Next.js route handler or API page.
function nextRoute(rel, name, isDefault) {
  let m = /(?:^|\/)app\/((?:.*\/)?)route\.[cm]?[jt]sx?$/.exec(rel);
  if (m && NEXT_METHODS.has(name)) {
    const segs = m[1].split("/").filter(s => s && !/^\(.*\)$/.test(s) && !s.startsWith("@"));
    return name + " /" + segs.join("/");
  }
  m = /(?:^|\/)pages\/(api\/.*)\.[cm]?[jt]sx?$/.exec(rel);
  if (m && isDefault) return "/" + m[1].replace(/\/?index$/, "");
  return "";
}

function scanFile(sf, checker) {
  const rel = path.relative(root, sf.fileName).split(path.sep).join("/");
  const line = pos => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const idAt = n => {
    const lc = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    return `${sf.fileName}:${lc.line + 1}:${lc.character + 1}`;
  };
  const span = n => {
    const start = n.getStart(sf);
    const lc = sf.getLineAndCharacterOfPosition(start);
    const lineStart = sf.getLineStarts()[lc.line];
    return [lc.line + 1, Buffer.byteLength(sf.text.slice(lineStart, start)) + 1, Buffer.byteLength(sf.text.slice(start, n.end))];
  };
  const isTest = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);

  const mine = [];
  // add makes a map declaration. idNode is where its ID points; bodies are
  // the nodes searched for uses; keyNodes are the declaration nodes that
  // a use of it resolves to.
  function add(name, kind, idNode, first, last, bodies, keyNodes, extra = {}) {
    const d = {
      id: idAt(idNode), name, kind, file: rel, line: line(first.getStart(sf)), endLine: line(last.end),
      exported: false, entry: "", routes: [], inner: [], locals: [], bodies, func: false, ...extra,
    };
    for (const k of keyNodes) index.set(nodeKey(k), d.id);
    decls.push(d);
    mine.push(d);
    return d;
  }
  // extend adds an overload, or the other accessor of a pair, to d.
  function extend(d, n, bodies) {
    d.endLine = line(n.end);
    d.bodies.push(...bodies);
    index.set(nodeKey(n), d.id);
  }

  function addClass(st, name, exported) {
    const props = [];
    const methods = [];
    let prev = null;
    for (const m of st.members) {
      const isFunc = ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m) ||
        (ts.isPropertyDeclaration(m) && isFuncValue(m.initializer, checker));
      if (!isFunc) {
        props.push(m);
        prev = null;
        continue;
      }
      const mname = ts.isConstructorDeclaration(m) ? "constructor" : m.name.getText(sf);
      if (prev && prev.mname === mname) {
        extend(prev, m, [m]);
        continue;
      }
      const priv = ts.isPrivateIdentifier(m.name ?? m) ||
        !!(ts.getCombinedModifierFlags(m) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected));
      const idNode = ts.isConstructorDeclaration(m) ? m.getFirstToken(sf) : m.name;
      prev = add(`${name}.${mname}`, "method", idNode, m, m, [m], [m], { exported: exported && !priv, func: true, mname });
      methods.push(prev);
    }
    const bodies = [...(st.modifiers ?? []), ...(st.typeParameters ?? []), ...(st.heritageClauses ?? []), ...props];
    const cls = add(name, "type", st.name ?? st.getFirstToken(sf), st, st, bodies, [st], { exported });
    cls.inner = methods.map(m => [m.line, m.endLine]);
  }

  // runs collects consecutive top-level statements that are not declarations.
  let run = null;
  let runs = 0;
  let prev = null;
  for (const st of sf.statements) {
    const exported = hasExport(st) && !isTest;
    if (ts.isFunctionDeclaration(st)) {
      run = null;
      const name = st.name ? st.name.text : "default";
      if (prev && prev.kind === "func" && prev.name === name && prev.overloads) {
        extend(prev, st, [st]);
        continue;
      }
      prev = add(name, "func", st.name ?? st, st, st, [st], [st], { exported, func: true, overloads: true });
      prev.routes.push(nextRoute(rel, name, hasDefault(st)));
      continue;
    }
    prev = null;
    if (ts.isClassDeclaration(st)) {
      run = null;
      addClass(st, st.name ? st.name.text : "default", exported);
    } else if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) {
      run = null;
      add(st.name.text, "type", st.name, st, st, [st], [st], { exported });
    } else if (ts.isVariableStatement(st)) {
      run = null;
      const isConst = !!(st.declarationList.flags & (ts.NodeFlags.Const | ts.NodeFlags.Using));
      for (const v of st.declarationList.declarations) {
        const init = unwrap(v.initializer);
        const kind = isFuncValue(v.initializer, checker) ? "func" : init && ts.isClassExpression(init) ? "type" : isConst ? "const" : "var";
        const bodies = [v.type, v.initializer].filter(Boolean);
        if (ts.isIdentifier(v.name)) {
          const d = add(v.name.text, kind, v.name, st, st, bodies, [v], { exported, func: kind === "func" });
          d.routes.push(nextRoute(rel, v.name.text, false));
          continue;
        }
        // A destructuring declares each name it binds.
        const names = [];
        const walk = b => ts.isIdentifier(b.name) ? names.push(b) : b.name.elements.forEach(e => ts.isBindingElement(e) && walk(e));
        v.name.elements.forEach(e => ts.isBindingElement(e) && walk(e));
        names.forEach((b, i) => add(b.name.text, kind, b.name, st, st, i === 0 ? [v] : [], [b], { exported }));
      }
    } else if (ts.isExportAssignment(st)) {
      run = null;
      const e = unwrap(st.expression);
      if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) continue; // names a declaration made above
      const kind = isFuncValue(st.expression, checker) ? "func" : ts.isClassExpression(e) ? "type" : "var";
      const d = add("default", kind, st, st, st, [st.expression], [st], { exported: !isTest, func: kind === "func" });
      d.routes.push(nextRoute(rel, "default", true));
    } else if (ts.isImportDeclaration(st) || ts.isImportEqualsDeclaration(st) || ts.isExportDeclaration(st) ||
      ts.isModuleDeclaration(st) || ts.isEmptyStatement(st) || st.kind === ts.SyntaxKind.MissingDeclaration) {
      run = null;
    } else {
      // In a test file, each describe("..."), test("...") or it("...") at the
      // top level is a declaration of its own.
      const call = ts.isExpressionStatement(st) && ts.isCallExpression(st.expression) ? st.expression : null;
      const arg = call && call.arguments[0];
      if (isTest && arg && ts.isStringLiteralLike(arg)) {
        run = null;
        const callee = call.expression.getText(sf);
        const label = arg.text.length > 60 ? arg.text.slice(0, 59) + "…" : arg.text;
        add(`${callee.length > 30 ? "test" : callee}(${JSON.stringify(label)})`, "module", st, st, st, [st], [st]);
        continue;
      }
      if (run) {
        extend(run, st, [st]);
      } else {
        runs++;
        run = add(runs === 1 ? "(top level)" : `(top level #${runs})`, "module", st, st, st, [st], [st], { entry: isTest ? "" : "module" });
      }
    }
  }

  // ---------- uses ----------

  // symbolOf returns the symbol a name refers to, through imports.
  function symbolOf(n) {
    let s = checker.getSymbolAtLocation(n);
    if (ts.isShorthandPropertyAssignment(n.parent) && n.parent.name === n) {
      s = checker.getShorthandAssignmentValueSymbol(n.parent) ?? s;
    }
    if (s && s.flags & ts.SymbolFlags.Alias) {
      try { s = checker.getAliasedSymbol(s); } catch {}
    }
    return s;
  }

  // routeOf finds a route registration such as app.get("/x", auth, handler)
  // and records the route of each named function in it.
  function routeOf(call) {
    const e = call.expression;
    if (!ts.isPropertyAccessExpression(e) || !VERBS.has(e.name.text) || call.arguments.length < 2) return;
    const a0 = call.arguments[0];
    if (!ts.isStringLiteralLike(a0) || !a0.text.startsWith("/")) return;
    const verb = e.name.text;
    const route = verb === "all" ? a0.text : (verb === "del" ? "DELETE" : verb.toUpperCase()) + " " + a0.text;
    const visit = n => {
      if (isFuncLit(n)) return;
      if (ts.isIdentifier(n)) {
        const s = symbolOf(n);
        if (s && s.declarations) routes.push({ keys: s.declarations.map(nodeKey), route });
      }
      ts.forEachChild(n, visit);
    };
    call.arguments.slice(1).forEach(visit);
  }

  for (const d of mine) {
    const visit = n => {
      if (ts.isCallExpression(n)) routeOf(n);
      if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) {
        const s = symbolOf(n);
        if (s && s.declarations && s.declarations.length) {
          refs.push({ from: d.id, keys: s.declarations.map(nodeKey), line: line(n.getStart(sf)) });
        }
      }
      ts.forEachChild(n, visit);
    };
    d.bodies.forEach(visit);

    // Locals: the names declared inside a function and used more than once.
    if (d.func) {
      const uses = new Map();
      const first = d.bodies[0].pos, last = d.bodies[d.bodies.length - 1].end;
      const ok = ts.SymbolFlags.Variable | ts.SymbolFlags.Function | ts.SymbolFlags.Class | ts.SymbolFlags.TypeParameter |
        ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Interface | ts.SymbolFlags.Enum;
      const visitLocal = n => {
        if (ts.isIdentifier(n)) {
          let s = checker.getSymbolAtLocation(n);
          if (ts.isShorthandPropertyAssignment(n.parent) && n.parent.name === n) s = checker.getShorthandAssignmentValueSymbol(n.parent) ?? s;
          const decl = s && s.declarations && s.declarations[0];
          if (decl && s.flags & ok && !(s.flags & ts.SymbolFlags.Property) && decl.getSourceFile() === sf &&
            decl.pos >= first && decl.end <= last && !index.has(nodeKey(decl))) {
            if (!uses.has(s)) uses.set(s, []);
            uses.get(s).push(span(n));
          }
        }
        ts.forEachChild(n, visitLocal);
      };
      d.bodies.forEach(visitLocal);
      d.locals = [...uses.values()];
    }
  }
}

// ---------- programs ----------

// Files are read in groups, one program per config, so each file is read
// with the options of its own config.
const groups = new Map();
for (const f of files) {
  const cfg = configFor(f);
  if (!groups.has(cfg)) groups.set(cfg, []);
  groups.get(cfg).push(f);
}
for (const [cfg, names] of groups) {
  const p = cfg ? parse(cfg) : null;
  const options = { ...(p ? p.options : defaultOptions), allowJs: true, noEmit: true, skipLibCheck: true };
  const program = ts.createProgram({ rootNames: names, options, projectReferences: p ? p.projectReferences : undefined });
  const checker = program.getTypeChecker();
  for (const f of names) {
    const sf = program.getSourceFile(f);
    if (!sf) continue;
    try {
      scanFile(sf, checker);
    } catch (e) {
      process.stderr.write(`map-pr: ${path.relative(root, f)}: ${e.message}\n`);
    }
  }
}

// ---------- output ----------

const resolve = keys => {
  for (const k of keys) if (index.has(k)) return index.get(k);
  return "";
};
const seen = new Set();
const outRefs = [];
for (const r of refs) {
  const to = resolve(r.keys);
  const k = r.from + "|" + to + "|" + r.line;
  if (!to || to === r.from || seen.has(k)) continue; // a recursive call is not a use
  seen.add(k);
  outRefs.push({ from: r.from, to, line: r.line });
}
const routesOf = new Map();
for (const r of routes) {
  const to = resolve(r.keys);
  if (!to) continue;
  if (!routesOf.has(to)) routesOf.set(to, []);
  routesOf.get(to).push(r.route);
}
process.stdout.write(JSON.stringify({
  decls: decls.map(d => ({
    id: d.id, name: d.name, kind: d.kind, file: d.file, line: d.line, endLine: d.endLine,
    exported: d.exported, entry: d.entry, routes: [...d.routes.filter(Boolean), ...(routesOf.get(d.id) ?? [])],
    inner: d.inner, locals: d.locals,
  })),
  refs: outRefs,
}));

# map-pr

<img width="800" height="488" alt="CleanShot 2026-10-28 at 8 28 18 AM" src="https://github.com/user-attachments/assets/4e71583e-93c9-4ecf-bd12-853419478c1d" />

Draws a Go or TypeScript pull request as a map you zoom through: the
declarations the branch changes (functions, methods, types, constants,
variables), the code that uses them, and the entry points that reach them. With the `/map-pr` skill,
Claude adds a summary, themes and notes, and answers questions you drop on
the map.

**Example:** [the map of map-pr #5](https://www.jpoz.net/map-pr/example/),
made by `/map-pr` for the pull request that added TypeScript. It maps both
the Go and the JavaScript in it.

## Install

**The Claude Code skill.** In Claude Code:

```
/plugin marketplace add jpoz/map-pr
/plugin install map-pr@map-pr
```

Then ask for a map: `/map-pr https://github.com/owner/repo/pull/123`, a PR
number in the current repo, or nothing for the current branch. (If another
command already uses the name, the skill is `/map-pr:map-pr`.) To install
only the skill, copy `skills/map-pr/` to `~/.claude/skills/`.

The skill needs Go, git and the GitHub CLI (`gh`, logged in). For TypeScript
it also needs Node.js and the `typescript` package (see below). It installs the
`map-pr` command itself, built with the Go version of the repository it maps,
and keeps each map in `~/.cache/map-pr/`.

**The command alone.**

```sh
go install github.com/jpoz/map-pr@latest
map-pr -C path/to/repo -base main -depth 2 -open
```

map-pr type-checks with the Go that builds it. For a repository that needs a
newer Go, build it with that Go: `GOTOOLCHAIN=go1.N.M+auto go install ...`.

| Flag | Default | Meaning |
|---|---|---|
| `-C` | `.` | repository directory |
| `-base` | `main` | base ref; the diff is from `merge-base(base, HEAD)` to the work tree |
| `-depth` | `1` | levels of callers to follow |
| `-tests` | `true` | include `_test.go` files |
| `-format` | `html` | `html`, `json`, or `outline` (a text view with node keys, for writing notes) |
| `-o` | `pr-map.html` | output file, `-` for stdout |
| `-from` | | build from a saved `-format json` map instead of analyzing again |
| `-notes` | | JSON with a summary, themes, and node notes to show on the page |

## TypeScript and JavaScript

When the PR changes a `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` or
`.cjs` file, map-pr also reads the repository's TypeScript and JavaScript. It
runs a small script in Node.js with the TypeScript compiler, the way it reads
Go with `go/types`, so a use links to its real declaration through imports.
It uses the `typescript` package of the repository (`node_modules`), or a
global one (`npm install -g typescript`). Each file is read with the options
of its nearest `tsconfig.json` or `jsconfig.json`.

| TypeScript | On the map |
|---|---|
| `function f`, `const f = () => ...` | func |
| class, interface, type alias, enum | type |
| class method, constructor, accessor | method, as `Class.name` |
| other `const`, `let`, `var` | const, var |
| top-level code that declares nothing | module, an entry point |
| `describe("...")`, `test("...")` in a test file | module |

The package of a file is the `name` in its nearest `package.json`, followed by
the path from there. Test files are `*.test.*`, `*.spec.*` and files in
`__tests__/`. HTTP entry points are Express-style registrations
(`app.get("/x", handler)`) and Next.js route handlers (`app/**/route.ts`) and
API pages (`pages/api/**`).

A repository with both languages gets one map. If the PR changes a JavaScript
file in a Go repository and the `typescript` package is missing, map-pr says so
and maps the Go code.

## SQL migrations

A changed `.sql` file in a folder whose name starts with `migrat` (such as
`migrations/` or `db/migrate/`) is on the map too: each statement is a card,
in a package named after the folder. A `CREATE`, `ALTER` or `DROP TABLE` is a
`table`; an index, function, type or change to rows is `sql`. A goose
`-- +goose Down` section and golang-migrate `.down.sql` files are left out,
as they only undo the migration.

Code that names a table in SQL (after `FROM`, `INTO`, `UPDATE`, `JOIN` or
`TABLE`) uses that table, so a new table links to the queries that read and
write it, such as the constants sqlc generates. An `ALTER TABLE` that adds
columns links to code that names the table and one of those columns.

## Zooming

The map is one space you zoom through, with three levels of detail:

| Zoom | You see |
|---|---|
| out | **Packages**: one card per package with its changed files and `+/−` lines, and arrows between packages that use each other |
| middle | **Declarations**: a card per declaration with its kind, name, file and a minimap of its code; changed lines are green, lines that use something on the map are yellow |
| in | **Code**: the syntax-colored source in each card; an edge starts at the line that makes the call |

Nothing moves when the level changes; each level fades into the next. A
package also opens when it fills most of the view, so a big package shows its
declarations before the small ones do. Scroll or
pinch to zoom around the pointer, drag to pan, double-click a card to zoom to
its code. A declaration clicked in the side panel also zooms to its code. The buttons at the bottom left jump to a level, and `+`, `−` and `0`
zoom in, out and fit. A card names what it is when hovered and its label is too
small to read.

Code the PR does not change is not on the map, but you can still read it. A
declaration's panel lists the unchanged code it uses under "Also uses (not
changed)", and each name in its source that refers to other code is a link.
Click a name to see its definition in the panel (the first 80 lines), with the
code on the map that uses it; follow names from there. Back returns.

Tests start hidden (each card shows how many tests use it; turn on "show tests"
to see them). An EXPORTED badge marks code outside the repository can use, and
the map cannot see those users. A changed type, constant or variable shows at
most 10 users; the panel says how many more there are.

## Entry points

An entry point is where execution starts: an HTTP handler (with its route, when
the code registers it next to a route string such as
`mux.HandleFunc("POST /x", h)`), `main`, a function started with `go`, the
top-level code of a TypeScript module, or code with no callers outside tests (usually called through an interface). map-pr walks
up from each declaration on the map to the nearest entry points, through up to
8 calls that are not on the map. It keeps the fewest entry points that reach
every change, and adds those to the map with a dashed edge; the panel shows the
calls in between. Each declaration lists the entry points it is reached from.

## Code paths

A code path is one chain of calls from an entry point down into the change.
map-pr picks up to 12 of them, so that together they start at each entry point
and reach every change an entry point reaches. The map draws each path as a
numbered, colored line through its declarations, like a transit line. When
paths share a call, their lines run side by side; a declaration on more than
one path is an interchange, drawn as a white ring. Zoomed out, the lines cross
the packages, so you see where the paths go and where they meet.

Point at a line to name it, and click it (or pick it under "Code paths" in the
overview) to follow it. The panel lists every step in call order, with the line
that makes each call and the other paths that pass through it. ← and → step
through the path, and the map zooms in to the code of each step. Each path and
step is in the URL (`#path=2.3`). A declaration lists the paths through it.

## Long functions

In a declaration of more than 40 lines, a run of 8 or more lines that the
change does not touch folds into one "⋯ N unchanged lines" row, on the map and
in the panel, as a PR view folds code. Changed lines, the lines next to
deleted ones, calls into code on the map, the first and last line, and 3 lines
around each of them stay. Click a fold to open it. While a long card's header
is above the top of the screen, its name stays in a bar at the top, and the
panel keeps the name in the header of the source.

A call through an interface that the repository declares links to the
repository's implementations of it, when there are at most 4 (test files do
not count). A call through any other interface (`io.Writer`, an interface with
many implementations) does not link, so a chain can end at a "no callers" entry
point that a real request reaches.

## Notes and themes

`-notes notes.json` adds an explanation on top of the map: a summary, themes
(click one to light up its declarations), and a note on any declaration. Notes refer to declarations by the keys that
`-format outline` prints. map-pr refuses notes that name a key that is not on the
map. The `/map-pr` skill (`skills/map-pr/`) has Claude write them.

Try it: `scripts/demo.sh` makes a repo that changes `authGoogle` and maps it.

## Questions on the map

```sh
map-pr serve -dir path/to/map-dir -open   # serves pr-map.html on 127.0.0.1:8770
```

Served this way, the page has a **chat with Claude** down its left side (the
Chat button, or `/` to type in it). A message can carry a place on the map:
click a line number in a card's code or in the side panel, or "Ask about this"
on a declaration, and that line or declaration goes on the message you are
writing. **Point** (or `C`) attaches any place: a line, a card, a package, or a
point on the map. Enter sends, Shift+Enter starts a new line. Drag the edge of
the chat, or of the side panel, to resize it; the page keeps the width.

A message with a place shows as a pin on the map. Click the place on a message
to go back to it on the map; click a pin to find its message in the chat. An
answer to an earlier question quotes it. While the chat is hidden, the Chat
button and the tab title count the answers you have not read, and a new answer
shows a short notice at the top of the map. Which answers you have read is kept
in the browser.

Each message you send is a thread in `comments.json` next to the page. Nothing leaves the
machine: the server listens on loopback only, refuses other hosts, and accepts
only JSON posts. Answer from the terminal:

```sh
map-pr comments -dir DIR          # open questions, with their place on the map
map-pr comments -dir DIR -watch   # one line per new question, until stopped
map-pr reply -dir DIR -id ID "text"   # or "-" to read the answer from stdin
```

Opened as a file, the page has no comments.

## Limits (for now)

- Go, TypeScript and JavaScript, and the statements of SQL migrations. Other
  files show as diffs in the panel.
- Calls through an interface do not link to the concrete method. In
  TypeScript, a call through an interface or a function value does not link either.
- Deleted declarations are not on the map; their files show as diffs in the panel.
- The page loads dagre (jsdelivr) and @pierre/diffs (esm.sh) from a CDN. Offline, code shows without syntax colors.

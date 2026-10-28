# map-pr

Draws a Go pull request as a map you zoom through: the declarations the branch
changes (functions, methods, types, constants, variables), the code that uses
them, and the entry points that reach them. With the `/map-pr` skill,
Claude adds themes, a guided tour and notes, and answers questions you drop on
the map.

**Example:** [the map of map-pr #2](https://jpoz.github.io/map-pr/example/),
made by `/map-pr` for one of this repository's own pull requests.

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

The skill needs Go, git and the GitHub CLI (`gh`, logged in). It installs the
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
| `-notes` | | JSON with themes, a tour, and node notes to show on the page |

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
`mux.HandleFunc("POST /x", h)`), `main`, a function started with `go`, or code
with no callers outside tests (usually called through an interface). map-pr walks
up from each declaration on the map to the nearest entry points, through up to
8 calls that are not on the map. It keeps the fewest entry points that reach
every change, and adds those to the map with a dashed edge; the panel shows the
calls in between. The overview lists them as "Entry points · start here", most
changes first, and puts routes that reach the same changes in one row. Each
declaration lists the entry points it is reached from.

Calls through an interface do not link, so a chain can end at a "no callers"
entry point that a real request reaches.

## Notes, themes, and a tour

`-notes notes.json` adds an explanation on top of the map: a summary, themes
(click one to light up its declarations), a guided tour (arrow keys step through
it), and a note on any declaration. Notes refer to declarations by the keys that
`-format outline` prints. map-pr refuses notes that name a key that is not on the
map. The `/map-pr` skill (`skills/map-pr/`) has Claude write them.

Try it: `scripts/demo.sh` makes a repo that changes `authGoogle` and maps it.

## Questions on the map

```sh
map-pr serve -dir path/to/map-dir -open   # serves pr-map.html on 127.0.0.1:8770
```

Served this way, the page has a **Comment** button (or press `C`): click
anywhere on the map to ask about that place. A click on a card's code asks
about that line; a click on a package or empty space asks about it. In the side
panel, "Ask about this" and the line numbers of the source do the same. Each
question shows as a pin on the map and as a thread in the panel, where answers
appear without a reload.

The threads are in `comments.json` next to the page. Nothing leaves the
machine: the server listens on loopback only, refuses other hosts, and accepts
only JSON posts. Answer from the terminal:

```sh
map-pr comments -dir DIR          # open questions, with their place on the map
map-pr comments -dir DIR -watch   # one line per new question, until stopped
map-pr reply -dir DIR -id ID "text"   # or "-" to read the answer from stdin
```

Opened as a file, the page has no comments.

## Limits (for now)

- Go only.
- Calls through an interface do not link to the concrete method.
- Deleted declarations are not on the map; their files show as diffs in the panel.
- The page loads dagre (jsdelivr) and @pierre/diffs (esm.sh) from a CDN. Offline, code shows without syntax colors.

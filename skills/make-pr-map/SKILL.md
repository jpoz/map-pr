---
name: make-pr-map
description: Build an interactive, zoomable map of a Go pull request — the declarations it changes (functions, methods, types, constants, variables), the code that uses them, plus Claude-written themes, a guided tour, and per-declaration notes — as one HTML page. Use when the user asks to map, visualize, or explain a PR "as a map", or runs /make-pr-map with a PR URL, number, or nothing (current branch).
argument-hint: "[PR URL | owner/repo#N | N | empty for current branch]"
---

# make-pr-map

`map-pr` (github.com/jpoz/map-pr) finds the changed Go declarations and their
users with type information. You add the meaning: themes, a tour and notes.
map-pr puts both on one HTML page.

Needs: Go, git, and `gh` (logged in) for PRs on GitHub.

Work in `~/.cache/map-pr/<repo>-<pr>/` (call it `$OUT`). Keep private code on
this machine: never publish the page or the notes anywhere unless the user asks.

## 1. Get the code at the PR head

- **PR URL, `owner/repo#N`, or `N`:** read the PR:
  `gh pr view <N> -R <owner/repo> --json title,body,baseRefOid,headRefOid,files`.
  Clone once to `~/.cache/map-pr/repos/<owner>/<repo>`
  (`gh repo clone <owner/repo> <dir> -- --filter=blob:none`), then
  `git fetch origin pull/<N>/head:pr-<N> && git checkout pr-<N>`.
  The base is `baseRefOid`.
- **No argument:** use the current repo and branch. The base is the default
  branch (`gh repo view --json defaultBranchRef`), or what the user names.

## 2. Install map-pr with the repo's Go toolchain, and run it

map-pr type-checks with the `go/types` of the Go that builds it, so build it
with the toolchain the repo asks for. `+auto` lets Go pick a newer toolchain
when map-pr itself needs one. Install it per map, in `$OUT/bin`:

```sh
GOV=$(go -C <repo> env GOVERSION)
GOBIN=$OUT/bin GOTOOLCHAIN=$GOV+auto go install github.com/jpoz/map-pr@latest
M=$OUT/bin/map-pr
$M -C <repo> -base <base> -format json -o $OUT/map.json
$M -from $OUT/map.json -format outline -o $OUT/outline.txt
```

(To work on map-pr itself, build a checkout instead:
`GOTOOLCHAIN=$GOV+auto go build -o $OUT/bin/map-pr <checkout>`.)

Look at stderr: type errors mean the toolchain or modules are wrong. Fix them
before you go on; a map built on broken types misses callers.

If there are no changed Go declarations, tell the user and stop.

## 3. Understand the PR

Read, in this order:
1. The PR title and body (if there is one).
2. `$OUT/outline.txt`: every changed declaration with its **key**, kind, status,
   changed line count and users, then non-Go and deleted files.
3. The diff of the production code: `git -C <repo> diff <merge-base> -- <files>`.
   Start with schema/migration and query files, then the functions with the
   most callers or the most changed lines. Skip tests until the end.

Check every claim you will write against the diff. If the PR body says
something, find it in the code. Do not guess from names.

The outline's ENTRY POINTS section lists where execution starts and reaches
the changes: HTTP routes, `main`, goroutines, and code with no callers outside
tests. Use it to find how a user or service reaches the change. A changed
function with "no callers" is either called through an interface or not used
yet; say which.

Look especially for:
- **Behavior changes** vs renames and refactors (say which).
- **Removed safety:** deleted checks, gates, approvals, locks.
- **Deleted code** — map-pr does not show deleted declarations yet, so name them
  in the tour text.
- **Entry points** a user or other service reaches: routes, CLI commands, tool
  definitions, workers. Exported functions may have callers outside the repo.
- **Migrations and rollout:** what happens to existing data, and to old and new
  versions running at the same time.

## 4. Write `$OUT/notes.json`

```json
{
  "title": "repo #N · PR title",
  "summary": "2 short paragraphs: what changes and why, for someone who has not seen the PR.",
  "themes": [
    {
      "id": "short-id",
      "title": "4–8 words",
      "summary": "First paragraph shows on the overview. More paragraphs show when the theme is open.",
      "nodes": ["<key from outline>", "..."],
      "files": ["non-Go files that belong to this theme"]
    }
  ],
  "tour": [
    {
      "title": "Short title",
      "theme": "short-id (optional)",
      "body": "What to look at and why. Use **Review here:** or **Check:** for what a reviewer must decide.",
      "nodes": ["2–6 keys to show for this step"],
      "files": ["optional"]
    }
  ],
  "nodes": { "<key>": "1–2 sentences on what changed in this function and why it matters." }
}
```

Rules:
- **Keys** must be copied exactly from the outline (`file:Name`, e.g.
  `internal/store/flow.go:(*Store).Save`).
- **Files** must be exact paths of files the PR changes or deletes (no notes
  after the path). The page shows each file's diff: open by default in a tour
  step with no nodes, on click everywhere else. Use a files-only step for a
  migration, a query file, or a deleted file whose removed code matters.
- **Themes:** 3–7. Put every changed code declaration into one theme. Order them
  the way the change flows (data → logic → entry points → surfaces).
- **Tour:** 5–10 steps in reading order. Step 1 is the idea in plain words
  (no nodes is fine). Step 2 is often where to start: the entry points that reach the
  most changes (keys from the outline's ENTRY POINTS). Each later step shows a small set of nodes that call each
  other, so the focused view draws a readable graph. End with what was deleted
  or what is not on the map.
- **Node notes:** for the 8–20 declarations that matter most. Start with the kind
  of change in bold when it helps (**Behavior change:**, **Renamed:**, **New:**).
- Text supports `` `code` ``, `**bold**` and blank-line paragraphs only.
- Plain, short sentences. No praise, no filler.

## 5. Build the page and check it

```sh
$M -from $OUT/map.json -notes $OUT/notes.json -o $OUT/pr-map.html
```

map-pr refuses notes that name a key or theme that is not on the map and lists
each problem. Fix `notes.json` and run it again until it passes.

If browser tools are available, look at the page through the server from
step 6 (a browser tool may refuse `file://`) and step through the tour. A step whose declarations sit in
packages far apart opens at the package level with labeled pins; one in a
single package opens at the declaration level. Prefer steps of the second
kind: pick declarations that call each other.

## 6. Serve it, and answer questions

Serve the page so the reader can drop questions on it, and watch for them:

```sh
$M serve -dir $OUT -addr 127.0.0.1:8770    # run in the background
$M comments -dir $OUT -watch               # watch it, e.g. with the Monitor tool
```

If port 8770 is taken, pick another and use it in the URL below.

Each line from `-watch` is a new question: `[ID] <node key> line N: <text>`.
For each one:
1. Run `$M comments -dir $OUT` to see the whole thread.
2. Read the code at that place in the repo (and the diff), not only the map.
3. Answer with `$M reply -dir $OUT -id ID -` and the text on stdin.
   Same Markdown as the notes, plus line breaks. Say what you checked; say
   when something is a guess. Use `-resolve` only when the reader asks.

The reader sees the answer in the page within a few seconds. Re-arm the
Monitor when it expires while the reader still uses the map.

## 7. Hand it over

Open the served URL (`http://127.0.0.1:8770/pr-map.html`). Tell the user the path, the themes in one line
each, and the 2–4 things a reviewer must decide (from your **Review here** and
**Check** points).

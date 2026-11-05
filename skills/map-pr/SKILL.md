---
name: map-pr
description: Build an interactive, zoomable map of a Go or TypeScript pull request — the declarations it changes (functions, methods, types, constants, variables), the code that uses them, plus code paths from the entry points, Claude-written themes, and per-declaration notes — as one HTML page. Use when the user asks to map, visualize, or explain a PR "as a map", or runs /map-pr with a PR URL, number, or nothing (current branch).
argument-hint: "[PR URL | owner/repo#N | N | empty for current branch]"
---

# map-pr

`map-pr` (github.com/jpoz/map-pr) finds the changed Go and TypeScript
declarations and their users with type information. You add the meaning: a summary, themes and notes.
map-pr puts both on one HTML page.

Needs: Go, git, and `gh` (logged in) for PRs on GitHub. For TypeScript or
JavaScript: Node.js and the `typescript` package. map-pr uses the repo's own
(run `npm ci` or the repo's install command first) or a global one.

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

(To work on map-pr itself, or before it is on a module proxy, build a checkout
instead: `GOTOOLCHAIN=$GOV+auto go -C <checkout> build -o $OUT/bin/map-pr .`)

Look at stderr: type errors mean the toolchain or modules are wrong. For
TypeScript, "cannot load the typescript package" means you must install the
repo's dependencies, or `npm install -g typescript`. Fix them
before you go on; a map built on broken types misses callers.

If there are no changed Go or TypeScript declarations, tell the user and stop.

## 3. Understand the PR

Read, in this order:
1. The PR title and body (if there is one).
2. `$OUT/outline.txt`: every changed declaration (and each statement of a SQL
   migration, as `table` or `sql`) with its **key**, kind, status,
   changed line count and users, then other (not Go or TypeScript) and deleted files.
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
  in the summary.
- **Entry points** a user or other service reaches: routes, CLI commands, tool
  definitions, workers. Exported functions may have callers outside the repo.
- **Migrations and rollout:** what happens to existing data, and to old and new
  versions running at the same time.

## 4. Write `$OUT/notes.json`

```json
{
  "title": "repo #N · PR title",
  "url": "https://github.com/owner/repo/pull/N (the page title links here; omit when there is no PR)",
  "summary": "2 short paragraphs: what changes and why, for someone who has not seen the PR. A third may name deleted code.",
  "themes": [
    {
      "id": "short-id",
      "title": "4–8 words",
      "summary": "First paragraph shows on the overview. More paragraphs show when the theme is open.",
      "nodes": ["<key from outline>", "..."],
      "files": ["other changed files that belong to this theme"]
    }
  ],
  "nodes": { "<key>": "1–2 sentences on what changed in this function and why it matters." }
}
```

Rules:
- **Keys** must be copied exactly from the outline (`file:Name`, e.g.
  `internal/store/flow.go:(*Store).Save`).
- **Files** must be exact paths of files the PR changes or deletes (no notes
  after the path). The page shows each file's diff on click. Put a migration,
  a query file, or a deleted file whose removed code matters in its theme.
- **Themes:** 3–7. Put every changed code declaration into one theme. Order them
  the way the change flows (data → logic → entry points → surfaces).
- **Node notes:** for the 8–20 declarations that matter most. Start with the kind
  of change in bold when it helps (**Behavior change:**, **Renamed:**, **New:**).
  Put what a reviewer must decide in the note of the declaration it is about,
  with **Review here:** or **Check:**.
- Text supports `` `code` ``, `**bold**` and blank-line paragraphs only.
- Plain, short sentences. No praise, no filler.

## 5. Build the page and check it

```sh
$M -from $OUT/map.json -notes $OUT/notes.json -o $OUT/pr-map.html
```

map-pr refuses notes that name a key that is not on the map and lists
each problem. Fix `notes.json` and run it again until it passes.

If browser tools are available, look at the page through the server from
step 6 (a browser tool may refuse `file://`): open each theme and a few code
paths.

The page draws code paths by itself: colored lines from each entry point
down through the calls into the change. When a reader asks how a request
reaches some code, point them to the path that goes through it
(`#path=N` in the URL; the declaration's panel lists its paths).

## 6. Serve it, and answer questions

Serve the page so the reader can chat with you about it, and watch for messages:

```sh
$M serve -dir $OUT -addr 127.0.0.1:8770    # run in the background
$M comments -dir $OUT -watch               # watch it, e.g. with the Monitor tool
```

If port 8770 is taken, pick another and use it in the URL below.

Each line from `-watch` is a new chat message: `[ID] <node key> line N: <text>`,
or `[ID] chat: <text>` for a message with no place on the map. The page shows
one chat, so a message may follow up on an earlier one: read the other threads
for context.
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

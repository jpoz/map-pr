package callgraph

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"

	"github.com/jpoz/map-pr/internal/gitdiff"
)

const tsAuth = `export class Session {
  start(token: string): string {
    return check(token);
  }
}

function check(token: string): string {
  if (token === "") {
    throw new Error("empty");
  }
  return token;
}
`

const tsServer = `import { Session } from "./auth";

declare const app: { post(p: string, h: Function): void };

export const handleStart = (token: string) => new Session().start(token);

export const tokens = ["a", "b"].map(t => t.trim());

app.post("/start", handleStart);
console.log(tokens);
`

func TestBuildTypeScript(t *testing.T) {
	dir := t.TempDir()
	if exec.Command("node", "-e", `require("typescript")`).Run() != nil {
		t.Skip("node with the typescript package is not available (set NODE_PATH to run this test)")
	}
	write := func(name, body string) {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("package.json", `{"name": "demo"}`)
	write("src/auth.ts", tsAuth)
	write("src/server.ts", tsServer)
	if out, err := exec.Command("git", "-C", dir, "init", "-q").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, out)
	}
	root, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}

	// The PR changes the check in check (line 8).
	d := &gitdiff.Diff{Root: root, Files: map[string]*gitdiff.FileChange{
		"src/auth.ts": {Path: "src/auth.ts", Lines: map[int]bool{8: true}},
	}}
	m, err := Build(d, Options{Depth: 3})
	if err != nil {
		t.Fatal(err)
	}

	got := map[string]string{}
	names := map[string]string{}
	for _, n := range m.Nodes {
		got[n.Key] = string(n.Kind) + " " + string(n.Status)
		names[n.ID] = n.Name
		if n.Package != "demo/src" {
			t.Errorf("%s: package %q, want demo/src", n.Key, n.Package)
		}
		if n.Key == "src/server.ts:handleStart" && (n.Entry == nil || !slices.Equal(n.Entry.Routes, []string{"POST /start"})) {
			t.Errorf("handleStart entry = %+v, want route POST /start", n.Entry)
		}
	}
	want := map[string]string{
		"src/auth.ts:check":         "func modified",
		"src/auth.ts:Session.start": "method caller",
		"src/server.ts:handleStart": "func caller",
		"src/server.ts:(top level)": "module caller",
	}
	for k, w := range want {
		if got[k] != w {
			t.Errorf("node %s = %q, want %q", k, got[k], w)
		}
	}
	// An array made with a callback is a value, not a function.
	tokens := ""
	for _, def := range m.Defs {
		if def.Name == "tokens" {
			tokens = string(def.Kind)
		}
	}
	if tokens != string(KindConst) {
		t.Errorf("tokens kind = %q, want const", tokens)
	}
	// A change inside a method is not a change of its class.
	if _, ok := got["src/auth.ts:Session"]; ok {
		t.Errorf("class Session is on the map; only its method uses the change")
	}

	var edges []string
	for _, e := range m.Edges {
		edges = append(edges, names[e.From]+"->"+names[e.To])
	}
	slices.Sort(edges)
	wantEdges := []string{"(top level)->handleStart", "Session.start->check", "handleStart->Session.start"}
	if !slices.Equal(edges, wantEdges) {
		t.Errorf("edges = %v, want %v", edges, wantEdges)
	}
}

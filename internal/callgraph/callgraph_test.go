package callgraph

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/jpoz/map-pr/internal/gitdiff"
)

const testSource = `package a

const Limit = 3

type Config struct {
	N int
}

func use(c Config) int { return c.N + Limit }

func (c Config) Double() int { return c.N * 2 }

func caller() int { return use(Config{}) }
`

func TestBuildDeclarations(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("go.mod", "module example.com/a\n\ngo 1.22\n")
	write("a.go", testSource)
	root, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}

	// The PR changes the constant's only line (3) and one field of the type (6).
	d := &gitdiff.Diff{Root: root, Files: map[string]*gitdiff.FileChange{
		"a.go": {Path: "a.go", Lines: map[int]bool{3: true, 6: true}},
	}}
	m, err := Build(d, Options{Depth: 1})
	if err != nil {
		t.Fatal(err)
	}

	got := map[string]string{}
	keys := map[string]string{}
	for _, n := range m.Nodes {
		got[n.Name] = string(n.Kind) + " " + string(n.Status)
		keys[n.ID] = n.Name
	}
	want := map[string]string{
		"Limit":  "const added", // every line of it changed
		"Config": "type modified",
		"use":    "func caller",
		"caller": "func caller",
	}
	for name, w := range want {
		if got[name] != w {
			t.Errorf("node %s = %q, want %q", name, got[name], w)
		}
	}
	// A method uses its receiver type, but that does not make it a user.
	if _, ok := got["(Config).Double"]; ok {
		t.Errorf("(Config).Double is on the map; a receiver must not count as a use")
	}

	var edges []string
	for _, e := range m.Edges {
		edges = append(edges, keys[e.From]+"->"+keys[e.To])
	}
	slices.Sort(edges)
	wantEdges := []string{"caller->Config", "use->Config", "use->Limit"}
	if !slices.Equal(edges, wantEdges) {
		t.Errorf("edges = %v, want %v", edges, wantEdges)
	}
}

func TestUsersOfCapsDeclarations(t *testing.T) {
	decls := map[string]*declInfo{}
	rs := map[ref]bool{}
	for i := range maxDeclUsers + 5 {
		id := string(rune('a' + i))
		decls[id] = &declInfo{node: &Node{ID: id}}
		rs[ref{from: id, line: 1}] = true
	}
	typ := &Node{Kind: KindType}
	if got := usersOf(typ, rs, decls, map[string]bool{}); len(got) != maxDeclUsers {
		t.Errorf("type users = %d, want %d", len(got), maxDeclUsers)
	}
	if typ.Hidden != 5 {
		t.Errorf("Hidden = %d, want 5", typ.Hidden)
	}
	fn := &Node{Kind: KindFunc}
	if got := usersOf(fn, rs, decls, map[string]bool{}); len(got) != maxDeclUsers+5 {
		t.Errorf("func users = %d, want all %d", len(got), maxDeclUsers+5)
	}
}

const entrySource = `package main

import "net/http"

func changed() int { return 1 }

func helper() int { return changed() }

func far() int { return helper() }

func handleX(w http.ResponseWriter, r *http.Request) { far() }

func worker() { far() }

func main() {
	http.HandleFunc("GET /x", handleX)
	go worker()
}
`

func TestBuildEntryPoints(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("go.mod", "module example.com/m\n\ngo 1.22\n")
	write("main.go", entrySource)
	root, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	d := &gitdiff.Diff{Root: root, Files: map[string]*gitdiff.FileChange{
		"main.go": {Path: "main.go", Lines: map[int]bool{5: true}},
	}}
	m, err := Build(d, Options{Depth: 1})
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]*Node{}
	names := map[string]string{}
	for _, n := range m.Nodes {
		byName[n.Name] = n
		names[n.ID] = n.Name
	}
	// handleX and worker reach the change through far and helper, which are
	// not on the map at depth 1; one of them covers it, and the HTTP route wins.
	h := byName["handleX"]
	if h == nil || h.Status != StatusEntry || h.Entry.Kind != EntryHTTP || !slices.Equal(h.Entry.Routes, []string{"GET /x"}) {
		t.Fatalf("handleX = %+v, want an HTTP entry with route GET /x", h)
	}
	if byName["far"] != nil {
		t.Errorf("far is on the map; it should only be named on the entry edge")
	}
	var got []string
	for _, e := range m.Edges {
		if names[e.From] == "handleX" {
			got = append(got, names[e.To]+" via "+strings.Join(e.Via, ","))
		}
	}
	if want := []string{"helper via far"}; !slices.Equal(got, want) {
		t.Errorf("handleX edges = %v, want %v", got, want)
	}
}

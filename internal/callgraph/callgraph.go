// Package callgraph builds a map of changed Go and TypeScript declarations
// (functions, methods, types, constants and variables) and the code that
// uses them.
package callgraph

import (
	"cmp"
	"fmt"
	"go/ast"
	"go/token"
	"go/types"
	"maps"
	"os"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"

	"golang.org/x/tools/go/packages"

	"github.com/jpoz/map-pr/internal/gitdiff"
)

// Status tells why a node is on the map.
type Status string

const (
	StatusAdded    Status = "added"
	StatusModified Status = "modified"
	StatusCaller   Status = "caller"
	// StatusEntry marks an entry point that reaches the changes only through
	// code that is not on the map.
	StatusEntry Status = "entry"
)

// EntryKind tells how execution enters at a declaration.
type EntryKind string

const (
	EntryMain      EntryKind = "main"      // func main
	EntryHTTP      EntryKind = "http"      // an HTTP handler
	EntryGoroutine EntryKind = "goroutine" // started with a go statement
	// EntryModule is the top-level code of a TypeScript or JavaScript
	// module, which runs when the module is loaded.
	EntryModule EntryKind = "module"
	// EntryRoot is code with no callers in the repository: often a method
	// called through an interface, or a function called by reflection.
	EntryRoot EntryKind = "root"
)

// Entry describes how execution reaches a declaration from outside.
type Entry struct {
	Kind EntryKind `json:"kind"`
	// Routes are the route patterns a handler is registered with, when the
	// registration names it next to a string, as in mux.HandleFunc("GET /x", h).
	Routes []string `json:"routes,omitempty"`
}

// Kind is the kind of declaration a node is.
type Kind string

const (
	KindFunc   Kind = "func"
	KindMethod Kind = "method"
	KindType   Kind = "type"
	KindConst  Kind = "const"
	KindVar    Kind = "var"
	// KindModule is top-level code of a TypeScript or JavaScript file that
	// declares nothing, or a describe("...") or test("...") in a test file.
	KindModule Kind = "module"
)

// Node is one package-level declaration.
type Node struct {
	ID string `json:"id"`
	// Key names the node as "file:Name" so notes can refer to it.
	Key      string `json:"key"`
	Name     string `json:"name"`
	Kind     Kind   `json:"kind"`
	Package  string `json:"package"`
	File     string `json:"file"`
	Line     int    `json:"line"`
	EndLine  int    `json:"endLine"`
	Status   Status `json:"status"`
	Depth    int    `json:"depth"`
	IsTest   bool   `json:"isTest"`
	Exported bool   `json:"exported"`
	Source   string `json:"source"`
	Changed  []int  `json:"changed,omitempty"`
	// Removed holds the deleted lines inside the declaration, keyed by the
	// line they came before (EndLine+1 for lines deleted at its end).
	Removed  map[int][]string `json:"removed,omitempty"`
	Callers  int              `json:"callers"`
	Expanded bool             `json:"expanded"`
	// Hidden counts users left off the map because there were too many.
	Hidden int `json:"hidden,omitempty"`
	// Entry is set when execution starts here.
	Entry *Entry `json:"entry,omitempty"`
	// Top is set on a changed function that no other changed function
	// calls, directly or through other code: the place to start reading.
	Top bool `json:"top,omitempty"`
	// Locals groups the uses of each local name (variable, parameter,
	// constant, type or label) declared inside the declaration and used
	// more than once, so the page can mark them all together.
	Locals [][]Span `json:"locals,omitempty"`
}

// Span is a place in a file: a line, a 1-based column in bytes, and a length
// in bytes. It is sent as [line, col, len].
type Span [3]int

// Edge points from the declaration that uses a symbol to the symbol.
type Edge struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Lines []int  `json:"lines"`
	// Via, on an edge from an entry point, names the declarations not on the
	// map that the call passes through, from the entry point down. It is
	// empty, not nil, for a direct call, and nil on every other edge.
	Via []string `json:"via"`
}

// Map is the full PR map.
type Map struct {
	Repo       string            `json:"repo"`
	Base       string            `json:"base"`
	MergeBase  string            `json:"mergeBase"`
	Head       string            `json:"head"`
	Nodes      []*Node           `json:"nodes"`
	Edges      []*Edge           `json:"edges"`
	OtherFiles []string          `json:"otherFiles"`
	Deleted    []string          `json:"deleted"`
	Patches    map[string]string `json:"patches,omitempty"`
	// Stats holds the added and deleted line counts of each changed file.
	Stats map[string]gitdiff.FileStat `json:"stats,omitempty"`
	// Defs are declarations that code on the map uses but that are not on
	// the map themselves, so a reader can see their definitions.
	Defs []*Def `json:"defs,omitempty"`
	// Uses lists, for each node and def, the nodes and defs it uses and on
	// which lines, so the page can link a name to its definition.
	Uses map[string][]Use `json:"uses,omitempty"`
}

// Def is the definition of a declaration that is not on the map.
type Def struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Kind    Kind   `json:"kind"`
	File    string `json:"file"`
	Line    int    `json:"line"`
	EndLine int    `json:"endLine"`
	// Source holds at most maxDefLines lines.
	Source string `json:"source"`
}

// Use is a use of a declaration on some lines of another.
type Use struct {
	To    string `json:"to"`
	Lines []int  `json:"lines"`
}

// Options control how far the map reaches.
type Options struct {
	// Depth is how many levels of callers to follow from a changed function.
	Depth int
	// Tests includes _test.go files.
	Tests bool
}

// maxDeclUsers caps the users shown for a changed type, constant or
// variable. A changed struct can be used by hundreds of functions.
const maxDeclUsers = 10

type declInfo struct {
	node *Node
	// handler is true for a function with an HTTP handler's signature.
	handler bool
	// inner holds the first and last lines of declarations nested inside
	// this one that are nodes of their own, such as the methods of a
	// TypeScript class. Their changes are not changes of this declaration.
	inner [][2]int
}

// inside reports whether line l belongs to a declaration nested in d.
func (d *declInfo) inside(l int) bool {
	for _, r := range d.inner {
		if l >= r[0] && l <= r[1] {
			return true
		}
	}
	return false
}

type ref struct {
	from string
	line int
}

// scan is what reading the source of a repository finds: its declarations,
// the places that use each one, and how execution reaches them.
type scan struct {
	decls  map[string]*declInfo
	refs   map[string]map[ref]bool // callee ID -> places that use it
	locals map[string][][]Span     // declaration ID -> the uses of each local name
	routes map[string][]string     // handler ID -> route patterns
	// started holds the IDs of functions started with go.
	started map[string]bool
}

func newScan() *scan {
	return &scan{
		decls:   map[string]*declInfo{},
		refs:    map[string]map[ref]bool{},
		locals:  map[string][][]Span{},
		routes:  map[string][]string{},
		started: map[string]bool{},
	}
}

func (s *scan) addRef(to string, r ref) {
	if s.refs[to] == nil {
		s.refs[to] = map[ref]bool{}
	}
	s.refs[to][r] = true
}

// Build reads the Go and TypeScript code in the repository and makes the map.
// Go is read when the repository root holds a Go module; TypeScript and
// JavaScript are read when the PR changes such a file.
func Build(d *gitdiff.Diff, opts Options) (*Map, error) {
	s := newScan()
	goRepo := isGoRepo(d.Root)
	if goRepo {
		if err := scanGo(s, d.Root, opts); err != nil {
			return nil, err
		}
	}
	if changesTS(d) {
		if err := scanTS(s, d.Root, opts); err != nil {
			if !goRepo {
				return nil, err
			}
			// A Go repository can hold some scripts; map its Go code anyway.
			fmt.Fprintln(os.Stderr, "map-pr: skipping TypeScript:", err)
		}
		if goRepo {
			joinPackages(s)
		}
	}
	return build(d, s, opts), nil
}

// joinPackages puts TypeScript and JavaScript files that sit in the folder of
// a Go package into that package, so the map shows one package per folder.
func joinPackages(s *scan) {
	goPkg := map[string]string{}
	for _, d := range s.decls {
		if strings.HasSuffix(d.node.File, ".go") {
			goPkg[path.Dir(d.node.File)] = d.node.Package
		}
	}
	for _, d := range s.decls {
		if p, ok := goPkg[path.Dir(d.node.File)]; ok && isTSFile(d.node.File) {
			d.node.Package = p
		}
	}
}

// isGoRepo reports whether the repository root holds a Go module or workspace.
func isGoRepo(root string) bool {
	for _, name := range []string{"go.mod", "go.work"} {
		if _, err := os.Stat(filepath.Join(root, name)); err == nil {
			return true
		}
	}
	return false
}

// scanGo loads every Go package in the repository, with types, and adds its
// declarations to s.
func scanGo(s *scan, root string, opts Options) error {
	cfg := &packages.Config{
		Mode: packages.NeedName | packages.NeedFiles | packages.NeedSyntax |
			packages.NeedTypes | packages.NeedTypesInfo,
		Dir:   root,
		Tests: opts.Tests,
	}
	pkgs, err := packages.Load(cfg, "./...")
	if err != nil {
		return fmt.Errorf("load packages: %w", err)
	}
	packages.PrintErrors(pkgs)

	funcs := s.decls
	seenFiles := map[string]bool{}

	for _, pkg := range pkgs {
		for _, file := range pkg.Syntax {
			path := pkg.Fset.Position(file.Pos()).Filename
			if seenFiles[path] {
				// Test variants of a package hold the same files again.
				continue
			}
			seenFiles[path] = true
			rel := relPath(root, path)
			if rel == ".." || strings.HasPrefix(rel, "../") || filepath.IsAbs(rel) {
				// Generated files, such as a test binary's main, live outside the repository.
				continue
			}

			isTest := strings.HasSuffix(rel, "_test.go")
			add := func(obj types.Object, kind Kind, name string, start, end token.Pos) string {
				id := objID(pkg.Fset, obj)
				funcs[id] = &declInfo{node: &Node{
					ID:      id,
					Key:     rel + ":" + name,
					Name:    name,
					Kind:    kind,
					Package: pkg.PkgPath,
					File:    rel,
					Line:    pkg.Fset.Position(start).Line,
					EndLine: pkg.Fset.Position(end).Line,
					IsTest:  isTest,
					// Exported code can have users outside this
					// repository that the map cannot see.
					Exported: obj.Exported() && pkg.Name != "main" && !isTest,
				}}
				return id
			}
			// collect records each use of a package-level symbol inside n,
			// and the routes and go statements that start functions.
			collect := func(from string, n ast.Node) {
				if n == nil {
					return
				}
				ast.Inspect(n, func(n ast.Node) bool {
					switch n := n.(type) {
					case *ast.GoStmt:
						for _, id := range startedBy(pkg, n) {
							s.started[id] = true
						}
					case *ast.CallExpr:
						route, fns := routeOf(pkg, n)
						for _, id := range fns {
							s.routes[id] = append(s.routes[id], route)
						}
					}
					ident, ok := n.(*ast.Ident)
					if !ok {
						return true
					}
					used := symbol(pkg.TypesInfo.Uses[ident])
					if used == nil {
						return true
					}
					to := objID(pkg.Fset, used)
					if to == from {
						return true // skip recursion
					}
					s.addRef(to, ref{from: from, line: pkg.Fset.Position(ident.Pos()).Line})
					return true
				})
			}

			for _, decl := range file.Decls {
				switch decl := decl.(type) {
				case *ast.FuncDecl:
					obj, ok := pkg.TypesInfo.Defs[decl.Name].(*types.Func)
					if !ok {
						continue
					}
					kind := KindFunc
					if decl.Recv != nil {
						kind = KindMethod
					}
					id := add(obj, kind, funcName(obj), decl.Pos(), decl.End())
					funcs[id].handler = isHandler(obj)
					if obj.Name() == "main" && decl.Recv == nil && pkg.Name == "main" {
						funcs[id].node.Entry = &Entry{Kind: EntryMain}
					}
					s.locals[id] = slices.Collect(maps.Values(localsIn(pkg, decl)))
					// The receiver is left out: every method would otherwise use its own type.
					collect(id, decl.Type)
					if decl.Body != nil {
						collect(id, decl.Body)
					}
				case *ast.GenDecl:
					kind, ok := map[token.Token]Kind{token.TYPE: KindType, token.CONST: KindConst, token.VAR: KindVar}[decl.Tok]
					if !ok {
						continue
					}
					for _, spec := range decl.Specs {
						// A declaration with no parentheses starts at its keyword.
						start, end := spec.Pos(), spec.End()
						if !decl.Lparen.IsValid() {
							start, end = decl.Pos(), decl.End()
						}
						switch spec := spec.(type) {
						case *ast.TypeSpec:
							if obj := pkg.TypesInfo.Defs[spec.Name]; obj != nil {
								collect(add(obj, kind, spec.Name.Name, start, end), spec.Type)
							}
						case *ast.ValueSpec:
							for _, name := range spec.Names {
								obj := pkg.TypesInfo.Defs[name]
								if obj == nil || name.Name == "_" {
									continue
								}
								id := add(obj, kind, name.Name, start, end)
								collect(id, spec.Type)
								for _, v := range spec.Values {
									collect(id, v)
								}
							}
						}
					}
				}
			}
		}
	}
	return nil
}

// build makes the map from what a scan found.
func build(d *gitdiff.Diff, s *scan, opts Options) *Map {
	funcs, refs, locals := s.decls, s.refs, s.locals

	m := &Map{Repo: d.Root, Base: d.Base, MergeBase: d.MergeBase, Head: d.Head, Patches: d.Patches, Stats: d.Stats}

	// Find the changed functions.
	srcFiles := map[string]bool{}
	for _, f := range funcs {
		srcFiles[f.node.File] = true
	}
	var frontier []string
	onMap := map[string]bool{}
	for _, f := range funcs {
		fc, ok := d.Files[f.node.File]
		if !ok {
			continue
		}
		var changed []int
		own := 0
		for l := f.node.Line; l <= f.node.EndLine; l++ {
			if f.inside(l) {
				continue
			}
			own++
			if fc.Added || fc.Lines[l] {
				changed = append(changed, l)
			}
		}
		removed := removedIn(fc, f.node.Line, f.node.EndLine)
		maps.DeleteFunc(removed, func(l int, _ []string) bool { return f.inside(l) && f.inside(l-1) })
		if len(changed) == 0 && len(removed) == 0 {
			continue
		}
		f.node.Changed = changed
		f.node.Removed = removed
		f.node.Status = StatusModified
		if len(changed) == own && len(removed) == 0 {
			f.node.Status = StatusAdded
		}
		onMap[f.node.ID] = true
		frontier = append(frontier, f.node.ID)
	}
	for p, fc := range d.Files {
		switch {
		case fc.Deleted:
			m.Deleted = append(m.Deleted, p)
		case !srcFiles[p]:
			m.OtherFiles = append(m.OtherFiles, p)
		}
	}
	sort.Strings(m.OtherFiles)
	sort.Strings(m.Deleted)
	// The walk below prefers users already on the map, so its order must not
	// depend on map iteration.
	sort.Strings(frontier)

	// Walk out from the changed functions to the code that uses them.
	edges := map[[2]string]*Edge{}
	for depth := 1; depth <= opts.Depth && len(frontier) > 0; depth++ {
		var next []string
		for _, calleeID := range frontier {
			callee := funcs[calleeID].node
			callee.Expanded = true
			for _, r := range usersOf(callee, refs[calleeID], funcs, onMap) {
				caller, ok := funcs[r.from]
				if !ok {
					continue
				}
				key := [2]string{r.from, calleeID}
				e := edges[key]
				if e == nil {
					e = &Edge{From: r.from, To: calleeID}
					edges[key] = e
				}
				e.Lines = append(e.Lines, r.line)
				if !onMap[r.from] {
					onMap[r.from] = true
					caller.node.Status = StatusCaller
					caller.node.Depth = depth
					next = append(next, r.from)
				}
			}
		}
		frontier = next
	}

	entry := func(id string) *Entry {
		return entryOf(funcs[id], s.routes[id], s.started[id], refs[id], funcs)
	}
	for id := range onMap {
		funcs[id].node.Entry = entry(id)
	}
	for _, e := range pickEntries(reachFromEntries(onMap, funcs, refs, entry), edges, funcs, entry, maxEntries) {
		if !onMap[e.From] {
			onMap[e.From] = true
			n := funcs[e.From].node
			n.Status = StatusEntry
			n.Entry = entry(e.From)
		}
		key := [2]string{e.From, e.To}
		if edges[key] == nil {
			edges[key] = e
		}
	}

	for id := range onMap {
		n := funcs[id].node
		n.Source = readLines(filepath.Join(d.Root, n.File), n.Line, n.EndLine)
		n.Callers = countCallers(refs[id])
		n.Locals = localGroups(locals[id])
		m.Nodes = append(m.Nodes, n)
	}
	sort.Slice(m.Nodes, func(i, j int) bool { return m.Nodes[i].ID < m.Nodes[j].ID })
	markTops(m.Nodes, funcs, refs)

	for _, e := range edges {
		sort.Ints(e.Lines)
		m.Edges = append(m.Edges, e)
	}
	addDefs(m, d.Root, onMap, funcs, refs)
	shortenIDs(m, d.Root)
	sort.Slice(m.Edges, func(i, j int) bool {
		if m.Edges[i].To != m.Edges[j].To {
			return m.Edges[i].To < m.Edges[j].To
		}
		return m.Edges[i].From < m.Edges[j].From
	})
	return m
}

// localsIn finds every use of each local name in a function, its receiver
// and parameters included.
func localsIn(pkg *packages.Package, decl *ast.FuncDecl) map[types.Object][]Span {
	uses := map[types.Object][]Span{}
	ast.Inspect(decl, func(n ast.Node) bool {
		ident, ok := n.(*ast.Ident)
		if !ok {
			return true
		}
		if obj := localObject(pkg, ident); obj != nil {
			p := pkg.Fset.Position(ident.Pos())
			uses[obj] = append(uses[obj], Span{p.Line, p.Column, len(ident.Name)})
		}
		return true
	})
	return uses
}

// localObject returns the object an identifier names when that object is
// declared inside a function: a variable or parameter (not a struct field),
// a constant, a type or a label. It returns nil for anything else.
func localObject(pkg *packages.Package, ident *ast.Ident) types.Object {
	obj := pkg.TypesInfo.Defs[ident]
	if obj == nil {
		obj = pkg.TypesInfo.Uses[ident]
	}
	if obj == nil || obj.Pkg() != pkg.Types || ident.Name == "_" {
		return nil
	}
	switch o := obj.(type) {
	case *types.Var:
		if o.IsField() {
			return nil
		}
	case *types.Label:
		return obj // a label's scope is its function, not a block
	case *types.Const, *types.TypeName:
	default:
		return nil
	}
	if p := obj.Parent(); p == nil || p == pkg.Types.Scope() {
		return nil
	}
	return obj
}

// localGroups orders the uses of each local by place and keeps the locals
// used more than once, in the order they are first used.
func localGroups(uses [][]Span) [][]Span {
	var groups [][]Span
	for _, spans := range uses {
		if len(spans) < 2 {
			continue
		}
		slices.SortFunc(spans, func(a, b Span) int { return cmp.Or(a[0]-b[0], a[1]-b[1]) })
		groups = append(groups, slices.Compact(spans))
	}
	slices.SortFunc(groups, func(a, b []Span) int { return cmp.Or(a[0][0]-b[0][0], a[0][1]-b[0][1]) })
	return groups
}

// removedIn returns the lines deleted inside the declaration on lines
// first to last. Lines deleted just before first belong to it only when first
// changed too (its old first lines were replaced); else they were above it.
// Lines deleted just after last belong to it only when last is a new line.
func removedIn(fc *gitdiff.FileChange, first, last int) map[int][]string {
	var out map[int][]string
	for l, text := range fc.Removed {
		inside := l > first && l <= last ||
			l == first && fc.Lines[first] ||
			l == last+1 && fc.Lines[last]
		if !inside {
			continue
		}
		if out == nil {
			out = map[int][]string{}
		}
		out[l] = text
	}
	return out
}

// markTops sets Top on the changed functions outside tests that no other
// changed function reaches through calls anywhere in the repository. Two
// changed functions that reach each other are at the same level.
func markTops(nodes []*Node, decls map[string]*declInfo, refs map[string]map[ref]bool) {
	changed := map[string]*Node{}
	for _, n := range nodes {
		if (n.Status == StatusAdded || n.Status == StatusModified) && !n.IsTest && (n.Kind == KindFunc || n.Kind == KindMethod) {
			changed[n.ID] = n
		}
	}
	// above[id] holds the changed functions that reach id.
	above := map[string]map[string]bool{}
	for id := range changed {
		above[id] = map[string]bool{}
		seen := map[string]bool{id: true}
		for frontier := []string{id}; len(frontier) > 0; {
			var next []string
			for _, to := range frontier {
				for r := range refs[to] {
					if seen[r.from] {
						continue
					}
					seen[r.from] = true
					if d := decls[r.from]; d == nil || d.node.IsTest {
						continue
					}
					if changed[r.from] != nil {
						above[id][r.from] = true
					}
					next = append(next, r.from)
				}
			}
			frontier = next
		}
	}
	for id, n := range changed {
		n.Top = true
		for a := range above[id] {
			if !above[a][id] {
				n.Top = false
				break
			}
		}
	}
}

// shortenIDs makes node IDs relative to the repository root. An ID is a
// declaration's file position; the absolute path is long and the same in
// every ID.
func shortenIDs(m *Map, root string) {
	prefix := filepath.ToSlash(root) + "/"
	short := func(id string) string { return strings.TrimPrefix(filepath.ToSlash(id), prefix) }
	for _, n := range m.Nodes {
		n.ID = short(n.ID)
	}
	for _, d := range m.Defs {
		d.ID = short(d.ID)
	}
	for _, e := range m.Edges {
		e.From, e.To = short(e.From), short(e.To)
	}
	uses := make(map[string][]Use, len(m.Uses))
	for from, us := range m.Uses {
		for i := range us {
			us[i].To = short(us[i].To)
		}
		uses[short(from)] = us
	}
	m.Uses = uses
}

// maxDefLines caps the source kept for a def; a reader who needs more opens the file.
const maxDefLines = 80

// addDefs adds to m the declarations outside tests that nodes on the map
// use but that are not on the map, and records what each node and def uses.
func addDefs(m *Map, root string, onMap map[string]bool, decls map[string]*declInfo, refs map[string]map[ref]bool) {
	uses := map[string]map[string][]int{} // from -> to -> lines
	for to, rs := range refs {
		if _, ok := decls[to]; !ok {
			continue
		}
		for r := range rs {
			if uses[r.from] == nil {
				uses[r.from] = map[string][]int{}
			}
			uses[r.from][to] = append(uses[r.from][to], r.line)
		}
	}
	defs := map[string]bool{}
	for id := range onMap {
		for to := range uses[id] {
			if !onMap[to] && !decls[to].node.IsTest {
				defs[to] = true
			}
		}
	}
	for id := range defs {
		n := decls[id].node
		end := min(n.EndLine, n.Line+maxDefLines-1)
		m.Defs = append(m.Defs, &Def{
			ID: n.ID, Name: n.Name, Kind: n.Kind, File: n.File, Line: n.Line, EndLine: n.EndLine,
			Source: readLines(filepath.Join(root, n.File), n.Line, end),
		})
	}
	sort.Slice(m.Defs, func(i, j int) bool { return m.Defs[i].ID < m.Defs[j].ID })

	m.Uses = map[string][]Use{}
	for from, tos := range uses {
		if !onMap[from] && !defs[from] {
			continue
		}
		for to, lines := range tos {
			if onMap[to] || defs[to] {
				sort.Ints(lines)
				m.Uses[from] = append(m.Uses[from], Use{To: to, Lines: slices.Compact(lines)})
			}
		}
		sort.Slice(m.Uses[from], func(i, j int) bool { return m.Uses[from][i].To < m.Uses[from][j].To })
	}
}

// maxEntryHops is how many declarations off the map a walk up from the map
// passes through to find an entry point.
const maxEntryHops = 8

// reachFromEntries walks up from each declaration on the map, through
// callers that are not on the map, to the nearest entry points. It returns
// one edge from each entry point found to the declaration it reaches, with
// the declarations in between. A walk stops at an entry point and at
// another declaration on the map, which makes its own walk.
func reachFromEntries(onMap map[string]bool, decls map[string]*declInfo, refs map[string]map[ref]bool, entryOf func(string) *Entry) []*Edge {
	// A walk follows calls: it starts at functions and methods, and a type
	// that names one does not call it.
	isFunc := func(id string) bool { k := decls[id].node.Kind; return k == KindFunc || k == KindMethod }
	starts := make([]string, 0, len(onMap))
	for id := range onMap {
		if !decls[id].node.IsTest && isFunc(id) && entryOf(id) == nil {
			starts = append(starts, id)
		}
	}
	sort.Strings(starts)
	var out []*Edge
	for _, start := range starts {
		parent := map[string]string{start: ""}
		frontier := []string{start}
		for hop := 0; hop <= maxEntryHops && len(frontier) > 0; hop++ {
			var next []string
			for _, id := range frontier {
				for _, from := range callerIDs(refs[id], decls) {
					if _, seen := parent[from]; seen || onMap[from] || decls[from].node.Kind == KindType {
						continue
					}
					parent[from] = id
					if entryOf(from) != nil {
						via := []string{}
						for p := id; p != start; p = parent[p] {
							via = append(via, decls[p].node.Name)
						}
						out = append(out, &Edge{From: from, To: start, Via: via})
						continue
					}
					next = append(next, from)
				}
			}
			frontier = next
		}
	}
	return out
}

// maxEntries caps the entry points added to the map.
const maxEntries = 20

// pickEntries keeps few entry points off the map that together reach every
// change any of them reaches. Changes that an entry point already on the map
// reaches count as reached. Each pick is the entry point that reaches the most
// changes not yet reached; an HTTP route, main or goroutine wins a tie over
// code with no callers. It returns the edges of the picked entry points.
func pickEntries(cands []*Edge, edges map[[2]string]*Edge, decls map[string]*declInfo, entry func(string) *Entry, limit int) []*Edge {
	down := map[string][]string{}
	for _, e := range edges {
		down[e.From] = append(down[e.From], e.To)
	}
	byEntry := map[string][]*Edge{}
	for _, e := range cands {
		byEntry[e.From] = append(byEntry[e.From], e)
	}
	// reach lists the changes reachable down from the given starts.
	reach := func(starts []string) map[string]bool {
		out, seen := map[string]bool{}, map[string]bool{}
		stack := slices.Clone(starts)
		for len(stack) > 0 {
			id := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if seen[id] {
				continue
			}
			seen[id] = true
			if n := decls[id].node; (n.Status == StatusAdded || n.Status == StatusModified) && n.Kind != KindType {
				out[id] = true
			}
			stack = append(stack, down[id]...)
		}
		return out
	}

	reached := map[string]bool{}
	for from := range down {
		if decls[from].node.Status != StatusEntry && entry(from) != nil {
			maps.Copy(reached, reach([]string{from}))
		}
	}
	gain := map[string]map[string]bool{}
	for from, es := range byEntry {
		var tos []string
		for _, e := range es {
			tos = append(tos, e.To)
		}
		gain[from] = reach(tos)
	}
	rank := func(id string) int {
		if entry(id).Kind == EntryRoot {
			return 1
		}
		return 0
	}
	var out []*Edge
	for range limit {
		best, bestN := "", 0
		for from, g := range gain {
			n := 0
			for id := range g {
				if !reached[id] {
					n++
				}
			}
			if n == 0 {
				continue
			}
			if best == "" || n > bestN || (n == bestN && (rank(from) < rank(best) || (rank(from) == rank(best) && from < best))) {
				best, bestN = from, n
			}
		}
		if best == "" {
			break
		}
		// Of the picked entry point's edges, keep the fewest that reach its
		// new changes, the edge that reaches the most first.
		want := map[string]bool{}
		for id := range gain[best] {
			if !reached[id] {
				want[id] = true
			}
		}
		es := slices.Clone(byEntry[best])
		for len(want) > 0 && len(es) > 0 {
			bi, bn := -1, 0
			for i, e := range es {
				n := 0
				for id := range reach([]string{e.To}) {
					if want[id] {
						n++
					}
				}
				if n > bn || (n == bn && bi >= 0 && len(e.Via) < len(es[bi].Via)) {
					bi, bn = i, n
				}
			}
			if bi < 0 {
				break
			}
			for id := range reach([]string{es[bi].To}) {
				delete(want, id)
			}
			out = append(out, es[bi])
			es = slices.Delete(es, bi, bi+1)
		}
		maps.Copy(reached, gain[best])
		delete(gain, best)
	}
	return out
}

// callerIDs lists the declarations outside tests that use a declaration.
func callerIDs(rs map[ref]bool, decls map[string]*declInfo) []string {
	seen := map[string]bool{}
	var ids []string
	for r := range rs {
		if d, ok := decls[r.from]; ok && !d.node.IsTest && !seen[r.from] {
			seen[r.from] = true
			ids = append(ids, r.from)
		}
	}
	sort.Strings(ids)
	return ids
}

// entryOf tells whether execution starts at a declaration, and how.
func entryOf(d *declInfo, routes []string, started bool, rs map[ref]bool, decls map[string]*declInfo) *Entry {
	n := d.node
	switch {
	case n.IsTest:
		return nil
	case n.Entry != nil && (n.Entry.Kind == EntryMain || n.Entry.Kind == EntryModule):
		return n.Entry
	case n.Kind != KindFunc && n.Kind != KindMethod:
		return nil
	case d.handler || len(routes) > 0:
		routes = slices.Clone(routes)
		slices.Sort(routes)
		return &Entry{Kind: EntryHTTP, Routes: slices.Compact(routes)}
	case started:
		return &Entry{Kind: EntryGoroutine}
	case len(callerIDs(rs, decls)) == 0 && n.Name != "init":
		return &Entry{Kind: EntryRoot}
	}
	return nil
}

// isHandler reports whether fn has the signature of an http.HandlerFunc.
func isHandler(fn *types.Func) bool {
	sig := fn.Type().(*types.Signature)
	if sig.Params().Len() != 2 || sig.Results().Len() != 0 {
		return false
	}
	return types.TypeString(sig.Params().At(0).Type(), nil) == "net/http.ResponseWriter" &&
		types.TypeString(sig.Params().At(1).Type(), nil) == "*net/http.Request"
}

// routeOf finds a route registration: a call with a string literal argument
// that looks like a route and, in another argument, a function with a
// handler's signature, as in mux.HandleFunc("POST /x", s.auth(s.handleX)).
// It returns the route and the IDs of those functions.
func routeOf(pkg *packages.Package, call *ast.CallExpr) (string, []string) {
	route := ""
	for _, arg := range call.Args {
		if lit, ok := arg.(*ast.BasicLit); ok && lit.Kind == token.STRING {
			if s, err := strconv.Unquote(lit.Value); err == nil && looksLikeRoute(s) {
				route = s
				break
			}
		}
	}
	if route == "" {
		return "", nil
	}
	var ids []string
	for _, arg := range call.Args {
		ast.Inspect(arg, func(n ast.Node) bool {
			if _, ok := n.(*ast.FuncLit); ok {
				return false
			}
			ident, ok := n.(*ast.Ident)
			if !ok {
				return true
			}
			if fn, ok := pkg.TypesInfo.Uses[ident].(*types.Func); ok && isHandler(fn) {
				ids = append(ids, objID(pkg.Fset, fn.Origin()))
			}
			return true
		})
	}
	return route, ids
}

// looksLikeRoute accepts patterns like "/x", "GET /x" and "example.com/x/".
func looksLikeRoute(s string) bool {
	if _, rest, ok := strings.Cut(s, " "); ok {
		s = rest
	}
	return strings.Contains(s, "/") && !strings.ContainsAny(s, " \t\n")
}

// startedBy returns the IDs of the functions a go statement starts: the
// function it calls, or the calls at the top level of a function literal.
func startedBy(pkg *packages.Package, g *ast.GoStmt) []string {
	calls := []*ast.CallExpr{g.Call}
	if lit, ok := g.Call.Fun.(*ast.FuncLit); ok {
		calls = nil
		for _, st := range lit.Body.List {
			if es, ok := st.(*ast.ExprStmt); ok {
				if c, ok := es.X.(*ast.CallExpr); ok {
					calls = append(calls, c)
				}
			}
		}
	}
	var ids []string
	for _, c := range calls {
		var ident *ast.Ident
		switch f := c.Fun.(type) {
		case *ast.Ident:
			ident = f
		case *ast.SelectorExpr:
			ident = f.Sel
		}
		if ident == nil {
			continue
		}
		if fn, ok := pkg.TypesInfo.Uses[ident].(*types.Func); ok {
			ids = append(ids, objID(pkg.Fset, fn.Origin()))
		}
	}
	return ids
}

// usersOf lists the places that use a node, in a stable order. For a type,
// constant or variable it keeps the users of at most maxDeclUsers
// declarations, preferring ones already on the map and code over tests, and
// counts the rest in Hidden.
func usersOf(n *Node, rs map[ref]bool, decls map[string]*declInfo, onMap map[string]bool) []ref {
	list := make([]ref, 0, len(rs))
	for r := range rs {
		if _, ok := decls[r.from]; ok {
			list = append(list, r)
		}
	}
	rank := func(r ref) int {
		switch {
		case onMap[r.from]:
			return 0
		case !decls[r.from].node.IsTest:
			return 1
		}
		return 2
	}
	sort.Slice(list, func(i, j int) bool {
		a, b := list[i], list[j]
		if ra, rb := rank(a), rank(b); ra != rb {
			return ra < rb
		}
		if a.from != b.from {
			return a.from < b.from
		}
		return a.line < b.line
	})
	if n.Kind == KindFunc || n.Kind == KindMethod {
		return list
	}
	keep := map[string]bool{}
	var out []ref
	for _, r := range list {
		if !keep[r.from] && len(keep) == maxDeclUsers {
			continue
		}
		keep[r.from] = true
		out = append(out, r)
	}
	n.Hidden = countCallers(rs) - len(keep)
	return out
}

// symbol returns the package-level declaration obj refers to, or nil for
// anything else (locals, fields, imports, builtins).
func symbol(obj types.Object) types.Object {
	if obj == nil || obj.Pkg() == nil || obj.Parent() != obj.Pkg().Scope() {
		if fn, ok := obj.(*types.Func); ok {
			return fn.Origin() // methods have no parent scope
		}
		return nil
	}
	switch obj := obj.(type) {
	case *types.Func:
		return obj.Origin()
	case *types.TypeName, *types.Const:
		return obj
	case *types.Var:
		return obj.Origin()
	}
	return nil
}

// objID names a declaration by where it is declared, so the same function
// seen in a package and in its test variant gets one ID.
func objID(fset *token.FileSet, obj types.Object) string {
	pos := fset.Position(obj.Pos())
	return fmt.Sprintf("%s:%d:%d", pos.Filename, pos.Line, pos.Column)
}

func funcName(fn *types.Func) string {
	sig := fn.Type().(*types.Signature)
	recv := sig.Recv()
	if recv == nil {
		return fn.Name()
	}
	t := recv.Type()
	ptr := ""
	if p, ok := t.(*types.Pointer); ok {
		ptr, t = "*", p.Elem()
	}
	name := t.String()
	if n, ok := t.(*types.Named); ok {
		name = n.Obj().Name()
	}
	return fmt.Sprintf("(%s%s).%s", ptr, name, fn.Name())
}

func countCallers(rs map[ref]bool) int {
	seen := map[string]bool{}
	for r := range rs {
		seen[r.from] = true
	}
	return len(seen)
}

func relPath(root, path string) string {
	if p, err := filepath.EvalSymlinks(path); err == nil {
		path = p
	}
	if rel, err := filepath.Rel(root, path); err == nil {
		return filepath.ToSlash(rel)
	}
	return path
}

func readLines(path string, start, end int) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	lines := strings.Split(string(b), "\n")
	if start < 1 || start > len(lines) {
		return ""
	}
	end = min(end, len(lines))
	return strings.Join(lines[start-1:end], "\n")
}

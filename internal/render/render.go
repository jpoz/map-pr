// Package render writes a PR map as JSON, as a text outline, or as a self-contained HTML page.
package render

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"slices"
	"sort"
	"strings"

	"github.com/jpoz/map-pr/internal/callgraph"
	"github.com/jpoz/map-pr/internal/notes"
)

// The page is a shell (index.html) with two scripts: the zoomable map
// engine and the app that joins it to the side panel.
var (
	//go:embed page/index.html
	pageHTML string
	//go:embed page/engine.js
	engineJS string
	//go:embed page/app.js
	appJS string
)

var page = template.Must(template.New("map").Parse(pageHTML))

// JSON writes the map as indented JSON.
func JSON(w io.Writer, m *callgraph.Map) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(m)
}

// HTML writes the map as one HTML page with the data inside it. n may be nil.
func HTML(w io.Writer, m *callgraph.Map, n *notes.Notes) error {
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	notesData, err := json.Marshal(n)
	if err != nil {
		return err
	}
	// html/template escapes the JSON correctly for a <script> context.
	return page.Execute(w, map[string]any{
		"Data":   template.JS(data),
		"Notes":  template.JS(notesData),
		"Engine": template.JS(engineJS),
		"App":    template.JS(appJS),
	})
}

// writeEntries lists the entry points: where execution starts and reaches
// the changes, which makes a good place to start a review.
func writeEntries(p func(string, ...any), m *callgraph.Map, byID map[string]*callgraph.Node) {
	var entries []*callgraph.Node
	for _, n := range m.Nodes {
		if n.Entry != nil {
			entries = append(entries, n)
		}
	}
	if len(entries) == 0 {
		return
	}
	sort.Slice(entries, func(i, j int) bool {
		a, b := entries[i], entries[j]
		if a.Entry.Kind != b.Entry.Kind {
			return a.Entry.Kind < b.Entry.Kind
		}
		return a.Key < b.Key
	})
	p("\nENTRY POINTS (key, how execution enters, status)\n")
	for _, n := range entries {
		how := string(n.Entry.Kind)
		switch n.Entry.Kind {
		case callgraph.EntryHTTP:
			if len(n.Entry.Routes) > 0 {
				how += " " + strings.Join(n.Entry.Routes, ", ")
			}
		case callgraph.EntryRoot:
			how = "no callers outside tests (an interface, reflection, or not used yet)"
		}
		p("  %s  [%s] %s\n", n.Key, n.Status, how)
		for _, e := range m.Edges {
			if e.From == n.ID && n.Status == callgraph.StatusEntry {
				path := append(slices.Clone(e.Via), byID[e.To].Key)
				p("      -> %s\n", strings.Join(path, " -> "))
			}
		}
	}
}

// Outline writes a short text view of the map for a reader who will explain
// the PR. It lists node keys, so the reader can refer to them in notes.
func Outline(w io.Writer, m *callgraph.Map) error {
	byID := map[string]*callgraph.Node{}
	for _, n := range m.Nodes {
		byID[n.ID] = n
	}
	callers := map[string][]*callgraph.Edge{}
	for _, e := range m.Edges {
		callers[e.To] = append(callers[e.To], e)
	}

	var changedCode, changedTests, otherCallers []*callgraph.Node
	for _, n := range m.Nodes {
		switch {
		case n.Status == callgraph.StatusCaller && !n.IsTest:
			otherCallers = append(otherCallers, n)
		case n.Status == callgraph.StatusCaller, n.Status == callgraph.StatusEntry:
		case n.IsTest:
			changedTests = append(changedTests, n)
		default:
			changedCode = append(changedCode, n)
		}
	}
	byKey := func(ns []*callgraph.Node) {
		sort.Slice(ns, func(i, j int) bool { return ns[i].Key < ns[j].Key })
	}
	byKey(changedCode)
	byKey(changedTests)
	byKey(otherCallers)

	p := func(format string, args ...any) { fmt.Fprintf(w, format, args...) }
	p("PR map: %s (merge base %.7s) -> %s + work tree\n", m.Base, m.MergeBase, m.Head)
	p("%d changed declarations, %d changed tests, %d unchanged users\n\n", len(changedCode), len(changedTests), len(otherCallers))

	p("CHANGED DECLARATIONS (key, kind, status, changed lines / total lines)\n")
	for _, n := range changedCode {
		flags := ""
		if n.Exported {
			flags = " exported"
		}
		p("  %s  [%s %s%s] %d/%d lines\n", n.Key, n.Kind, n.Status, flags, len(n.Changed), n.EndLine-n.Line+1)
		tests := 0
		for _, e := range callers[n.ID] {
			from := byID[e.From]
			if from.IsTest {
				tests++
				continue
			}
			p("      <- %s\n", from.Key)
		}
		if tests > 0 {
			p("      <- %d tests\n", tests)
		}
		if n.Hidden > 0 {
			p("      <- %d more not on the map\n", n.Hidden)
		}
	}

	writeEntries(p, m, byID)

	if len(otherCallers) > 0 {
		p("\nUNCHANGED USERS OF CHANGED CODE\n")
		for _, n := range otherCallers {
			p("  %s\n", n.Key)
		}
	}
	if len(changedTests) > 0 {
		p("\nCHANGED TESTS\n")
		for _, n := range changedTests {
			p("  %s  [%s]\n", n.Key, n.Status)
		}
	}

	if len(m.OtherFiles) > 0 {
		p("\nOTHER CHANGED FILES (not Go)\n")
		for _, f := range m.OtherFiles {
			p("  %s\n", f)
		}
	}
	if len(m.Deleted) > 0 {
		p("\nDELETED FILES\n")
		for _, f := range m.Deleted {
			p("  %s\n", f)
		}
	}
	return nil
}

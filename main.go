// Command map-pr draws a map of a PR: the Go and TypeScript functions it
// changes and the code that uses them.
//
// map-pr serve, map-pr comments and map-pr reply serve a map with questions a
// reader drops on it, list those questions, and answer them.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"

	"github.com/jpoz/map-pr/internal/callgraph"
	"github.com/jpoz/map-pr/internal/gitdiff"
	"github.com/jpoz/map-pr/internal/notes"
	"github.com/jpoz/map-pr/internal/render"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "map-pr:", err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "serve":
			return serve(os.Args[2:])
		case "comments":
			return listComments(os.Args[2:])
		case "reply":
			return replyComment(os.Args[2:])
		}
	}
	var (
		dir       = flag.String("C", ".", "repository directory")
		base      = flag.String("base", "main", "base ref of the PR")
		depth     = flag.Int("depth", 1, "levels of callers to follow")
		tests     = flag.Bool("tests", true, "include _test.go files")
		format    = flag.String("format", "html", "output format: html, json, or outline")
		out       = flag.String("o", "pr-map.html", `output file ("-" for stdout)`)
		from      = flag.String("from", "", "read the map from this JSON file instead of analyzing the repository")
		notesPath = flag.String("notes", "", "JSON file with themes, a tour, and node notes to show on the HTML map")
		open      = flag.Bool("open", false, "open the HTML map in a browser")
	)
	flag.Parse()

	m, err := loadMap(*from, *dir, *base, callgraph.Options{Depth: *depth, Tests: *tests})
	if err != nil {
		return err
	}

	var n *notes.Notes
	if *notesPath != "" {
		if n, err = notes.Load(*notesPath); err != nil {
			return err
		}
		if problems := n.Check(m); len(problems) > 0 {
			for _, p := range problems {
				fmt.Fprintln(os.Stderr, "map-pr: notes:", p)
			}
			return fmt.Errorf("%d problems in %s", len(problems), *notesPath)
		}
	}

	var w io.Writer = os.Stdout
	if *out != "-" {
		f, err := os.Create(*out)
		if err != nil {
			return err
		}
		defer f.Close()
		w = f
	}

	switch *format {
	case "html":
		err = render.HTML(w, m, n)
	case "json":
		err = render.JSON(w, m)
	case "outline":
		err = render.Outline(w, m)
	default:
		return fmt.Errorf("unknown format %q", *format)
	}
	if err != nil {
		return err
	}

	if *out != "-" {
		fmt.Fprintf(os.Stderr, "wrote %s (%d nodes, %d edges)\n", *out, len(m.Nodes), len(m.Edges))
		if *open && *format == "html" {
			return openBrowser(*out)
		}
	}
	return nil
}

func loadMap(from, dir, base string, opts callgraph.Options) (*callgraph.Map, error) {
	if from != "" {
		b, err := os.ReadFile(from)
		if err != nil {
			return nil, err
		}
		var m callgraph.Map
		if err := json.Unmarshal(b, &m); err != nil {
			return nil, fmt.Errorf("parse %s: %w", from, err)
		}
		return &m, nil
	}
	d, err := gitdiff.Load(dir, base)
	if err != nil {
		return nil, err
	}
	return callgraph.Build(d, opts)
}

func openBrowser(path string) error {
	cmd := "xdg-open"
	if runtime.GOOS == "darwin" {
		cmd = "open"
	}
	return exec.Command(cmd, path).Start()
}

// Package notes holds the explanation a reviewer (usually Claude) writes on top of a PR map.
package notes

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"

	"github.com/jpoz/map-pr/internal/callgraph"
)

// Notes explains a PR. Nodes are named by their callgraph key ("file:Name").
type Notes struct {
	Title string `json:"title"`
	// URL is the PR's web page; the page's title links to it.
	URL     string            `json:"url,omitempty"`
	Summary string            `json:"summary"`
	Themes  []Theme           `json:"themes"`
	Tour    []Step            `json:"tour"`
	Nodes   map[string]string `json:"nodes"`
}

// Theme is one part of the PR's change.
type Theme struct {
	ID      string   `json:"id"`
	Title   string   `json:"title"`
	Summary string   `json:"summary"`
	Nodes   []string `json:"nodes"`
	Files   []string `json:"files,omitempty"`
}

// Step is one stop on the guided tour.
type Step struct {
	Title string   `json:"title"`
	Body  string   `json:"body"`
	Theme string   `json:"theme,omitempty"`
	Nodes []string `json:"nodes"`
	Files []string `json:"files,omitempty"`
}

// Load reads notes from a JSON file.
func Load(path string) (*Notes, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var n Notes
	if err := json.Unmarshal(b, &n); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	return &n, nil
}

// Check returns a problem for each reference that is not on the map.
func (n *Notes) Check(m *callgraph.Map) []string {
	keys := map[string]bool{}
	for _, node := range m.Nodes {
		keys[node.Key] = true
	}
	themes := map[string]bool{}
	for _, t := range n.Themes {
		themes[t.ID] = true
	}

	var problems []string
	if n.URL != "" {
		if u, err := url.Parse(n.URL); err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			problems = append(problems, fmt.Sprintf("url: %q is not an http or https link", n.URL))
		}
	}
	unknown := func(where, key string) {
		if !keys[key] {
			problems = append(problems, fmt.Sprintf("%s: node %q is not on the map", where, key))
		}
	}
	// Maps saved before patches were kept have none, so there is nothing to check against.
	unknownFile := func(where, path string) {
		if _, ok := m.Patches[path]; !ok && m.Patches != nil {
			problems = append(problems, fmt.Sprintf("%s: file %q is not changed in this PR", where, path))
		}
	}
	for _, t := range n.Themes {
		for _, k := range t.Nodes {
			unknown("theme "+t.ID, k)
		}
		for _, f := range t.Files {
			unknownFile("theme "+t.ID, f)
		}
	}
	for i, s := range n.Tour {
		where := fmt.Sprintf("tour step %d", i+1)
		for _, k := range s.Nodes {
			unknown(where, k)
		}
		for _, f := range s.Files {
			unknownFile(where, f)
		}
		if s.Theme != "" && !themes[s.Theme] {
			problems = append(problems, fmt.Sprintf("%s: theme %q does not exist", where, s.Theme))
		}
	}
	for k := range n.Nodes {
		unknown("nodes", k)
	}
	return problems
}

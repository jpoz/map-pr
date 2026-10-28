package notes

import (
	"slices"
	"testing"

	"github.com/jpoz/map-pr/internal/callgraph"
)

func TestCheck(t *testing.T) {
	m := &callgraph.Map{
		Nodes:   []*callgraph.Node{{Key: "a.go:A"}, {Key: "a.go:B"}},
		Patches: map[string]string{"x.sql": "@@ -1 +1 @@"},
	}
	n := &Notes{
		URL:    "javascript:alert(1)",
		Themes: []Theme{{ID: "t", Nodes: []string{"a.go:A", "a.go:Missing"}, Files: []string{"x.sql", "y.sql"}}},
		Tour: []Step{
			{Theme: "t", Nodes: []string{"a.go:B"}},
			{Theme: "nope"},
		},
		Nodes: map[string]string{"a.go:A": "ok", "b.go:C": "gone"},
	}

	got := n.Check(m)
	slices.Sort(got)
	want := []string{
		`nodes: node "b.go:C" is not on the map`,
		`theme t: file "y.sql" is not changed in this PR`,
		`theme t: node "a.go:Missing" is not on the map`,
		`tour step 2: theme "nope" does not exist`,
		`url: "javascript:alert(1)" is not an http or https link`,
	}
	if !slices.Equal(got, want) {
		t.Errorf("Check() =\n%q\nwant\n%q", got, want)
	}
}

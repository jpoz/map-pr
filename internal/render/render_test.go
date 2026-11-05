package render

import (
	"testing"

	"github.com/jpoz/map-pr/internal/callgraph"
)

func TestDiffIDs(t *testing.T) {
	m := &callgraph.Map{
		Patches: map[string]string{"internal/server/bots_children.go": "@@ -1 +1 @@"},
		Deleted: []string{"old.go"},
	}
	got := diffIDs(m)
	// GitHub names a file's diff in a PR "diff-" and the SHA-256 of its path.
	want := "diff-df36465d048ac046f66c668cb9fd6d9e9933684eccbe420e79cb49987b8d14ba"
	if got["internal/server/bots_children.go"] != want {
		t.Errorf("diffIDs()[bots_children.go] = %q, want %q", got["internal/server/bots_children.go"], want)
	}
	if _, ok := got["old.go"]; !ok {
		t.Errorf("diffIDs() has no anchor for the deleted file old.go")
	}
	if len(got) != 2 {
		t.Errorf("diffIDs() has %d anchors, want 2", len(got))
	}
}

package callgraph

import (
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"testing"

	"github.com/jpoz/map-pr/internal/gitdiff"
)

const testMigration = `-- Bots and their events.
-- +goose Up
-- +goose StatementBegin
SET LOCAL lock_timeout = '5s';

ALTER TABLE workspaces ADD COLUMN always_on BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE bots (
    id   UUID PRIMARY KEY,
    -- a comment; with a semicolon
    name TEXT NOT NULL CHECK (name ~ '^[a-z;]+$')
);

CREATE UNIQUE INDEX bots_name_uniq ON bots (name);

CREATE FUNCTION touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

-- +goose Down
DROP TABLE bots;
`

func TestSplitSQL(t *testing.T) {
	var got []string
	for _, st := range splitSQL(testMigration) {
		d, ok := classifySQL(st.code)
		if !ok {
			continue
		}
		got = append(got, d.name+" "+string(d.kind)+" "+strconv.Itoa(st.start)+"-"+strconv.Itoa(st.end))
	}
	want := []string{
		"ALTER workspaces table 6-6",
		"bots table 8-12",
		"UNIQUE INDEX bots_name_uniq sql 14-14",
		"FUNCTION touch sql 16-21",
	}
	if !slices.Equal(got, want) {
		t.Errorf("statements:\n got %q\nwant %q", got, want)
	}
}

func TestBareName(t *testing.T) {
	for in, want := range map[string]string{`bots`: "bots", `public.bots`: "bots", `"Bots"`: "Bots", `public."My.Bots"`: "My.Bots"} {
		if got := bareName(in); got != want {
			t.Errorf("bareName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestIsMigration(t *testing.T) {
	for p, want := range map[string]bool{
		"internal/store/migrations/1_bots.sql": true,
		"db/migrate/2_x.up.sql":                true,
		"db/migrate/2_x.down.sql":              false,
		"internal/store/queries/bots.sql":      false,
		"migrations/README.md":                 false,
	} {
		if got := isMigration(p); got != want {
			t.Errorf("isMigration(%q) = %v, want %v", p, got, want)
		}
	}
}

// TestMigrationUsers checks that a migration's tables link to the code that
// uses them in SQL, and an added column to the code that names it.
func TestMigrationUsers(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, name)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("go.mod", "module example.com/a\n\ngo 1.22\n")
	write("migrations/1_bots.sql", testMigration)
	write("q.go", `package a

const insertBot = "INSERT INTO bots (id, name) VALUES ($1, $2)"

const parkWorkspace = "UPDATE workspaces SET parked = true WHERE NOT always_on"

const listWorkspaces = "SELECT id FROM workspaces"
`)
	root, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	all := map[int]bool{}
	for l := 1; l <= 30; l++ {
		all[l] = true
	}
	d := &gitdiff.Diff{Root: root, Files: map[string]*gitdiff.FileChange{
		"migrations/1_bots.sql": {Path: "migrations/1_bots.sql", Added: true, Lines: all},
	}}
	m, err := Build(d, Options{Depth: 1})
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]string{}
	for _, n := range m.Nodes {
		names[n.ID] = n.Name
		if n.Name == "bots" && (n.Status != StatusAdded || n.Package != "example.com/a/migrations") {
			t.Errorf("TABLE bots: status %s, package %s", n.Status, n.Package)
		}
	}
	var edges []string
	for _, e := range m.Edges {
		edges = append(edges, names[e.From]+"->"+names[e.To])
	}
	slices.Sort(edges)
	// listWorkspaces uses the table, but not the column the migration adds.
	want := []string{"insertBot->bots", "parkWorkspace->ALTER workspaces"}
	if !slices.Equal(edges, want) {
		t.Errorf("edges = %q, want %q", edges, want)
	}
}


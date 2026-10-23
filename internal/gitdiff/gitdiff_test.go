package gitdiff

import (
	"maps"
	"slices"
	"testing"
)

func TestParse(t *testing.T) {
	diff := `diff --git a/a.go b/a.go
--- a/a.go
+++ b/a.go
@@ -3,0 +4,2 @@ func x() {
+	one()
+	two()
@@ -10 +12 @@ func y() {
-	old()
+	new()
@@ -20,3 +21,0 @@ func z() {
-	a()
-	b()
-	c()
diff --git a/new.go b/new.go
new file mode 100644
--- /dev/null
+++ b/new.go
@@ -0,0 +1,3 @@
+package x
+
+func n() {}
diff --git a/gone.go b/gone.go
deleted file mode 100644
--- a/gone.go
+++ /dev/null
@@ -1 +0,0 @@
-package x
`
	files, err := Parse(diff)
	if err != nil {
		t.Fatal(err)
	}

	if got, want := slices.Sorted(maps.Keys(files["a.go"].Lines)), []int{4, 5, 12, 21}; !slices.Equal(got, want) {
		t.Errorf("a.go lines = %v, want %v", got, want)
	}
	if !files["new.go"].Added {
		t.Error("new.go should be added")
	}
	if !files["gone.go"].Deleted {
		t.Error("gone.go should be deleted")
	}
}

func TestSplitPatches(t *testing.T) {
	diff := `diff --git a/a.sql b/a.sql
index 1..2 100644
--- a/a.sql
+++ b/a.sql
@@ -1,2 +1,2 @@
 select 1;
-drop table x;
+drop table y;
diff --git a/gone.go b/gone.go
deleted file mode 100644
--- a/gone.go
+++ /dev/null
@@ -1 +0,0 @@
-package x
`
	got := SplitPatches(diff)
	want := map[string]string{
		"a.sql":   "@@ -1,2 +1,2 @@\n select 1;\n-drop table x;\n+drop table y;",
		"gone.go": "@@ -1 +0,0 @@\n-package x",
	}
	if !maps.Equal(got, want) {
		t.Errorf("SplitPatches() = %q, want %q", got, want)
	}
}

func TestParseNumstat(t *testing.T) {
	got := ParseNumstat("3\t1\ta.go\n-\t-\timg.png\n10\t0\tdir/new file.sql\n")
	want := map[string]FileStat{
		"a.go":             {Added: 3, Deleted: 1},
		"img.png":          {},
		"dir/new file.sql": {Added: 10},
	}
	if !maps.Equal(got, want) {
		t.Errorf("ParseNumstat() = %v, want %v", got, want)
	}
}

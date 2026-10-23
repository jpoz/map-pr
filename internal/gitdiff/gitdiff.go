// Package gitdiff finds the lines a branch changed compared to a base ref.
package gitdiff

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// FileChange holds the changed lines of one file, numbered on the new side.
type FileChange struct {
	// Path is relative to the repository root.
	Path string
	// Lines holds every line number that was added or modified.
	Lines map[int]bool
	// Deleted is true when the file no longer exists.
	Deleted bool
	// Added is true when the file is new.
	Added bool
}

// FileStat counts the lines a file added and deleted. Binary files count 0.
type FileStat struct {
	Added   int `json:"added"`
	Deleted int `json:"deleted"`
}

// Diff is the result of comparing the work tree to the merge base of a ref.
type Diff struct {
	Root      string
	Base      string
	MergeBase string
	Head      string
	Files     map[string]*FileChange
	// Patches holds a readable diff (3 lines of context) for each changed file.
	Patches map[string]string
	// Stats holds the added and deleted line counts of each changed file.
	Stats map[string]FileStat
}

// Load compares the work tree in dir to the merge base of base and HEAD.
// Uncommitted changes are included so the map can be made before a commit.
func Load(dir, base string) (*Diff, error) {
	root, err := git(dir, "rev-parse", "--show-toplevel")
	if err != nil {
		return nil, err
	}
	root, err = filepath.EvalSymlinks(strings.TrimSpace(root))
	if err != nil {
		return nil, fmt.Errorf("resolve repo root: %w", err)
	}

	mergeBase, err := git(root, "merge-base", base, "HEAD")
	if err != nil {
		return nil, fmt.Errorf("find merge base of %q and HEAD: %w", base, err)
	}
	mergeBase = strings.TrimSpace(mergeBase)

	head, err := git(root, "rev-parse", "--short", "HEAD")
	if err != nil {
		return nil, err
	}

	out, err := git(root, "diff", "--unified=0", "--no-color", "--no-ext-diff", "--no-renames", mergeBase)
	if err != nil {
		return nil, err
	}

	files, err := Parse(out)
	if err != nil {
		return nil, err
	}

	patch, err := git(root, "diff", "--no-color", "--no-ext-diff", "--no-renames", mergeBase)
	if err != nil {
		return nil, err
	}

	numstat, err := git(root, "diff", "--numstat", "--no-renames", mergeBase)
	if err != nil {
		return nil, err
	}
	stats := ParseNumstat(numstat)

	// Untracked files are not in "git diff", but they are part of the change.
	untracked, err := git(root, "ls-files", "--others", "--exclude-standard")
	if err != nil {
		return nil, err
	}
	for p := range strings.FieldsSeq(untracked) {
		if _, ok := files[p]; !ok {
			files[p] = &FileChange{Path: p, Added: true, Lines: map[int]bool{}}
		}
		if _, ok := stats[p]; !ok {
			if b, err := os.ReadFile(filepath.Join(root, p)); err == nil {
				stats[p] = FileStat{Added: bytes.Count(b, []byte("\n"))}
			}
		}
	}

	return &Diff{
		Root:      root,
		Base:      base,
		MergeBase: mergeBase,
		Head:      strings.TrimSpace(head),
		Files:     files,
		Patches:   SplitPatches(patch),
		Stats:     stats,
	}, nil
}

// ParseNumstat reads "git diff --numstat": added, deleted and path per line,
// with "-" counts for a binary file.
func ParseNumstat(out string) map[string]FileStat {
	stats := map[string]FileStat{}
	for line := range strings.Lines(out) {
		f := strings.SplitN(strings.TrimSuffix(line, "\n"), "\t", 3)
		if len(f) != 3 {
			continue
		}
		added, _ := strconv.Atoi(f[0])
		deleted, _ := strconv.Atoi(f[1])
		stats[f[2]] = FileStat{Added: added, Deleted: deleted}
	}
	return stats
}

// maxPatchLines keeps one huge generated file from filling the page.
const maxPatchLines = 3000

// SplitPatches splits a full "git diff" into one patch per file, keyed by
// path. The file headers are dropped; each patch starts at its first hunk.
func SplitPatches(diff string) map[string]string {
	patches := map[string]string{}
	var path, oldPath string
	var lines []string
	flush := func() {
		if path == "" {
			return
		}
		if len(lines) > maxPatchLines {
			lines = append(lines[:maxPatchLines], fmt.Sprintf("... %d more lines not shown", len(lines)-maxPatchLines))
		}
		patches[path] = strings.Join(lines, "\n")
	}
	for line := range strings.Lines(diff) {
		line = strings.TrimSuffix(line, "\n")
		switch {
		case strings.HasPrefix(line, "diff --git "):
			flush()
			path, oldPath, lines = "", "", nil
		case path == "" && strings.HasPrefix(line, "--- "):
			oldPath = strings.TrimPrefix(strings.TrimPrefix(line, "--- "), "a/")
		case path == "" && strings.HasPrefix(line, "+++ "):
			path = strings.TrimPrefix(strings.TrimPrefix(line, "+++ "), "b/")
			if path == "/dev/null" {
				path = oldPath
			}
		case path != "":
			lines = append(lines, line)
		}
	}
	flush()
	return patches
}

var hunkHeader = regexp.MustCompile(`^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@`)

// Parse reads a unified diff made with --unified=0.
func Parse(diff string) (map[string]*FileChange, error) {
	files := map[string]*FileChange{}
	var cur *FileChange
	var oldPath string

	sc := bufio.NewScanner(strings.NewReader(diff))
	sc.Buffer(make([]byte, 1024*1024), 64*1024*1024)
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "diff --git "):
			cur, oldPath = nil, ""
		case strings.HasPrefix(line, "--- "):
			oldPath = strings.TrimPrefix(line, "--- ")
		case strings.HasPrefix(line, "+++ "):
			newPath := strings.TrimPrefix(line, "+++ ")
			if newPath == "/dev/null" {
				p := strings.TrimPrefix(oldPath, "a/")
				files[p] = &FileChange{Path: p, Deleted: true, Lines: map[int]bool{}}
				cur = nil
				continue
			}
			p := strings.TrimPrefix(newPath, "b/")
			cur = &FileChange{Path: p, Added: oldPath == "/dev/null", Lines: map[int]bool{}}
			files[p] = cur
		case strings.HasPrefix(line, "@@"):
			if cur == nil {
				continue
			}
			m := hunkHeader.FindStringSubmatch(line)
			if m == nil {
				return nil, fmt.Errorf("bad hunk header: %q", line)
			}
			start, _ := strconv.Atoi(m[1])
			count := 1
			if m[2] != "" {
				count, _ = strconv.Atoi(m[2])
			}
			if count == 0 {
				// A pure deletion. Mark the line it follows so the
				// function that held the deleted code counts as changed.
				cur.Lines[max(start, 1)] = true
				continue
			}
			for l := start; l < start+count; l++ {
				cur.Lines[l] = true
			}
		}
	}
	return files, sc.Err()
}

func git(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return string(out), nil
}

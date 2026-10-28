package callgraph

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/jpoz/map-pr/internal/gitdiff"
)

// scanJS reads TypeScript and JavaScript with the TypeScript compiler. It
// runs in Node, with the typescript package of the repository, or a global one.
//
//go:embed scan.js
var scanJS string

// maxTSFileSize skips bundles and other generated files too big to be code
// someone wrote.
const maxTSFileSize = 1 << 20

var (
	tsExts = map[string]bool{".ts": true, ".tsx": true, ".mts": true, ".cts": true, ".js": true, ".jsx": true, ".mjs": true, ".cjs": true}
	tsTest = regexp.MustCompile(`(^|/)__tests__/|\.(test|spec)\.[cm]?[jt]sx?$`)
)

// isTSFile reports whether a path names a TypeScript or JavaScript source file.
func isTSFile(p string) bool {
	return tsExts[path.Ext(p)] && !strings.HasSuffix(p, ".min.js") && !strings.Contains("/"+p, "/node_modules/")
}

// changesTS reports whether the diff changes a TypeScript or JavaScript file.
func changesTS(d *gitdiff.Diff) bool {
	for p, fc := range d.Files {
		if !fc.Deleted && isTSFile(p) {
			return true
		}
	}
	return false
}

type tsResult struct {
	Decls []tsDecl `json:"decls"`
	Refs  []struct {
		From string `json:"from"`
		To   string `json:"to"`
		Line int    `json:"line"`
	} `json:"refs"`
}

type tsDecl struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Kind     Kind      `json:"kind"`
	File     string    `json:"file"`
	Line     int       `json:"line"`
	EndLine  int       `json:"endLine"`
	Exported bool      `json:"exported"`
	Entry    EntryKind `json:"entry"`
	Routes   []string  `json:"routes"`
	Inner    [][2]int  `json:"inner"`
	Locals   [][]Span  `json:"locals"`
}

// scanTS reads the TypeScript and JavaScript files in the repository and adds
// their declarations to s.
func scanTS(s *scan, root string, opts Options) error {
	files, err := tsFiles(root, opts.Tests)
	if err != nil {
		return err
	}
	if len(files) == 0 {
		return nil
	}
	in, err := json.Marshal(map[string]any{"root": root, "files": files})
	if err != nil {
		return err
	}
	cmd := exec.Command("node", "-e", scanJS)
	cmd.Dir = root
	cmd.Env = os.Environ()
	if os.Getenv("NODE_PATH") == "" {
		// Let a global typescript package stand in for a missing local one.
		if out, err := exec.Command("npm", "root", "-g").Output(); err == nil {
			cmd.Env = append(cmd.Env, "NODE_PATH="+strings.TrimSpace(string(out)))
		}
	}
	cmd.Stdin = bytes.NewReader(in)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	os.Stderr.Write(stderr.Bytes())
	if errors.Is(err, exec.ErrNotFound) {
		return errors.New("reading TypeScript needs Node.js (node) on the PATH")
	}
	if err != nil {
		return fmt.Errorf("read TypeScript: %w", err)
	}
	var res tsResult
	if err := json.Unmarshal(out, &res); err != nil {
		return fmt.Errorf("read TypeScript: %w", err)
	}

	pkgs := map[string]string{}
	for _, t := range res.Decls {
		isTest := tsTest.MatchString(t.File)
		n := &Node{
			ID:       t.ID,
			Key:      t.File + ":" + t.Name,
			Name:     t.Name,
			Kind:     t.Kind,
			Package:  tsPackage(root, path.Dir(t.File), pkgs),
			File:     t.File,
			Line:     t.Line,
			EndLine:  t.EndLine,
			IsTest:   isTest,
			Exported: t.Exported && !isTest,
		}
		if t.Entry != "" {
			n.Entry = &Entry{Kind: t.Entry}
		}
		s.decls[t.ID] = &declInfo{node: n, inner: t.Inner}
		s.locals[t.ID] = t.Locals
		if len(t.Routes) > 0 {
			s.routes[t.ID] = append(s.routes[t.ID], t.Routes...)
		}
	}
	for _, r := range res.Refs {
		s.addRef(r.To, ref{from: r.From, line: r.Line})
	}
	return nil
}

// tsFiles lists the TypeScript and JavaScript files in the work tree that git
// tracks or would track, relative to root.
func tsFiles(root string, tests bool) ([]string, error) {
	out, err := exec.Command("git", "-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard").Output()
	if err != nil {
		return nil, fmt.Errorf("list files: %w", err)
	}
	var files []string
	seen := map[string]bool{}
	for p := range strings.SplitSeq(string(out), "\x00") {
		if p == "" || seen[p] || !isTSFile(p) || (!tests && tsTest.MatchString(p)) {
			continue
		}
		seen[p] = true
		// A file deleted from the work tree is still in the index.
		if fi, err := os.Stat(filepath.Join(root, p)); err != nil || fi.Size() > maxTSFileSize {
			continue
		}
		files = append(files, p)
	}
	return files, nil
}

// tsPackage names the package of the files in dir: the name in the nearest
// package.json, followed by the path from there, or else the path from the
// root. pkgs caches the names by directory.
func tsPackage(root, dir string, pkgs map[string]string) string {
	if p, ok := pkgs[dir]; ok {
		return p
	}
	var name string
	b, err := os.ReadFile(filepath.Join(root, dir, "package.json"))
	var pj struct {
		Name string `json:"name"`
	}
	switch {
	case err == nil && json.Unmarshal(b, &pj) == nil && pj.Name != "":
		name = pj.Name
	case dir == ".":
		name = filepath.Base(root)
	default:
		name = tsPackage(root, path.Dir(dir), pkgs) + "/" + path.Base(dir)
	}
	pkgs[dir] = name
	return name
}

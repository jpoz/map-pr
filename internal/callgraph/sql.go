package callgraph

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/jpoz/map-pr/internal/gitdiff"
)

// Kinds of statements in a SQL migration.
const (
	// KindTable is a CREATE, ALTER or DROP TABLE in a migration.
	KindTable Kind = "table"
	// KindSQL is any other statement in a migration: an index, a function,
	// a type, or a change to the rows.
	KindSQL Kind = "sql"
)

// isMigration reports whether p is a SQL migration: a .sql file in a folder
// whose name starts with "migrat" (migrations, migrate). A golang-migrate
// .down.sql file is not, as it only undoes its .up.sql file.
func isMigration(p string) bool {
	p = strings.ToLower(filepath.ToSlash(p))
	if path.Ext(p) != ".sql" || strings.HasSuffix(p, ".down.sql") {
		return false
	}
	for dir := range strings.SplitSeq(path.Dir(p), "/") {
		if strings.HasPrefix(dir, "migrat") {
			return true
		}
	}
	return false
}

// sqlStmt is one statement of a SQL file. code is its text without comments.
type sqlStmt struct {
	start, end int
	code       string
}

// splitSQL splits a SQL file into statements, with the lines each one spans.
// It knows quoted strings and identifiers, dollar-quoted bodies and comments,
// so a semicolon in them does not end a statement. It stops at a goose
// "-- +goose Down" line: what follows only undoes the migration.
func splitSQL(src string) []sqlStmt {
	var (
		out        []sqlStmt
		code       strings.Builder
		line       = 1
		start      = 0
		quote      byte   // ' or " while in a quoted string or identifier
		dollar     string // the tag, as "$body$", while in a dollar-quoted body
		lineCmt    bool
		blockDepth int
	)
	end := func() {
		if start > 0 && strings.TrimSpace(code.String()) != "" {
			out = append(out, sqlStmt{start: start, end: line, code: strings.TrimSpace(code.String())})
		}
		code.Reset()
		start = 0
	}
	for i := 0; i < len(src); i++ {
		c := src[i]
		switch {
		case lineCmt:
			if c == '\n' {
				lineCmt = false
			}
		case blockDepth > 0:
			if c == '*' && i+1 < len(src) && src[i+1] == '/' {
				blockDepth--
				i++
			} else if c == '/' && i+1 < len(src) && src[i+1] == '*' {
				blockDepth++
				i++
			}
		case quote != 0:
			code.WriteByte(c)
			if c == quote {
				quote = 0
			}
		case dollar != "":
			if strings.HasPrefix(src[i:], dollar) {
				code.WriteString(dollar)
				i += len(dollar) - 1
				dollar = ""
			} else {
				code.WriteByte(c)
			}
		case c == '-' && strings.HasPrefix(src[i:], "--"):
			rest, _, _ := strings.Cut(src[i+2:], "\n")
			if strings.TrimSpace(rest) == "+goose Down" {
				end()
				return out
			}
			lineCmt = true
		case c == '/' && strings.HasPrefix(src[i:], "/*"):
			blockDepth = 1
			i++
		case c == ';':
			end()
		default:
			if c == '$' {
				if m := dollarTag.FindString(src[i:]); m != "" {
					dollar = m
					code.WriteString(m)
					i += len(m) - 1
					if start == 0 {
						start = line
					}
					continue
				}
			}
			if c == '\'' || c == '"' {
				quote = c
			}
			if start == 0 && c != ' ' && c != '\t' && c != '\n' && c != '\r' {
				start = line
			}
			if start > 0 {
				code.WriteByte(c)
			}
		}
		if c == '\n' {
			line++
		}
	}
	end()
	return out
}

var dollarTag = regexp.MustCompile(`^\$[A-Za-z_]*\$`)

// A statement is named by the first pattern that matches it.
var (
	sqlIdent      = `((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)`
	createTableRe = regexp.MustCompile(`(?is)^CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?` + sqlIdent)
	alterTableRe  = regexp.MustCompile(`(?is)^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?` + sqlIdent)
	dropTableRe   = regexp.MustCompile(`(?is)^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?` + sqlIdent)
	indexRe       = regexp.MustCompile(`(?is)^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?` + sqlIdent + `?\s*ON\s+(?:ONLY\s+)?` + sqlIdent)
	createOtherRe = regexp.MustCompile(`(?is)^CREATE\s+(?:OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE|VIEW|MATERIALIZED\s+VIEW|TYPE|TRIGGER|SEQUENCE|EXTENSION|SCHEMA|POLICY)\s+(?:IF\s+NOT\s+EXISTS\s+)?` + sqlIdent)
	dropOtherRe   = regexp.MustCompile(`(?is)^DROP\s+(INDEX|FUNCTION|PROCEDURE|VIEW|MATERIALIZED\s+VIEW|TYPE|TRIGGER|SEQUENCE)\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?` + sqlIdent)
	rowsRe        = regexp.MustCompile(`(?is)^(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(?:ONLY\s+)?` + sqlIdent)
	// A setting or a transaction boundary is not worth a card.
	skipRe = regexp.MustCompile(`(?is)^(SET|RESET|BEGIN|COMMIT|START\s+TRANSACTION|END)\b`)
	// addColumnRe finds the columns an ALTER TABLE adds.
	addColumnRe = regexp.MustCompile(`(?is)\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|\w+)`)
	spaceRe     = regexp.MustCompile(`\s+`)
)

// bareName drops a schema and quotes from a SQL name: public."Bots" is Bots.
func bareName(s string) string {
	if strings.HasSuffix(s, `"`) {
		if i := strings.LastIndexByte(s[:len(s)-1], '"'); i >= 0 {
			return s[i+1 : len(s)-1]
		}
	}
	if i := strings.LastIndexByte(s, '.'); i >= 0 {
		s = s[i+1:]
	}
	return strings.Trim(s, `"`)
}

func upperWords(s string) string { return strings.ToUpper(spaceRe.ReplaceAllString(s, " ")) }

// sqlDecl is what a migration statement declares: its card's name and kind
// (a table's name leaves out TABLE, which its kind shows),
// the table it is about, and the columns it adds to that table.
type sqlDecl struct {
	name, table string
	kind        Kind
	columns     []string
}

func classifySQL(code string) (sqlDecl, bool) {
	switch {
	case skipRe.MatchString(code):
		return sqlDecl{}, false
	case createTableRe.MatchString(code):
		t := bareName(createTableRe.FindStringSubmatch(code)[1])
		return sqlDecl{name: t, table: t, kind: KindTable}, true
	case alterTableRe.MatchString(code):
		t := bareName(alterTableRe.FindStringSubmatch(code)[1])
		d := sqlDecl{name: "ALTER " + t, table: t, kind: KindTable}
		for _, m := range addColumnRe.FindAllStringSubmatch(code, -1) {
			switch col := bareName(m[1]); strings.ToUpper(col) {
			case "CONSTRAINT", "PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "EXCLUDE":
			default:
				d.columns = append(d.columns, col)
			}
		}
		return d, true
	case dropTableRe.MatchString(code):
		t := bareName(dropTableRe.FindStringSubmatch(code)[1])
		return sqlDecl{name: "DROP " + t, table: t, kind: KindTable}, true
	case indexRe.MatchString(code):
		m := indexRe.FindStringSubmatch(code)
		name := bareName(m[2])
		if name == "" {
			name = "on " + bareName(m[3])
		}
		return sqlDecl{name: upperWords(m[1]) + "INDEX " + name, kind: KindSQL}, true
	case createOtherRe.MatchString(code):
		m := createOtherRe.FindStringSubmatch(code)
		return sqlDecl{name: upperWords(m[1]) + " " + bareName(m[2]), kind: KindSQL}, true
	case dropOtherRe.MatchString(code):
		m := dropOtherRe.FindStringSubmatch(code)
		return sqlDecl{name: "DROP " + upperWords(m[1]) + " " + bareName(m[2]), kind: KindSQL}, true
	case rowsRe.MatchString(code):
		m := rowsRe.FindStringSubmatch(code)
		return sqlDecl{name: upperWords(m[1]) + " " + bareName(m[2]), kind: KindSQL}, true
	}
	words := strings.Fields(code)
	return sqlDecl{name: upperWords(strings.Join(words[:min(2, len(words))], " ")), kind: KindSQL}, true
}

// scanMigrations adds each statement of the PR's SQL migrations as a
// declaration, and records the code that uses the tables they make or
// change: code that names a table in SQL, and for an ALTER TABLE that adds
// columns, code that names the table and one of those columns.
func scanMigrations(s *scan, d *gitdiff.Diff) {
	pkgRoot := modulePath(d.Root)
	type colUse struct {
		col *regexp.Regexp
		id  string
	}
	tables := map[string][]string{}  // table -> the CREATE and DROP TABLE nodes
	columns := map[string][]colUse{} // table -> the columns ALTER TABLE nodes add
	var files []string
	for p, fc := range d.Files {
		if !fc.Deleted && isMigration(p) {
			files = append(files, p)
		}
	}
	sort.Strings(files)
	for _, rel := range files {
		b, err := os.ReadFile(filepath.Join(d.Root, rel))
		if err != nil {
			continue
		}
		pkg := path.Dir(filepath.ToSlash(rel))
		if pkgRoot != "" {
			pkg = pkgRoot + "/" + pkg
		}
		seen := map[string]int{}
		for _, st := range splitSQL(string(b)) {
			sd, ok := classifySQL(st.code)
			if !ok {
				continue
			}
			name := sd.name
			if seen[name]++; seen[name] > 1 {
				name = fmt.Sprintf("%s (%d)", name, seen[name])
			}
			id := fmt.Sprintf("%s:%d:1", filepath.Join(d.Root, rel), st.start)
			s.decls[id] = &declInfo{node: &Node{
				ID: id, Key: rel + ":" + name, Name: name, Kind: sd.kind,
				Package: pkg, File: rel, Line: st.start, EndLine: st.end,
			}}
			table := strings.ToLower(sd.table)
			switch {
			case sd.kind != KindTable:
			case len(sd.columns) > 0:
				for _, c := range sd.columns {
					col := regexp.MustCompile(`(?i)\b` + regexp.QuoteMeta(c) + `\b`)
					columns[table] = append(columns[table], colUse{col, id})
				}
			default:
				tables[table] = append(tables[table], id)
			}
		}
	}
	if len(tables) == 0 && len(columns) == 0 {
		return
	}

	// Find the declarations that name each table in SQL.
	byFile := map[string][]*declInfo{}
	for _, di := range s.decls {
		if !isMigration(di.node.File) {
			byFile[di.node.File] = append(byFile[di.node.File], di)
		}
	}
	for file, ds := range byFile {
		b, err := os.ReadFile(filepath.Join(d.Root, file))
		if err != nil {
			continue
		}
		src := string(b)
		lines := strings.Split(src, "\n")
		for _, m := range tableUseRe.FindAllStringSubmatchIndex(src, -1) {
			table := strings.ToLower(bareName(src[m[2]:m[3]]))
			if tables[table] == nil && columns[table] == nil {
				continue
			}
			line := strings.Count(src[:m[0]], "\n") + 1
			from := innermost(ds, line)
			if from == nil {
				continue
			}
			for _, id := range tables[table] {
				s.addRef(id, ref{from: from.node.ID, line: line})
			}
			if cs := columns[table]; cs != nil {
				body := strings.Join(lines[from.node.Line-1:min(from.node.EndLine, len(lines))], "\n")
				for _, c := range cs {
					if c.col.MatchString(body) {
						s.addRef(c.id, ref{from: from.node.ID, line: line})
					}
				}
			}
		}
	}
}

// tableUseRe finds a table named in SQL text, after the word that names one.
var tableUseRe = regexp.MustCompile(`(?i)\b(?:FROM|INTO|UPDATE|JOIN|TABLE)\s+(?:ONLY\s+)?` + sqlIdent)

// innermost is the smallest declaration in ds that holds line.
func innermost(ds []*declInfo, line int) *declInfo {
	var best *declInfo
	for _, d := range ds {
		n := d.node
		if line >= n.Line && line <= n.EndLine && (best == nil || n.EndLine-n.Line < best.node.EndLine-best.node.Line) {
			best = d
		}
	}
	return best
}

// modulePath is the module path in root's go.mod, or "" without one.
func modulePath(root string) string {
	b, err := os.ReadFile(filepath.Join(root, "go.mod"))
	if err != nil {
		return ""
	}
	for l := range strings.SplitSeq(string(b), "\n") {
		if f := strings.Fields(l); len(f) == 2 && f[0] == "module" {
			return strings.Trim(f[1], `"`)
		}
	}
	return ""
}

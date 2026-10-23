// Package comments stores the questions a reader drops on a PR map, and the
// answers to them, in a JSON file next to the page.
//
// The page writes through the HTTP handler; the answering side writes with
// the map-pr CLI. Both read and write the file under an exclusive file lock, so
// neither loses the other's change.
package comments

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// Authors of messages.
const (
	AuthorReader = "you"
	AuthorClaude = "claude"
)

// Anchor is the place on the map a thread is attached to. Node is a node key
// (stable across rebuilds); Line is a line of that node's file, or 0 for the
// whole declaration. Without a node, Package names a package, and without
// either, X and Y are a point in map space.
type Anchor struct {
	Node    string  `json:"node,omitempty"`
	Line    int     `json:"line,omitempty"`
	Package string  `json:"package,omitempty"`
	X       float64 `json:"x,omitempty"`
	Y       float64 `json:"y,omitempty"`
}

// Message is one entry in a thread.
type Message struct {
	Author string    `json:"author"`
	Body   string    `json:"body"`
	At     time.Time `json:"at"`
}

// Thread is a question and its answers at one anchor.
type Thread struct {
	ID       string    `json:"id"`
	Anchor   Anchor    `json:"anchor"`
	Messages []Message `json:"messages"`
	Resolved bool      `json:"resolved,omitempty"`
}

// Open reports whether the thread waits for an answer: the reader wrote last
// and did not resolve it.
func (t *Thread) Open() bool {
	return !t.Resolved && len(t.Messages) > 0 && t.Messages[len(t.Messages)-1].Author != AuthorClaude
}

var (
	// ErrNotFound is returned for a thread ID that is not in the file.
	ErrNotFound = errors.New("comments: no such thread")
	// ErrInvalid is returned for a message that cannot be stored.
	ErrInvalid = errors.New("comments: invalid message")
)

const maxBody = 20000

// Store is the comments file of one map.
type Store struct{ path string }

// Open returns the store at path. The file is made on the first write.
func Open(path string) *Store { return &Store{path: path} }

// Threads returns all threads in the order they were made.
func (s *Store) Threads() ([]Thread, error) {
	var ts []Thread
	err := s.locked(false, func(cur []Thread) ([]Thread, error) {
		ts = cur
		return nil, nil
	})
	return ts, err
}

// Add makes a thread at anchor with the reader's first message.
func (s *Store) Add(a Anchor, body string) (Thread, error) {
	body, err := clean(body)
	if err != nil {
		return Thread{}, err
	}
	id, err := newID()
	if err != nil {
		return Thread{}, err
	}
	t := Thread{ID: id, Anchor: a, Messages: []Message{{Author: AuthorReader, Body: body, At: time.Now().UTC()}}}
	err = s.locked(true, func(cur []Thread) ([]Thread, error) {
		return append(cur, t), nil
	})
	return t, err
}

// Reply adds a message to a thread. A reply from the reader opens a resolved
// thread again.
func (s *Store) Reply(id, author, body string) (Thread, error) {
	body, err := clean(body)
	if err != nil {
		return Thread{}, err
	}
	if author != AuthorReader && author != AuthorClaude {
		return Thread{}, fmt.Errorf("%w: unknown author %q", ErrInvalid, author)
	}
	return s.update(id, func(t *Thread) {
		t.Messages = append(t.Messages, Message{Author: author, Body: body, At: time.Now().UTC()})
		if author == AuthorReader {
			t.Resolved = false
		}
	})
}

// Resolve marks a thread as done, or open again.
func (s *Store) Resolve(id string, resolved bool) (Thread, error) {
	return s.update(id, func(t *Thread) { t.Resolved = resolved })
}

func (s *Store) update(id string, fn func(*Thread)) (Thread, error) {
	var out Thread
	err := s.locked(true, func(cur []Thread) ([]Thread, error) {
		for i := range cur {
			if cur[i].ID == id {
				fn(&cur[i])
				out = cur[i]
				return cur, nil
			}
		}
		return nil, ErrNotFound
	})
	return out, err
}

// locked runs fn on the current threads under an exclusive lock. When write
// is true, the threads fn returns replace the file.
func (s *Store) locked(write bool, fn func([]Thread) ([]Thread, error)) error {
	lock, err := os.OpenFile(s.path+".lock", os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return fmt.Errorf("comments: lock: %w", err)
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)

	var cur []Thread
	switch b, err := os.ReadFile(s.path); {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return err
	default:
		if err := json.Unmarshal(b, &cur); err != nil {
			return fmt.Errorf("comments: parse %s: %w", s.path, err)
		}
	}
	next, err := fn(cur)
	if err != nil || !write {
		return err
	}
	b, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	// Write a temporary file and rename it, so a reader never sees half a file.
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".comments-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), s.path)
}

func clean(body string) (string, error) {
	body = strings.TrimSpace(body)
	switch {
	case body == "":
		return "", fmt.Errorf("%w: empty", ErrInvalid)
	case len(body) > maxBody:
		return "", fmt.Errorf("%w: longer than %d bytes", ErrInvalid, maxBody)
	}
	return body, nil
}

func newID() (string, error) {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "t" + hex.EncodeToString(b), nil
}

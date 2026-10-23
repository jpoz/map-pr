package comments

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestThreadLifecycle(t *testing.T) {
	s := Open(filepath.Join(t.TempDir(), "comments.json"))
	if ts, err := s.Threads(); err != nil || len(ts) != 0 {
		t.Fatalf("empty store: %v, %v", ts, err)
	}
	th, err := s.Add(Anchor{Node: "a.go:F", Line: 3}, "  why?  ")
	if err != nil {
		t.Fatal(err)
	}
	if th.Messages[0].Body != "why?" || !th.Open() {
		t.Fatalf("new thread = %+v, want trimmed and open", th)
	}
	if th, err = s.Reply(th.ID, AuthorClaude, "because"); err != nil || th.Open() {
		t.Fatalf("after answer: open=%v err=%v", th.Open(), err)
	}
	if th, err = s.Resolve(th.ID, true); err != nil || !th.Resolved {
		t.Fatalf("resolve: %+v %v", th, err)
	}
	// A new question from the reader opens a resolved thread again.
	if th, err = s.Reply(th.ID, AuthorReader, "and then?"); err != nil || !th.Open() || th.Resolved {
		t.Fatalf("follow-up: %+v %v", th, err)
	}
	ts, err := s.Threads()
	if err != nil || len(ts) != 1 || len(ts[0].Messages) != 3 {
		t.Fatalf("stored = %+v, %v", ts, err)
	}

	if _, err := s.Reply("nope", AuthorReader, "x"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown id: %v", err)
	}
	if _, err := s.Add(Anchor{}, " "); !errors.Is(err, ErrInvalid) {
		t.Errorf("empty body: %v", err)
	}
	if _, err := s.Reply(th.ID, "mallory", "x"); !errors.Is(err, ErrInvalid) {
		t.Errorf("unknown author: %v", err)
	}
}

func TestConcurrentWritesKeepEveryThread(t *testing.T) {
	path := filepath.Join(t.TempDir(), "comments.json")
	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() {
			// Separate stores share only the file, as the server and the CLI do.
			if _, err := Open(path).Add(Anchor{}, "q"); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if ts, _ := Open(path).Threads(); len(ts) != 20 {
		t.Errorf("threads = %d, want 20", len(ts))
	}
}

func TestHandler(t *testing.T) {
	h := Handler(Open(filepath.Join(t.TempDir(), "comments.json")))
	do := func(method, path, body, ctype string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		if ctype != "" {
			r.Header.Set("Content-Type", ctype)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if w := do("POST", "/api/threads", `{"anchor":{"node":"a.go:F"},"body":"why"}`, "application/json"); w.Code != http.StatusOK {
		t.Fatalf("add: %d %s", w.Code, w.Body)
	}
	// A form post from another site cannot send JSON without a preflight.
	if w := do("POST", "/api/threads", `{"body":"x"}`, "text/plain"); w.Code != http.StatusUnsupportedMediaType {
		t.Errorf("text/plain post: %d, want 415", w.Code)
	}
	if w := do("POST", "/api/threads/nope/messages", `{"body":"x"}`, "application/json"); w.Code != http.StatusNotFound {
		t.Errorf("unknown thread: %d, want 404", w.Code)
	}
	w := do("GET", "/api/threads", "", "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"why"`) {
		t.Errorf("list: %d %s", w.Code, w.Body)
	}
}

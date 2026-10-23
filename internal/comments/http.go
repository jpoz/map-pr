package comments

import (
	"encoding/json"
	"errors"
	"mime"
	"net/http"
)

// Handler serves the comments API under /api/threads:
//
//	GET  /api/threads               all threads
//	POST /api/threads               {anchor, body}: a new thread
//	POST /api/threads/{id}/messages {body}: a reply from the reader
//	POST /api/threads/{id}/resolve  {resolved}: mark done or open again
//
// The page can only write as the reader; answers come from the CLI.
func Handler(s *Store) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/threads", func(w http.ResponseWriter, r *http.Request) {
		ts, err := s.Threads()
		if ts == nil {
			ts = []Thread{}
		}
		reply(w, ts, err)
	})
	mux.HandleFunc("POST /api/threads", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Anchor Anchor `json:"anchor"`
			Body   string `json:"body"`
		}
		if !decode(w, r, &in) {
			return
		}
		t, err := s.Add(in.Anchor, in.Body)
		reply(w, t, err)
	})
	mux.HandleFunc("POST /api/threads/{id}/messages", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Body string `json:"body"`
		}
		if !decode(w, r, &in) {
			return
		}
		t, err := s.Reply(r.PathValue("id"), AuthorReader, in.Body)
		reply(w, t, err)
	})
	mux.HandleFunc("POST /api/threads/{id}/resolve", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Resolved bool `json:"resolved"`
		}
		if !decode(w, r, &in) {
			return
		}
		t, err := s.Resolve(r.PathValue("id"), in.Resolved)
		reply(w, t, err)
	})
	return mux
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	// Requiring JSON means a page on another site must pass a CORS preflight,
	// which this server never grants.
	if mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); mt != "application/json" {
		http.Error(w, "send application/json", http.StatusUnsupportedMediaType)
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 2*maxBody)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)
		return false
	}
	return true
}

func reply(w http.ResponseWriter, v any, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	case errors.Is(err, ErrInvalid):
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	case err != nil:
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}

package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"time"

	"github.com/jpoz/map-pr/internal/comments"
)

// commentsFile is the file, next to the page, that holds a map's threads.
const commentsFile = "comments.json"

// serve serves a map directory and its comments API on a local address.
func serve(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	dir := fs.String("dir", ".", "directory with pr-map.html")
	addr := fs.String("addr", "127.0.0.1:8770", "address to listen on; keep it on loopback")
	open := fs.Bool("open", false, "open the map in a browser")
	fs.Parse(args)

	if _, err := os.Stat(filepath.Join(*dir, "pr-map.html")); err != nil {
		return fmt.Errorf("serve: %w", err)
	}
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		return err
	}
	mux := http.NewServeMux()
	mux.Handle("/api/", comments.Handler(comments.Open(filepath.Join(*dir, commentsFile))))
	mux.Handle("/", http.FileServer(http.Dir(*dir)))
	srv := &http.Server{Handler: localOnly(mux), ReadHeaderTimeout: 10 * time.Second}

	url := fmt.Sprintf("http://%s/pr-map.html", ln.Addr())
	fmt.Fprintf(os.Stderr, "serving %s (comments in %s)\n", url, filepath.Join(*dir, commentsFile))
	if *open {
		if err := openBrowser(url); err != nil {
			return err
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		srv.Shutdown(shutdown)
	}()
	if err := srv.Serve(ln); err != http.ErrServerClosed {
		return err
	}
	return nil
}

// localOnly refuses requests whose Host is not a loopback name, so a page
// on another site cannot reach the map through DNS rebinding.
func localOnly(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.Host)
		if err != nil {
			host = r.Host
		}
		if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		h.ServeHTTP(w, r)
	})
}

// listComments prints the threads that wait for an answer. With -watch it
// keeps running and prints each new question once, one line per question.
func listComments(args []string) error {
	fs := flag.NewFlagSet("comments", flag.ExitOnError)
	dir := fs.String("dir", ".", "map directory")
	all := fs.Bool("all", false, "print every thread, not only the open ones")
	watch := fs.Bool("watch", false, "keep running and print each new question as one line")
	every := fs.Duration("every", time.Second, "how often -watch reads the file")
	fs.Parse(args)

	store := comments.Open(filepath.Join(*dir, commentsFile))
	if !*watch {
		ts, err := store.Threads()
		if err != nil {
			return err
		}
		for _, t := range ts {
			if *all || t.Open() {
				printThread(os.Stdout, t)
			}
		}
		return nil
	}

	// A question is a thread plus its message count, so a follow-up in the
	// same thread is new again.
	seen := map[string]int{}
	for {
		ts, err := store.Threads()
		if err != nil {
			return err
		}
		for _, t := range ts {
			if t.Open() && seen[t.ID] < len(t.Messages) {
				seen[t.ID] = len(t.Messages)
				last := t.Messages[len(t.Messages)-1]
				fmt.Printf("[%s] %s: %s\n", t.ID, anchorText(t.Anchor), oneLine(last.Body))
			}
		}
		time.Sleep(*every)
	}
}

// replyComment adds an answer to a thread.
func replyComment(args []string) error {
	fs := flag.NewFlagSet("reply", flag.ExitOnError)
	dir := fs.String("dir", ".", "map directory")
	id := fs.String("id", "", "thread ID")
	resolve := fs.Bool("resolve", false, "also mark the thread as done")
	fs.Usage = func() {
		fmt.Fprintln(fs.Output(), "usage: map-pr reply -dir DIR -id ID [-resolve] TEXT | -")
		fs.PrintDefaults()
	}
	fs.Parse(args)
	if *id == "" || fs.NArg() == 0 {
		fs.Usage()
		return fmt.Errorf("reply: need -id and the text")
	}
	body := strings.Join(fs.Args(), " ")
	if body == "-" {
		b, err := io.ReadAll(os.Stdin)
		if err != nil {
			return err
		}
		body = string(b)
	}
	store := comments.Open(filepath.Join(*dir, commentsFile))
	t, err := store.Reply(*id, comments.AuthorClaude, body)
	if err != nil {
		return err
	}
	if *resolve {
		if t, err = store.Resolve(*id, true); err != nil {
			return err
		}
	}
	fmt.Fprintf(os.Stderr, "replied to %s (%d messages)\n", t.ID, len(t.Messages))
	return nil
}

func printThread(w io.Writer, t comments.Thread) {
	state := "open"
	if t.Resolved {
		state = "resolved"
	} else if !t.Open() {
		state = "answered"
	}
	fmt.Fprintf(w, "[%s] %s (%s)\n", t.ID, anchorText(t.Anchor), state)
	for _, m := range t.Messages {
		fmt.Fprintf(w, "  %s: %s\n", m.Author, strings.ReplaceAll(m.Body, "\n", "\n    "))
	}
	fmt.Fprintln(w)
}

func anchorText(a comments.Anchor) string {
	switch {
	case a.Node != "" && a.Line > 0:
		return fmt.Sprintf("%s line %d", a.Node, a.Line)
	case a.Node != "":
		return a.Node
	case a.Package != "":
		return "package " + a.Package
	default:
		return fmt.Sprintf("map point (%.0f, %.0f)", a.X, a.Y)
	}
}

func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

#!/usr/bin/env bash
# Makes a small Go repo with a PR branch that changes authGoogle, then maps it.
# Usage: scripts/demo.sh [dir]
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
dir="${1:-$(mktemp -d)/demo}"
rm -rf "$dir"
mkdir -p "$dir/auth" "$dir/server" "$dir/cmd/app"
cd "$dir"

git init -q -b main
echo pr-map.html > .gitignore
cat > go.mod <<'EOF'
module example.com/demo

go 1.22
EOF

cat > auth/google.go <<'EOF'
package auth

import "errors"

type User struct{ Email string }

func authGoogle(token string) (*User, error) {
	if token == "" {
		return nil, errors.New("empty token")
	}
	return &User{Email: token + "@gmail.com"}, nil
}

// Login picks a provider and signs the user in.
func Login(provider, token string) (*User, error) {
	switch provider {
	case "google":
		return authGoogle(token)
	default:
		return nil, errors.New("unknown provider")
	}
}

// Refresh gets a new session for a Google user.
func Refresh(token string) (*User, error) {
	return authGoogle(token)
}
EOF

cat > auth/google_test.go <<'EOF'
package auth

import "testing"

func TestAuthGoogle(t *testing.T) {
	if _, err := authGoogle(""); err == nil {
		t.Fatal("want error")
	}
}
EOF

cat > server/server.go <<'EOF'
package server

import (
	"net/http"

	"example.com/demo/auth"
)

type Server struct{}

func (s *Server) HandleLogin(w http.ResponseWriter, r *http.Request) {
	u, err := auth.Login(r.FormValue("provider"), r.FormValue("token"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return
	}
	w.Write([]byte(u.Email))
}

func (s *Server) HandleRefresh(w http.ResponseWriter, r *http.Request) {
	if _, err := auth.Refresh(r.FormValue("token")); err != nil {
		http.Error(w, err.Error(), http.StatusUnauthorized)
	}
}

func (s *Server) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/login", s.HandleLogin)
	mux.HandleFunc("/refresh", s.HandleRefresh)
	return mux
}
EOF

cat > cmd/app/main.go <<'EOF'
package main

import (
	"net/http"

	"example.com/demo/server"
)

func main() {
	s := &server.Server{}
	http.ListenAndServe(":8080", s.Routes())
}
EOF

git add -A
git -c user.name=demo -c user.email=demo@example.com commit -q -m "initial"

# The PR: check the token domain in authGoogle and add a new helper.
git checkout -q -b change-auth-google
cat > auth/google.go <<'EOF'
package auth

import (
	"errors"
	"strings"
)

type User struct{ Email string }

func authGoogle(token string) (*User, error) {
	if token == "" {
		return nil, errors.New("empty token")
	}
	if !validDomain(token) {
		return nil, errors.New("domain not allowed")
	}
	return &User{Email: token + "@gmail.com"}, nil
}

func validDomain(token string) bool {
	return !strings.Contains(token, "@")
}

// Login picks a provider and signs the user in.
func Login(provider, token string) (*User, error) {
	switch provider {
	case "google":
		return authGoogle(token)
	default:
		return nil, errors.New("unknown provider")
	}
}

// Refresh gets a new session for a Google user.
func Refresh(token string) (*User, error) {
	return authGoogle(token)
}
EOF

(cd "$repo_dir" && go run . -C "$dir" -base main -depth 3 -o "$dir/pr-map.html")
echo "demo repo: $dir"
echo "map:       $dir/pr-map.html"

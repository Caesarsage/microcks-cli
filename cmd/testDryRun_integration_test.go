//go:build integration

/*
 * Copyright The Microcks Authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *  http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Package cmd integration tests for `microcks test --dry-run`.
//
// These tests spin up a real ephemeral Microcks container via Docker, so they
// are guarded by the `integration` build tag and excluded from the normal
// `go test ./...` run. Run them with:
//
//	go test -tags integration -run TestDryRunIntegration -timeout 300s ./cmd/
package cmd

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	itArtifact   = "../samples/ecommerce-api-openapi.yml"
	itServiceRef = "E-Commerce Platform API:2.0.0"
	itRunner     = "OPEN_API_SCHEMA"
	itImage      = "quay.io/microcks/microcks-uber:latest-native"
)

// A response that conforms to the GET /products 200 schema (ProductList).
const conformingProducts = `{"products":[{"id":"prod_001","name":"Wireless Headphones","description":"d","price":199.99,"category":"Electronics","brand":"TechAudio","rating":4.5,"stockQuantity":150,"images":["https://example.com/a.jpg"],"specifications":{"x":"y"},"createdAt":"2024-01-15T10:30:00Z","updatedAt":"2024-01-20T14:45:00Z"}],"pagination":{"page":1,"limit":20,"total":1,"totalPages":1,"hasNext":false,"hasPrev":false}}`

// Same shape but price is a string — violates `price: {type: number}`, which is
// a required field, so the contract test must fail.
const violatingProducts = `{"products":[{"id":"prod_001","name":"Wireless Headphones","price":"199.99","category":"Electronics"}],"pagination":{"page":1,"limit":20,"total":1,"totalPages":1,"hasNext":false,"hasPrev":false}}`

var (
	cliBuildOnce sync.Once
	cliBinPath   string
	cliBuildErr  error
)

// ensureCLI builds the microcks binary once per test run and returns its path.
func ensureCLI(t *testing.T) string {
	t.Helper()
	cliBuildOnce.Do(func() {
		dir, err := os.MkdirTemp("", "microcks-it")
		if err != nil {
			cliBuildErr = err
			return
		}
		binName := "microcks"
		if runtime.GOOS == "windows" {
			binName += ".exe"
		}
		cliBinPath = filepath.Join(dir, binName)
		out, err := exec.Command("go", "build", "-o", cliBinPath, "github.com/microcks/microcks-cli").CombinedOutput()
		if err != nil {
			cliBuildErr = errors.New("build microcks binary: " + err.Error() + "\n" + string(out))
		}
	})
	if cliBuildErr != nil {
		t.Fatal(cliBuildErr)
	}
	return cliBinPath
}

func requireDocker(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("docker not on PATH; skipping integration test")
	}
}

// uberContainers returns the set of container IDs (running or stopped) created
// from the uber image, used to assert the ephemeral container is torn down.
func uberContainers(t *testing.T) map[string]bool {
	t.Helper()
	out, err := exec.Command("docker", "ps", "-a", "--filter", "ancestor="+itImage, "--format", "{{.ID}}").Output()
	if err != nil {
		t.Fatalf("docker ps failed: %v", err)
	}
	ids := map[string]bool{}
	for _, id := range strings.Fields(string(out)) {
		ids[id] = true
	}
	return ids
}

// runDryRun executes the built CLI against the given endpoint and returns the
// process exit code.
func runDryRun(t *testing.T, endpoint string) int {
	t.Helper()
	bin := ensureCLI(t)
	cmd := exec.Command(bin, "test", "--dry-run",
		"--artifact", itArtifact,
		"--filteredOperations", `["GET /products"]`,
		itServiceRef, endpoint, itRunner,
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	err := cmd.Run()
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	t.Fatalf("failed to run CLI: %v", err)
	return -1
}

func TestDryRunIntegrationPass(t *testing.T) {
	requireDocker(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(conformingProducts))
	}))
	defer srv.Close()

	before := uberContainers(t)

	if code := runDryRun(t, srv.URL); code != 0 {
		t.Fatalf("expected exit code 0 for a conforming target, got %d", code)
	}

	// The ephemeral container must be gone within 5s of the process exiting.
	deadline := time.Now().Add(5 * time.Second)
	for {
		leftovers := false
		for id := range uberContainers(t) {
			if !before[id] {
				leftovers = true
			}
		}
		if !leftovers {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("ephemeral Microcks container was not removed within 5s of exit")
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func TestDryRunIntegrationFail(t *testing.T) {
	requireDocker(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(violatingProducts))
	}))
	defer srv.Close()

	if code := runDryRun(t, srv.URL); code != 1 {
		t.Fatalf("expected exit code 1 for a non-conforming target, got %d", code)
	}
}

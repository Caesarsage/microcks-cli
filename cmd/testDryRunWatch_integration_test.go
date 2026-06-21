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
package cmd

import (
	"bufio"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"syscall"
	"testing"
	"time"
)

// detailsLine matches the "Test details (live while watching): <endpoint>/#/tests/<id>"
// line printed on every watch iteration. Group 1 = endpoint (container identity),
// group 2 = test result id.
var detailsLine = regexp.MustCompile(`Test details \(live while watching\): (http://[^ ]+?)/#/tests/(\S+)`)

// nextDetails reads watch output until it sees a details line whose result id is
// not excludeID, returning (endpoint, id). Fails on timeout or premature EOF.
func nextDetails(t *testing.T, lines <-chan string, timeout time.Duration, excludeID string) (string, string) {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case line, ok := <-lines:
			if !ok {
				t.Fatalf("watch process output ended before a new test result (exclude=%q)", excludeID)
			}
			if m := detailsLine.FindStringSubmatch(line); m != nil && m[2] != excludeID {
				return m[1], m[2]
			}
		case <-deadline:
			t.Fatalf("timed out waiting for a test result (exclude=%q)", excludeID)
		}
	}
}

func TestDryRunIntegrationWatch(t *testing.T) {
	requireDocker(t)

	// Work on a temp copy so the real sample is never mutated.
	src, err := os.ReadFile(itArtifact)
	if err != nil {
		t.Fatalf("read sample artifact: %v", err)
	}
	specPath := filepath.Join(t.TempDir(), "spec.yml")
	if err := os.WriteFile(specPath, src, 0o644); err != nil {
		t.Fatalf("write temp artifact: %v", err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(conformingProducts))
	}))
	defer srv.Close()

	bin := ensureCLI(t)
	cmd := exec.Command(bin, "test", "--dry-run", "--watch",
		"--artifact", specPath,
		"--filteredOperations", `["GET /products"]`,
		itServiceRef, srv.URL, itRunner,
	)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start watch: %v", err)
	}
	// Make sure the process is never leaked if an assertion fails mid-test.
	defer func() { _ = cmd.Process.Kill() }()

	lines := make(chan string, 256)
	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			lines <- sc.Text()
		}
		close(lines)
	}()

	// First run (includes the cold container start).
	endpoint1, id1 := nextDetails(t, lines, 150*time.Second, "")

	// Mutate the artifact the way editors do — write a temp file then rename it
	// into place. That atomic replace fires a create/rename event the directory
	// watcher catches on macOS (kqueue), Linux (inotify) and Windows alike; an
	// in-place append would be missed by kqueue dir-watching. The appended YAML
	// comment keeps the spec valid so re-import succeeds.
	mutated := append(append([]byte{}, src...), []byte("\n# watch-mode integration test touch\n")...)
	tmp := specPath + ".tmp"
	if err := os.WriteFile(tmp, mutated, 0o644); err != nil {
		t.Fatalf("write mutated artifact: %v", err)
	}
	if err := os.Rename(tmp, specPath); err != nil {
		t.Fatalf("rename mutated artifact into place: %v", err)
	}

	// Second run, triggered by the change.
	endpoint2, id2 := nextDetails(t, lines, 90*time.Second, id1)

	if id2 == id1 {
		t.Fatalf("expected a new test result id after the artifact changed, got %q twice", id1)
	}
	if endpoint2 != endpoint1 {
		t.Fatalf("container was not reused across iterations: %q then %q", endpoint1, endpoint2)
	}

	// Ctrl+C / SIGTERM must exit cleanly (code 0) and tear the container down.
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("send SIGTERM: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("watch mode did not exit cleanly on SIGTERM: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("watch mode did not exit within 30s of SIGTERM")
	}
}

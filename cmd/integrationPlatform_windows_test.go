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

// Platform-specific helpers shared across integration tests in package cmd.
// The _windows filename suffix already restricts this file to GOOS=windows,
// so the build tag only needs the `integration` gate.
package cmd

import (
	"os"
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// configureSignaling puts the child in its own process group. Windows has no
// SIGTERM; the only way to drive the CLI's graceful shutdown is a console
// control event, and such an event can only be targeted at a process group.
// Starting the child in a new group lets terminateGracefully signal it without
// also delivering the event to this test process (which lives in group 0).
func configureSignaling(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
}

// terminateGracefully sends a Ctrl+Break to the child's process group. The Go
// runtime delivers that console event to the watch process as os.Interrupt,
// which is exactly what the CLI's signal.NotifyContext waits on. (Ctrl+C can't
// be sent to another group, and SIGTERM is never delivered on Windows.)
func terminateGracefully(p *os.Process) error {
	return windows.GenerateConsoleCtrlEvent(windows.CTRL_BREAK_EVENT, uint32(p.Pid))
}

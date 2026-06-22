//go:build integration && !windows

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
// "other" = every non-Windows OS. No filename suffix can express "not windows",
// so this file keeps an explicit build tag.
package cmd

import (
	"os"
	"os/exec"
	"syscall"
)

// configureSignaling prepares cmd so terminateGracefully can later reach it.
// No setup is needed on Unix.
func configureSignaling(cmd *exec.Cmd) {}

// terminateGracefully asks the process to shut down the way Ctrl+C / SIGTERM
// would, exercising the CLI's signal.NotifyContext teardown path.
func terminateGracefully(p *os.Process) error {
	return p.Signal(syscall.SIGTERM)
}

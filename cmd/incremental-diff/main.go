// Command incremental-diff is Incremental Diff's core: `incremental-diff
// serve` speaks JSON-RPC 2.0 on stdin and stdout, one JSON object per line,
// for the editor frontends (the Neovim plugin and the VS Code extension).
// See docs/server.md.
package main

import (
	"fmt"
	"os"

	"github.com/statiolake/vscode-incremental-diff/internal/server"
)

// version is package.json's (test/manifest.test.ts checks it).
var version = "0.3.0"

const usage = `Usage: incremental-diff COMMAND

Incremental Diff's core, run by the editor frontends.

  incremental-diff serve     JSON-RPC 2.0 on stdin / stdout, one object per
                             line, until stdin closes (docs/server.md)
  incremental-diff version   print the version`

func main() {
	args := os.Args[1:]
	switch {
	case len(args) == 1 && args[0] == "serve":
		if err := server.Serve(os.Stdin, os.Stdout, version); err != nil {
			fmt.Fprintln(os.Stderr, "incremental-diff:", err)
			os.Exit(1)
		}
	case len(args) == 1 && (args[0] == "version" || args[0] == "--version"):
		fmt.Println(version)
	case len(args) == 0 || args[0] == "help" || args[0] == "-h" || args[0] == "--help":
		fmt.Println(usage)
	default:
		fmt.Fprintf(os.Stderr, "incremental-diff: unknown command %q\n\n%s\n", args[0], usage)
		os.Exit(2)
	}
}

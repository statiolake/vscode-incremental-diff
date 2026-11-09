package server

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/statiolake/vscode-incremental-diff/internal/testrepo"
)

// The protocol conformance scenarios in test/conformance/protocol.json (the
// fixture says how to read them), played against this server over a pipe.

type step map[string]json.RawMessage

type scenario struct {
	Name  string `json:"name"`
	Steps []step `json:"steps"`
}

func TestProtocolConformance(t *testing.T) {
	content, err := os.ReadFile(filepath.Join("..", "..", "test", "conformance", "protocol.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Scenarios []scenario `json:"scenarios"`
	}
	if err := json.Unmarshal(content, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, sc := range fixture.Scenarios {
		t.Run(sc.Name, func(t *testing.T) { play(t, sc) })
	}
}

type rpcClient struct {
	t      *testing.T
	in     io.WriteCloser
	mu     sync.Mutex
	cond   *sync.Cond
	byID   map[string]map[string]any
	notes  []map[string]any
	nextID int
}

func newClient(t *testing.T) *rpcClient {
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	c := &rpcClient{t: t, in: inW, byID: map[string]map[string]any{}, nextID: 1000}
	c.cond = sync.NewCond(&c.mu)
	done := make(chan struct{})
	go func() {
		ServeWith(inR, outW, func(notify Notify) *Service {
			return NewService(notify, Options{Version: "test", WatchDelay: 50 * time.Millisecond, PollInterval: 50 * time.Millisecond})
		})
		outW.Close()
		close(done)
	}()
	go func() {
		scanner := bufio.NewScanner(outR)
		scanner.Buffer(make([]byte, 1<<20), 64<<20)
		for scanner.Scan() {
			var message map[string]any
			if err := json.Unmarshal(scanner.Bytes(), &message); err != nil {
				t.Errorf("the server wrote %q: %v", scanner.Text(), err)
				continue
			}
			c.mu.Lock()
			if id, ok := message["id"]; ok {
				key, _ := json.Marshal(id)
				c.byID[string(key)] = message
			} else {
				c.notes = append(c.notes, message)
			}
			c.cond.Broadcast()
			c.mu.Unlock()
		}
	}()
	t.Cleanup(func() {
		inW.Close()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("the server did not stop when its stdin closed")
		}
	})
	return c
}

func (c *rpcClient) send(line string) {
	if _, err := io.WriteString(c.in, line+"\n"); err != nil {
		c.t.Fatal(err)
	}
}

// waitFor waits until pick finds something (at most 10s).
func (c *rpcClient) waitFor(what string, pick func() bool) {
	c.t.Helper()
	if !c.wait(pick) {
		c.t.Fatalf("timed out waiting for %s", what)
	}
}

func (c *rpcClient) wait(pick func() bool) bool {
	deadline := time.Now().Add(10 * time.Second)
	timer := time.AfterFunc(10*time.Second, func() {
		c.mu.Lock()
		c.cond.Broadcast()
		c.mu.Unlock()
	})
	defer timer.Stop()
	c.mu.Lock()
	defer c.mu.Unlock()
	for !pick() {
		if time.Now().After(deadline) {
			return false
		}
		c.cond.Wait()
	}
	return true
}

func (c *rpcClient) response(id string) map[string]any {
	c.t.Helper()
	var message map[string]any
	c.waitFor("the answer to "+id, func() bool {
		message = c.byID[id]
		delete(c.byID, id)
		return message != nil
	})
	return message
}

type player struct {
	t      *testing.T
	repo   *testrepo.Repo
	client *rpcClient
	saved  map[string]any
	seen   int // notifications already matched or skipped
}

func play(t *testing.T, sc scenario) {
	p := &player{t: t, repo: testrepo.New(t), saved: map[string]any{}}
	p.client = newClient(t)
	for i, s := range sc.Steps {
		p.step(i, s)
		if t.Failed() {
			return
		}
	}
}

func decode[T any](t *testing.T, raw json.RawMessage) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatalf("fixture: %s: %v", raw, err)
	}
	return value
}

func (p *player) step(index int, s step) {
	t := p.t
	t.Helper()
	where := fmt.Sprintf("step %d", index+1)
	switch {
	case s["write"] != nil:
		files := decode[map[string]string](t, s["write"])
		for path, content := range files {
			p.repo.Write(path, content)
		}
	case s["remove"] != nil:
		for _, path := range decode[[]string](t, s["remove"]) {
			p.repo.Remove(path)
		}
	case s["git"] != nil:
		p.repo.Git(decode[[]string](t, s["git"])...)
	case s["commit"] != nil:
		p.repo.Commit(decode[string](t, s["commit"]))
	case s["request"] != nil:
		method := decode[string](t, s["request"])
		where += " (" + method + ")"
		params := p.substitute(decode[any](t, s["params"]))
		p.client.nextID++
		id := p.client.nextID
		line, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
		p.client.send(string(line))
		message := p.client.response(fmt.Sprint(id))
		if message["jsonrpc"] != "2.0" {
			t.Errorf("%s: jsonrpc %v", where, message["jsonrpc"])
		}
		if s["error"] != nil {
			p.expect(where+": error", decode[any](t, s["error"]), message["error"])
			if _, ok := message["result"]; ok {
				t.Errorf("%s: an error has no result", where)
			}
			return
		}
		if message["error"] != nil {
			t.Fatalf("%s: %v", where, message["error"])
		}
		result, ok := message["result"]
		if !ok {
			t.Fatalf("%s: no result", where)
		}
		p.expect(where, decode[any](t, s["result"]), result)
		if s["save"] != nil {
			for name, path := range decode[map[string]string](t, s["save"]) {
				p.saved[name] = dig(result, path)
			}
		}
	case s["raw"] != nil:
		p.client.send(decode[string](t, s["raw"]))
		expected := decode[map[string]any](t, s["response"])
		key, _ := json.Marshal(expected["id"])
		p.expect(where+": response", expected, p.client.response(string(key)))
	case s["notification"] != nil:
		method := decode[string](t, s["notification"])
		expected := p.substitute(decode[any](t, s["params"]))
		var lastErr error
		found := p.client.wait(func() bool {
			for ; p.seen < len(p.client.notes); p.seen++ {
				note := p.client.notes[p.seen]
				if note["method"] != method || note["jsonrpc"] != "2.0" {
					continue
				}
				if lastErr = match(expected, note["params"], "params"); lastErr == nil {
					p.seen++
					return true
				}
			}
			return false
		})
		if !found {
			t.Fatalf("%s: no matching %s (the last one: %v)", where, method, lastErr)
		}
	case s["stateFile"] != nil:
		var actual any
		content, err := os.ReadFile(p.statePath())
		if err != nil {
			t.Fatalf("%s: %v", where, err)
		}
		if err := json.Unmarshal(content, &actual); err != nil {
			t.Fatalf("%s: state.json: %v", where, err)
		}
		p.expect(where+": state.json", decode[any](t, s["stateFile"]), actual)
	case s["writeState"] != nil:
		path := p.statePath()
		os.MkdirAll(filepath.Dir(path), 0o755)
		content, _ := json.MarshalIndent(p.substitute(decode[any](t, s["writeState"])), "", " ")
		if err := os.WriteFile(path, content, 0o644); err != nil {
			t.Fatal(err)
		}
	default:
		t.Fatalf("%s: unknown step %v", where, s)
	}
}

func (p *player) statePath() string {
	common := strings.TrimSpace(p.repo.Git("rev-parse", "--path-format=absolute", "--git-common-dir"))
	return filepath.Join(common, "incremental-diff", "state.json")
}

func (p *player) expect(where string, expected, actual any) {
	p.t.Helper()
	if err := match(p.substitute(expected), actual, "$"); err != nil {
		encoded, _ := json.MarshalIndent(actual, "", "  ")
		p.t.Errorf("%s: %v\nactual: %s", where, err, encoded)
	}
}

var (
	wholeName   = regexp.MustCompile(`^\{([A-Za-z]+)\}$`)
	placeholder = regexp.MustCompile(`\{(root|rev:[^}]*|hash:[^}]*|[A-Za-z]+)\}`)
	oidPattern  = regexp.MustCompile(`^[0-9a-f]{40}$`)
	isoPattern  = regexp.MustCompile(`^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$`)
)

func (p *player) substitute(value any) any {
	switch v := value.(type) {
	case string:
		if m := wholeName.FindStringSubmatch(v); m != nil {
			if saved, ok := p.saved[m[1]]; ok {
				return saved
			}
		}
		return placeholder.ReplaceAllStringFunc(v, func(token string) string {
			name := token[1 : len(token)-1]
			switch {
			case name == "root":
				return p.repo.Root
			case strings.HasPrefix(name, "rev:"):
				return strings.TrimSpace(p.repo.Git("rev-parse", strings.TrimPrefix(name, "rev:")))
			case strings.HasPrefix(name, "hash:"):
				return strings.TrimSpace(p.repo.Git("hash-object", "--no-filters", strings.TrimPrefix(name, "hash:")))
			}
			if saved, ok := p.saved[name]; ok {
				return fmt.Sprint(saved)
			}
			return token
		})
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = p.substitute(item)
		}
		return out
	case map[string]any:
		out := map[string]any{}
		for key, item := range v {
			out[p.substitute(key).(string)] = p.substitute(item)
		}
		return out
	}
	return value
}

// match checks actual against an expectation of the fixture (see its $comment).
func match(expected, actual any, path string) error {
	switch e := expected.(type) {
	case string:
		switch e {
		case "<any>":
			return nil
		case "<oid>":
			if s, ok := actual.(string); ok && oidPattern.MatchString(s) {
				return nil
			}
			return fmt.Errorf("%s: %#v is not an object id", path, actual)
		case "<iso>":
			if s, ok := actual.(string); ok && isoPattern.MatchString(s) {
				return nil
			}
			return fmt.Errorf("%s: %#v is not an ISO 8601 time", path, actual)
		}
	case []any:
		a, ok := actual.([]any)
		if !ok || len(a) != len(e) {
			return fmt.Errorf("%s: %#v, want %d items", path, actual, len(e))
		}
		for i := range e {
			if err := match(e[i], a[i], fmt.Sprintf("%s[%d]", path, i)); err != nil {
				return err
			}
		}
		return nil
	case map[string]any:
		a, ok := actual.(map[string]any)
		if !ok {
			return fmt.Errorf("%s: %#v is not an object", path, actual)
		}
		open := e["<...>"] == true
		keys := make([]string, 0, len(e))
		for key := range e {
			if key != "<...>" {
				keys = append(keys, key)
			}
		}
		sort.Strings(keys)
		for _, key := range keys {
			value, present := a[key]
			if !present {
				return fmt.Errorf("%s.%s is missing", path, key)
			}
			if err := match(e[key], value, path+"."+key); err != nil {
				return err
			}
		}
		if !open {
			for key := range a {
				if _, ok := e[key]; !ok {
					return fmt.Errorf("%s.%s is not expected (%#v)", path, key, a[key])
				}
			}
		}
		return nil
	}
	if fmt.Sprintf("%T %v", expected, expected) != fmt.Sprintf("%T %v", actual, actual) {
		return fmt.Errorf("%s: %#v, want %#v", path, actual, expected)
	}
	return nil
}

// dig answers the value at a dotted path ("files.0.snapshot").
func dig(value any, path string) any {
	for _, part := range strings.Split(path, ".") {
		switch v := value.(type) {
		case map[string]any:
			value = v[part]
		case []any:
			var i int
			fmt.Sscan(part, &i)
			if i < len(v) {
				value = v[i]
			} else {
				value = nil
			}
		}
	}
	return value
}

// The binary itself, over real stdio: it exits 0 when stdin closes.
func TestServeBinaryOverStdio(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "incremental-diff")
	build := exec.Command("go", "build", "-o", bin, "../../cmd/incremental-diff")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	cmd := exec.Command(bin, "serve")
	cmd.Stdin = strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}` + "\n")
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	var message struct {
		ID     int         `json:"id"`
		Result Initialized `json:"result"`
	}
	if err := json.Unmarshal(out, &message); err != nil || message.ID != 1 || message.Result.Protocol != 1 || message.Result.Name != "incremental-diff" {
		t.Errorf("%s %v", out, err)
	}
}

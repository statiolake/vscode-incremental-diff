package server

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"sync"
	"time"
)

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type resultResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result"`
}

type notification struct {
	JSONRPC string `json:"jsonrpc"`
	Method  string `json:"method"`
	Params  any    `json:"params"`
}

// Serve speaks JSON-RPC 2.0 on in and out, one JSON object per line, until
// in ends; then it closes every review and returns.
//
// Requests run concurrently; each is answered when it is done. A client
// that needs an order (refresh, then mark) waits for one answer before
// asking again. A review's change is notified before the answer to the
// request that made it.
func Serve(in io.Reader, out io.Writer, version string) error {
	return ServeWith(in, out, func(notify Notify) *Service {
		return NewService(notify, Options{Version: version})
	})
}

// ServeWith is Serve with a service made by makeService (tests).
func ServeWith(in io.Reader, out io.Writer, makeService func(Notify) *Service) error {
	var writeMu sync.Mutex
	send := func(message any) {
		var buf bytes.Buffer
		encoder := json.NewEncoder(&buf)
		encoder.SetEscapeHTML(false)
		if err := encoder.Encode(message); err != nil {
			return
		}
		writeMu.Lock()
		out.Write(buf.Bytes())
		writeMu.Unlock()
	}
	service := makeService(func(method string, params any) {
		send(notification{JSONRPC: "2.0", Method: method, Params: params})
	})
	var running sync.WaitGroup
	defer func() {
		service.Dispose()
		// Answer what was asked before stdin closed, as far as it gets soon.
		finished := make(chan struct{})
		go func() { running.Wait(); close(finished) }()
		select {
		case <-finished:
		case <-time.After(5 * time.Second):
		}
	}()

	reader := bufio.NewReaderSize(in, 1<<16)
	for {
		line, err := reader.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			handleLine(service, line, send, &running)
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func handleLine(service *Service, line []byte, send func(any), running *sync.WaitGroup) {
	var message map[string]json.RawMessage
	if err := json.Unmarshal(line, &message); err != nil {
		var anything any
		if json.Unmarshal(line, &anything) == nil {
			return // JSON, but not a request
		}
		send(response{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcError{Code: -32700, Message: "Parse error"}})
		return
	}
	id, hasID := message["id"]
	var method string
	if raw, ok := message["method"]; !ok || json.Unmarshal(raw, &method) != nil {
		if hasID {
			send(response{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: -32600, Message: "Invalid request"}})
		}
		return
	}
	running.Add(1)
	go func() {
		defer running.Done()
		result, err := service.Handle(method, message["params"])
		if !hasID {
			return
		}
		if err != nil {
			code := -32000
			if IsRequestError(err) {
				code = -32602
			}
			send(response{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: code, Message: err.Error()}})
			return
		}
		send(resultResponse{JSONRPC: "2.0", ID: id, Result: result})
	}()
}

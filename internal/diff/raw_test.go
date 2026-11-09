package diff

import (
	"reflect"
	"strings"
	"testing"
)

var (
	a    = strings.Repeat("a", 40)
	b    = strings.Repeat("b", 40)
	zero = strings.Repeat("0", 40)
)

func ptr(s string) *string { return &s }

func TestParsesRawRecordsIncludingRenamesAndOddPaths(t *testing.T) {
	output := strings.Join([]string{
		":100644 100644 " + a + " " + zero + " M", "src/app.ts",
		":000000 100644 " + zero + " " + b + " A", "new file\twith tab.txt",
		":100644 000000 " + a + " " + zero + " D", "gone.md",
		":100644 100644 " + a + " " + b + " R087", "old/name.ts", "new/name.ts",
		":100644 100644 " + a + " " + a + " C100", "orig.ts", "copy.ts",
		":100644 120000 " + a + " " + b + " T", "link",
		"",
	}, "\x00")
	got, err := ParseRaw(output)
	if err != nil {
		t.Fatal(err)
	}
	want := []RawEntry{
		{Status: "M", Score: -1, Path: "src/app.ts", OldMode: "100644", NewMode: "100644", OldBlob: a, NewBlob: zero},
		{Status: "A", Score: -1, Path: "new file\twith tab.txt", OldMode: "000000", NewMode: "100644", OldBlob: zero, NewBlob: b},
		{Status: "D", Score: -1, Path: "gone.md", OldMode: "100644", NewMode: "000000", OldBlob: a, NewBlob: zero},
		{Status: "R", Score: 87, OldPath: ptr("old/name.ts"), Path: "new/name.ts", OldMode: "100644", NewMode: "100644", OldBlob: a, NewBlob: b},
		{Status: "C", Score: 100, OldPath: ptr("orig.ts"), Path: "copy.ts", OldMode: "100644", NewMode: "100644", OldBlob: a, NewBlob: a},
		{Status: "T", Score: -1, Path: "link", OldMode: "100644", NewMode: "120000", OldBlob: a, NewBlob: b},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v", got)
	}
}

func TestEmptyRawOutputMeansNoChanges(t *testing.T) {
	if got, err := ParseRaw(""); err != nil || len(got) != 0 {
		t.Errorf("%v %v", got, err)
	}
}

func TestRejectsMalformedRawOutput(t *testing.T) {
	for _, output := range []string{"src/app.ts\x00", ":100644 100644 " + a + " " + b + " R100\x00only-one\x00", ":100644 100644 " + a + " " + b + " X\x00p\x00"} {
		if _, err := ParseRaw(output); err == nil {
			t.Errorf("%q is an error", output)
		}
	}
}

func TestParsesNumstatRecordsRenamesAndBinaryFiles(t *testing.T) {
	stats := ParseNumstat("3\t1\ta.txt\x00-\t-\timg.png\x00" + "2\t0\t\x00old.txt\x00new.txt\x00")
	want := map[string]Stat{"a.txt": {Added: 3, Deleted: 1}, "img.png": {Binary: true}, "new.txt": {Added: 2}}
	if !reflect.DeepEqual(stats, want) {
		t.Errorf("got %+v", stats)
	}
}

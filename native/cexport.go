//go:build !js

package main

// #include <stdlib.h>
import "C"

import "unsafe"

// hs_parse returns NUL-terminated JSON to release with hs_free, or NULL on a parse error.
//export hs_parse
func hs_parse(src *C.char, n C.int, dialect C.int) *C.char {
	out := parseJSON(C.GoStringN(src, n), int(dialect))
	if out == nil {
		return nil
	}
	p := C.malloc(C.size_t(len(out) + 1))
	buf := unsafe.Slice((*byte)(p), len(out)+1)
	copy(buf, out)
	buf[len(out)] = 0
	return (*C.char)(p)
}

//export hs_free
func hs_free(p *C.char) { C.free(unsafe.Pointer(p)) }

func main() {}

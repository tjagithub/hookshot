// Package main is mvdan/sh for hookshot: the syntax tree as typed JSON, the shape `shfmt --to-json`
// prints. cexport.go builds it as a C library (Node-API, bun:ffi), jsexport.go as WASM.
package main

import (
	"bytes"
	"strings"

	"mvdan.cc/sh/v3/syntax"
	"mvdan.cc/sh/v3/syntax/typedjson"
)

const (
	dialectZsh  = 0
	dialectBash = 1
)

func variants(dialect int) []syntax.LangVariant {
	switch dialect {
	case dialectZsh:
		return []syntax.LangVariant{syntax.LangZsh}
	case dialectBash:
		return []syntax.LangVariant{syntax.LangBash}
	default:
		return []syntax.LangVariant{syntax.LangZsh, syntax.LangBash}
	}
}

// parseJSON: dialect -1 tries zsh then bash. Nil when src does not parse.
func parseJSON(src string, dialect int) []byte {
	for _, v := range variants(dialect) {
		f, err := syntax.NewParser(syntax.Variant(v), syntax.KeepComments(true)).Parse(strings.NewReader(src), "")
		if err != nil {
			continue
		}
		var buf bytes.Buffer
		if typedjson.Encode(&buf, f) == nil {
			return buf.Bytes()
		}
	}
	return nil
}

//go:build js

package main

import "syscall/js"

// Hands parse(src, dialect): string | null to globalThis.__hookshotRegister, which the loader sets
// only for the synchronous part of go.run(), then parks so the callback stays alive.
func main() {
	register := js.Global().Get("__hookshotRegister")
	if register.Type() != js.TypeFunction {
		panic("hsparse.wasm: load it through hookshot's src/parse.ts")
	}
	register.Invoke(js.FuncOf(func(_ js.Value, args []js.Value) any {
		out := parseJSON(args[0].String(), args[1].Int())
		if out == nil {
			return nil
		}
		return string(out)
	}))
	select {}
}

#!/usr/bin/env python3
"""Compare the Lua worker-frame builder in n2h_rpc.lua against seed-rop-chain.cjs.

Runs the Lua builder with a mock _G.n2h that records memcpy/memset into a fake
address space, then diffs the resulting frame against the Node implementation for
the same call list.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from lupa.lua51 import LuaRuntime

HERE = Path(__file__).resolve().parent
CHAIN = HERE.parent / "ns2jb-main" / "ns2jb-main" / "engine" / "switch2" / "app" / "seed-rop-chain.cjs"
SDK = 0x6B2C1A0000
MAIN = 0x6A1F400000
BASE = 0x7C00000000
LIMIT = 0x40000

CALLS = [
    {"function": SDK + 0x5224e0, "args": [BASE + 0x1000, 0, 0, 0]},
    {"function": SDK + 0x3f0000, "args": [0x240000, 0, 0, 0]},
    {"function": SDK + 0x5224e0, "args": [BASE + 0x1010, 0, 0, 0]},
    {"function": SDK + 0x410000, "args": [0x400000, 0, 0, 0]},
    {"function": SDK + 0x520000, "args": [BASE + 0x2000, BASE + 0x2008, 4, 0]},
    {"function": SDK + 0x5224e0, "args": [BASE + 0x3000, 0, {"u32": BASE + 0x1234}, 0]},
    {"function": SDK + 0x520000, "args": [BASE + 0x4000, 0, {"u32": BASE + 0x4008}, 0]},
    {"function": SDK + 0x430000, "args": [0, 1, 2, 3]},
]


def node_frame():
    src = f"""
const chain = require({json.dumps(str(CHAIN).replace('\\\\', '/'))});
const calls = {json.dumps(CALLS)};
const {{frame, proof}} = chain.build({BASE}, {LIMIT}, calls, {SDK}, {MAIN});
const fs = require('node:fs');
fs.writeFileSync('frame.bin', frame);
fs.writeFileSync('proof.json', JSON.stringify(proof));
"""
    with tempfile.TemporaryDirectory() as tmp:
        script = Path(tmp) / "gen.cjs"
        script.write_text(src)
        subprocess.run(["node", str(script)], check=True, cwd=tmp)
        frame = (Path(tmp) / "frame.bin").read_bytes()
        proof = json.loads((Path(tmp) / "proof.json").read_text())
    return frame, proof


LUA_PRELUDE = """
local MEMCPY, MEMSET = {memcpy}, {memset}
local mem, strs, nextstr = {{}}, {{}}, 0x20000000000
local n2h = {{sdk_base = {sdk}, main_base = {main}}}
function n2h.alloc(n)
  local a = nextstr
  nextstr = nextstr + 0x100000
  return a
end
function n2h.poke(addr, v) end
function n2h.str_addr(s)
  local a = 0x10000000000 + (#strs + 1) * 0x1000
  strs[a + 0x18] = s   -- data starts at TString+0x18
  return a
end
function n2h.call_deep(fn, a0, a1, a2, a3, a4)
  if fn == MEMCPY then
    local s = strs[a1]
    if s then
      for i = 1, a2 do mem[a0 + i - 1] = s:byte(i) end
    end
    return 0
  elseif fn == MEMSET then
    for i = 0, a2 - 1 do mem[a1 + i] = 0 end
    return 0
  end
  return 0
end
_G.n2h = n2h
function dump_mem(base, size)
  local t = {{}}
  for i = 0, size - 1 do t[#t + 1] = string.format("%02x", mem[base + i] or 0) end
  return table.concat(t)
end
"""


def main():
    frame, proof = node_frame()
    lua = LuaRuntime()
    prelude = LUA_PRELUDE.format(memcpy=hex(SDK + 0x5224e0), memset=hex(SDK + 0x522af0),
                                 sdk=SDK, main=MAIN)
    lua.execute(prelude)
    lua.execute((HERE.parent / "console" / "n2h_rpc.lua").read_text(encoding="utf-8"))
    build = lua.globals()["__rpc"]["build_frame"]
    calls = lua.eval("function() return {} end")()
    for i, call in enumerate(CALLS, 1):
        entry = lua.eval("function() return {} end")()
        entry["function"] = call["function"]
        args = lua.eval("function() return {} end")()
        for j, arg in enumerate(call["args"], 1):
            if isinstance(arg, dict):
                d = lua.eval("function() return {} end")()
                d["u32"] = arg["u32"]
                args[j] = d
            else:
                args[j] = arg
        entry["args"] = args
        calls[i] = entry
    result = build(BASE, LIMIT, calls)
    if result is None:
        print("Lua builder refused the frame")
        return 1
    lua_result = {}
    for key, value in result.items():
        if hasattr(value, "items"):
            value = [int(v) for _, v in sorted(value.items())]
        lua_result[key] = value
    size = int(lua_result["bytes"])
    got = bytes.fromhex(lua.globals()["dump_mem"](BASE, size))
    ok = True
    print(f"node size={len(frame)} lua size={size} proof bytes={proof['bytes']}")
    if size != len(frame):
        print(f"FAIL size: node proofs {proof['bytes']} vs lua {size}")
        ok = False
    if got != frame[:size]:
        for i, (a, b) in enumerate(zip(got, frame)):
            if a != b:
                print(f"FAIL first difference at 0x{i:x}: lua={a:02x} node={b:02x}")
                break
        ok = False
    else:
        print("frame bytes identical")
    for key in ("resultOffsets", "logicalResultIndices"):
        a = [int(x) for x in lua_result[key]]
        b = [int(x) for x in proof[key]]
        if a != b:
            print(f"FAIL {key}: lua={a} node={b}")
            ok = False
        else:
            print(f"{key} identical")
    for key in ("resultOffset", "cancelCell", "nativeCalls", "logicalCalls"):
        a, b = int(lua_result[key]), int(proof[key])
        if a != b:
            print(f"FAIL {key}: lua={a} node={b}")
            ok = False
        else:
            print(f"{key} identical ({a})")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

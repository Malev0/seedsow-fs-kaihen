-- Confirm the Seedsow SVC veneer bytes used by ro/control.cjs and worker-control.cjs.
local N = _G.n2h
local S = N.sdk_base
local function hex(addr, n)
    local buf = string.rep("\0", math.max(n, 8))
    N.call_deep(S + 0x5224e0, N.str_addr(buf) + 0x18, addr, n, 0, 0)
    return (buf:sub(1, n):gsub(".", function(c) return string.format("%02x", c:byte()) end))
end
print("signal  " .. hex(S + 0x168bac, 8))
print("clear   " .. hex(S + 0x168bb4, 8))
print("wait    " .. hex(S + 0x168bf4, 24))
print("thread  " .. hex(S + 0x168c74, 24))
print("info    " .. hex(S + 0x168ca4, 24))
print("cancel  " .. hex(S + 0x168c0c, 8))
print("release  " .. hex(S + 0x168c4c, 8))

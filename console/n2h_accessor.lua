-- Read-only mount walk: locate the "save" accessor and its borrowed session.
-- No MountTable::Find, no mutex, no writes.
--   curl.exe -s -X POST http://<console>:8080/eval --data-binary "@console\n2h_accessor.lua"
local N = _G.n2h
assert(N, "n2h missing")
local SDK = N.sdk_base
local MEMCPY, MEMSET, QUERY = SDK + 0x5224e0, SDK + 0x522af0, SDK + 0x168b0c
local HEAD = SDK + 0xB35868

local out = io.open("save:/acc.txt", "w")
local function P(s) if out then out:write(tostring(s) .. "\n"); out:flush() end end
local function hx(v) return string.format("0x%x", v or 0) end
local function u32(s, off)
    local a, b, c, d = s:byte(off + 1, off + 4)
    return a + b * 256 + c * 65536 + d * 16777216
end
local function u64(s, off) return u32(s, off) + u32(s, off + 4) * 4294967296 end
local function rd(addr, n)
    local buf = string.rep("\0", math.max(n, 64))
    N.call_deep(MEMCPY, N.str_addr(buf) + 0x18, addr, n, 0, 0)
    return buf:sub(1, n)
end
local function fields(info)
    return string.format("base=%s size=%s type=%s perm=%s",
        hx(u64(info, 0)), hx(u64(info, 8)), hx(u32(info, 16)), hx(u32(info, 24)))
end
local QBUF, QSTATE = N.alloc(0x40), N.alloc(0x10)
local function q(addr)
    N.call_deep(MEMSET, QBUF, 0, 0x40, 0, 0)
    N.call_deep(MEMSET, QSTATE, 0, 0x10, 0, 0)
    local rc = N.call_deep(QUERY, QBUF, QSTATE, addr, 0, 0)
    return rc, rd(QBUF, 0x28)
end
local function safe_read(addr, n)
    if not addr or addr == 0 then return nil end
    local rc, info = q(addr)
    local base, size, perm = u64(info, 0), u64(info, 8), u32(info, 24)
    if rc == 0 and size ~= 0 and (perm % 2) ~= 0 and addr >= base and addr + n <= base + size then
        return rd(addr, n)
    end
    return nil
end
local function cstr16(s) return (s:gsub("%z.*$", "")) end

P("start")
P(string.format("sdk=%s head=%s", hx(SDK), hx(HEAD)))
local hb = safe_read(HEAD, 0x20)
if not hb then
    P("head not readable")
else
    P("head bytes=" .. (hb:gsub(".", function(c) return string.format("%02x", c:byte()) end)))
    local nextp = u64(hb, 8)
    local found = nil
    for i = 1, 32 do
        if nextp == HEAD then break end
        local accessor = nextp - 8
        local ab = safe_read(accessor, 128)
        if not ab then
            P(string.format("entry %d accessor=%s unreadable", i, hx(accessor)))
            break
        end
        local name = cstr16(ab:sub(25, 40))
        local impl = u64(ab, 40)
        P(string.format("entry %d node=%s accessor=%s name=%q impl=%s next=%s",
            i, hx(nextp), hx(accessor), name, hx(impl), hx(u64(ab, 16))))
        if name == "save" then
            found = { accessor = accessor, impl = impl, bytes = ab }
            break
        end
        nextp = u64(ab, 16)
    end

    if not found then
        P("save accessor not found")
    else
        local ib = safe_read(found.impl, 0x60)
        if not ib then
            P("implementation unreadable")
        else
            local service = u64(ib, 16)
            P(string.format("impl=%s service=%s", hx(found.impl), hx(service)))
            local sb = safe_read(service, 0x80)
            if not sb then
                P("service unreadable")
            else
                local svt, manager, objectId = u64(sb, 0), u64(sb, 16), u32(sb, 24)
                P(string.format("service vtable=%s manager=%s objectId=%s", hx(svt), hx(manager), hx(objectId)))
                local mb = safe_read(manager, 0x80)
                if not mb then
                    P("manager unreadable")
                else
                    local m8, m5c, slots = u32(mb, 8), u32(mb, 0x5c), u64(mb, 16)
                    local sb4 = safe_read(slots, 4)
                    local borrowed = sb4 and u32(sb4, 0) or 0
                    P(string.format("manager state[8]=%s state[0x5c]=%s slots=%s borrowed=%s",
                        hx(m8), hx(m5c), hx(slots), hx(borrowed)))
                    P("manager bytes=" .. (mb:gsub(".", function(c) return string.format("%02x", c:byte()) end)))
                end
            end
        end
    end
end

N.free(QBUF); N.free(QSTATE)
P("done")
if out then out:close() end
local f = io.open("save:/acc.txt", "r")
if f then print(f:read("*a")); f:close() else print("acc none") end

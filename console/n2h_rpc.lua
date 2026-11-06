-- Seedsow RPC shim for the ns2jb host.
-- Loaded once per game process; persists as _G.__rpc.
-- Two transports: the legacy /eval calls (R.status/read/write/call/...) and the
-- persistent binary TCP server (R.serve) used by the fast bridge.
if _G.__rpc then return end
local N = _G.n2h
assert(N, "n2h missing")
local SDK, MAIN = N.sdk_base, N.main_base
local MEMCPY, MEMSET = SDK + 0x5224e0, SDK + 0x522af0
local QUERY, SEND, CLOSE = SDK + 0x168b0c, SDK + 0x168c54, SDK + 0x168be4
local GETSERVICE = SDK + 0x14cc90
local SETPERM = SDK + 0x168aec
local ALLOC, FREE = 0x139ea0, 0x139ec0
local MAIN_MALLOC, MAIN_FREE = MAIN + 0x262160, MAIN + 0x2621b0

local function rd(addr, n)
    local buf = string.rep("\0", math.max(n, 64))
    N.call_deep(MEMCPY, N.str_addr(buf) + 0x18, addr, n, 0, 0)
    return buf:sub(1, n)
end
local function wr(addr, s)
    N.call_deep(MEMCPY, addr, N.str_addr(s) + 0x18, #s, 0, 0)
end
local function hex(s)
    return (s:gsub(".", function(c) return string.format("%02x", c:byte()) end))
end
local function unhex(s)
    return (s:gsub("%x%x", function(h) return string.char(tonumber(h, 16)) end))
end
local function u32(s, off)
    local a, b, c, d = s:byte(off + 1, off + 4)
    return a + b * 256 + c * 65536 + d * 16777216
end
local function u64(s, off) return u32(s, off) + u32(s, off + 4) * 4294967296 end
local function u64s(v)
    v = v or 0
    local t = {}
    -- Write two's complement for negative results too. The old path added
    -- 2^32, which turned a 32-bit -1 into 0x00000000ffffffff and made the
    -- signed aux field read back positive.
    for i = 1, 8 do
        local q = math.floor(v / 256)
        t[i] = string.char(v - q * 256)
        v = q
    end
    return table.concat(t)
end
local function signed(v)
    v = v or 0
    if v >= 9223372036854775808 then v = v - 18446744073709551616
    elseif v >= 2147483648 and v < 4294967296 then v = v - 4294967296 end
    return v
end
local function put8(s, off, val) return s:sub(1, off) .. val .. s:sub(off + 9) end

-- Shared transport buffers. Allocated on the first R.serve: a reply is built
-- directly in PAY (24-byte header, then the payload) and sent with one write.
local RX, PAY, RXADDR, PAYADDR, PFD, PFDADDR, OPTADDR
local function ensureBuffers()
    if not PAY then
        RX = string.rep("\0", 0x100)
        PAY = string.rep("\0", 0x90000)
        PFD = string.rep("\0", 0x10)
        RXADDR, PAYADDR = N.str_addr(RX) + 0x18, N.str_addr(PAY) + 0x18
        PFDADDR = N.str_addr(PFD) + 0x18
        OPTADDR = N.alloc(0x10)
        assert(OPTADDR and OPTADDR ~= 0, "socket option alloc failed")
        wr(OPTADDR, u64s(1))
    end
end
-- Copy into the response buffer (used for reads and native output blocks).
local function rawFrom(addr, n)
    N.call_deep(MEMCPY, PAYADDR + 24, addr, n, 0, 0)
    return n
end
-- Copy into the read scratch area and return a Lua string (parsing only).
local function scratch(addr, n)
    N.call_deep(MEMCPY, PAYADDR, addr, n, 0, 0)
    return PAY:sub(1, n)
end

local SCRATCH = N.alloc(0x80000)
assert(SCRATCH and SCRATCH ~= 0, "scratch alloc failed")
N.call_deep(MEMSET, SCRATCH, 0, 0x80000, 0, 0)
local INFO, ISTATE = N.alloc(0x40), N.alloc(0x10)
N.call_deep(MEMSET, INFO, 0, 0x40, 0, 0)
N.call_deep(MEMSET, ISTATE, 0, 0x10, 0, 0)

local function nativeCall(offset, a0, a1, a2, a3)
    if offset == ALLOC then
        local p = N.call_deep(MAIN_MALLOC, a2, 0, 0, 0, 0)
        N.poke(a0, p)
        return 0
    elseif offset == FREE then
        return N.call_deep(MAIN_FREE, a0, 0, 0, 0, 0)
    elseif offset == GETSERVICE then
        return N.call_deep(GETSERVICE, a0, a1, a2, 0, 0)
    elseif offset == SEND - SDK then
        return N.call_deep(SEND, a0, a1, a2, 0, 0)
    elseif offset == CLOSE - SDK then
        return N.call_deep(CLOSE, a0, 0, 0, 0, 0)
    elseif offset == MEMSET - SDK then
        return N.call_deep(MEMSET, a0, a1, a2, 0, 0)
    end
    return N.call_deep(SDK + offset, a0, a1, a2, a3, 0)
end

local R = {}
function R.status()
    return string.format("S %d %d %d seedsow", SDK, MAIN, SCRATCH)
end
function R.query(addr)
    N.call_deep(MEMSET, INFO, 0, 0x40, 0, 0)
    N.call_deep(MEMSET, ISTATE, 0, 0x10, 0, 0)
    local rc = N.call_deep(QUERY, INFO, ISTATE, addr, 0, 0)
    local i = rd(INFO, 0x28)
    return string.format("Q %d %d %d %d %d %d %d %d %d", rc,
        u64(i, 0), u64(i, 8), u32(i, 16), u32(i, 20), u32(i, 24), u32(i, 28), u32(i, 32), u32(rd(ISTATE, 4), 0))
end
function R.read(addr, n)
    if n <= 0 then return "D " end
    return "D " .. hex(rd(addr, n))
end
function R.write(addr, h)
    wr(addr, unhex(h))
    return "OK"
end
function R.verify(addr, h)
    local n = #h / 2
    local got = hex(rd(addr, n))
    if got == h:lower() then return "OK" end
    return "ERR " .. got
end
function R.prepare_worker(call4hex, longjmphex)
    local raw = N.alloc(0x4000)
    if not raw or raw == 0 then return "ERR alloc" end
    local page = raw
    local rem = page % 0x1000
    if rem ~= 0 then page = page + (0x1000 - rem) end
    N.call_deep(MEMSET, page, 0, 0x1000, 0, 0)
    wr(page, unhex(call4hex))
    wr(page + 0x100, unhex(longjmphex))
    local rc = N.call_deep(SETPERM, page, 0x1000, 5, 0, 0)
    if rc ~= 0 then return string.format("ERR %d", rc) end
    return string.format("W %d %d", page, page + 0x100)
end
function R.call(offset, a0, a1, a2, a3)
    local rc = nativeCall(offset, a0, a1, a2, a3)
    return string.format("R %.0f\nO %s", rc, hex(rd(SCRATCH + 0x4040, 0x40)))
end
function R.call_addr(addr, a0, a1, a2, a3)
    local rc = N.call_deep(addr, a0, a1, a2, a3, 0)
    return string.format("R %.0f\nO %s", rc, hex(rd(SCRATCH + 0x4040, 0x40)))
end

-- =====================================================================
-- Fast path: persistent TCP RPC + console-side worker builder.
--
-- Request header (64 bytes, little endian):
--   +0  u32 magic 'N2HR'   +4  u32 command
--   +8  u64 a0  +16 u64 a1  +24 u64 a2  +32 u64 a3  +40 u64 a4
--   +48 u32 payload length +52 u32 flags
-- Response header (32 bytes):
--   +0  u32 magic 'N2HR'   +4  u32 status (0 ok)
--   +8  u64 payload length +16 u64 aux (signed result)
-- =====================================================================
local SOCK = {
    isinit = SDK + 0x14d930, init = SDK + 0x14d960,
    socket = SDK + 0x14d4c0, bind = SDK + 0x14d3b0, listen = SDK + 0x14d440,
    accept = SDK + 0x14d380, recv = SDK + 0x14d300, send = SDK + 0x14d350,
    close = SDK + 0x14d510, fcntl = SDK + 0x14d560, errno = SDK + 0x14d820,
    tick = SDK + 0x137240, freq = SDK + 0x137270, sleep = SDK + 0x168b54,
    poll = SDK + 0x14de40, -- int poll(struct pollfd*, unsigned long, int timeout)
    setsockopt = SDK + 0x14ddc0, -- int setsockopt(int, int, int, const void*, unsigned int)
}
local MAGIC = 0x5248324e -- 'N2HR' as a little-endian u32
local MAGIC4 = u64s(MAGIC):sub(1, 4)
local ZERO8 = string.rep("\0", 8)
local SENTINEL = string.char(16, 50, 84, 118, 152, 186, 220, 254) -- 0xfedcba9876543210 LE
local REGION, JOBOFF, STACK = 0x90, 0x60, 0x8000
local PTHREAD_CREATE, PTHREAD_JOIN, PTHREAD_EXIT = SDK + 0x142180, SDK + 0x142480, SDK + 0x142410
-- Seedsow libc: affinity must be set on the attribute before creation
-- (pthread_setaffinity_np on a live thread returns EINVAL); priority is 5..35
-- with 5 the highest accepted value.
local PTHREAD_ATTR_INIT, PTHREAD_ATTR_DESTROY = SDK + 0x1426c0, SDK + 0x142700
local PTHREAD_ATTR_SETAFFINITY, PTHREAD_SETPRIO = SDK + 0x1428f0, SDK + 0x141d80
local AVAILABLE_CORES = SDK + 0x1371e0
local LONGJMP, VCALL8 = SDK + 0x5511b4, SDK + 0x3d9e54
local G_CALL2, G_STORE = MAIN + 0xc27d8, MAIN + 0x173db4

local nonblock = 0
local clock = nil
local function nowMs()
    if not clock then
        local f = N.call_deep(SOCK.freq, 0, 0, 0, 0, 0)
        clock = (f and f > 0) and (1000 / f) or 0
    end
    if clock == 0 then return os.time() * 1000 end
    return N.call_deep(SOCK.tick, 0, 0, 0, 0, 0) * clock
end
local function errno() return signed(N.call_deep(SOCK.errno, 0, 0, 0, 0, 0)) end
local function sleepNs(ns) N.call_deep(SOCK.sleep, ns, 0, 0, 0, 0) end
local function fcntl(fd, cmd, arg) return signed(N.call_deep(SOCK.fcntl, fd, cmd, arg or 0, 0, 0)) end

local function detectNonblock(fd)
    if nonblock ~= 0 then return nonblock end
    local flags = fcntl(fd, 3, 0)
    if flags < 0 then return 0 end
    for _, cand in ipairs({4, 0x800, 0x80, 0x2000, 1}) do
        fcntl(fd, 4, flags + cand)
        local got = fcntl(fd, 3, 0)
        if got == flags + cand then
            nonblock = cand
            fcntl(fd, 4, flags)
            return cand
        end
        fcntl(fd, 4, flags)
    end
    return 0
end
-- seed-rop-chain.cjs page-aligns every offset (its align() ignores the second
-- argument), so mirror that exactly.
local function align(n) return math.ceil(n / 4096) * 4096 end

-- Mirrors engine/switch2/app/seed-rop-chain.cjs.
local function buildFrame(base, limit, calls)
    if type(calls) ~= "table" or #calls == 0 then return nil, "worker has no calls" end
    local jobs, logical = {}, {}
    for _, call in ipairs(calls) do
        local args = call.args or {}
        local dynamic = {}
        for i = 1, 4 do
            if type(args[i]) == "table" then dynamic[#dynamic + 1] = i end
        end
        local callJobIndex = #jobs + #dynamic
        for _, i in ipairs(dynamic) do
            jobs[#jobs + 1] = {target = SDK + 0x5224e0, args = {0, args[i].u32, 4, 0},
                dynamic = {callJobIndex, i}}
        end
        local vals = {}
        for i = 1, 4 do
            local a = args[i]
            vals[i] = (type(a) == "table") and 0 or (a or 0)
        end
        jobs[#jobs + 1] = {target = call["function"], args = vals}
        logical[#logical + 1] = #jobs - 1   -- zero-based native-call index
    end

    local count = #jobs
    local chainStart = STACK
    local results = align(chainStart + count * REGION)
    local jobsBase = align(results + (count + 2) * 8)
    local size = align(jobsBase + count * JOBOFF)
    if size > limit then return nil, "frame exceeds reserved space" end

    for _, job in ipairs(jobs) do
        local d = job.dynamic
        if d then
            local at = chainStart + d[1] * REGION
            local jt = jobsBase + d[1] * JOBOFF
            local i = d[2]
            job.args[1] = base + (i <= 2 and (jt + (i == 1 and 0x50 or 0x38))
                or (at + (i == 3 and 0x10 or 0x18)))
        end
    end

    -- Assemble each area as one Lua string: every wr() costs a chain call, so
    -- the whole frame goes out in five copies instead of five per call.
    local offsets, regs, jobsData = {}, {}, {}
    for i, job in ipairs(jobs) do
        local r = string.rep("\0", REGION)
        r = put8(r, 0x00, u64s(job.args[1]))
        r = put8(r, 0x08, u64s(job.args[2]))
        r = put8(r, 0x10, u64s(job.args[3]))
        r = put8(r, 0x18, u64s(job.args[4]))
        r = put8(r, 0x48, u64s(G_CALL2))
        r = put8(r, 0x58, u64s(G_STORE))
        r = put8(r, 0x60, SENTINEL)
        r = put8(r, 0x68, u64s(base + results + (i - 1) * 8))
        r = put8(r, 0x78, u64s(i < count and VCALL8 or PTHREAD_EXIT))
        r = put8(r, 0x88, i < count and u64s(base + jobsBase + i * JOBOFF) or ZERO8)
        regs[i] = r

        local j = string.rep("\0", JOBOFF)
        j = put8(j, 0x38, u64s(job.args[2]))
        j = put8(j, 0x48, u64s(job.target))
        j = put8(j, 0x50, u64s(job.args[1]))
        jobsData[i] = j

        offsets[i] = results + (i - 1) * 8
    end

    local jmpbuf = string.rep("\0", 0x70)
    jmpbuf = put8(jmpbuf, 0x00, u64s(base + jobsBase))
    jmpbuf = put8(jmpbuf, 0x58, u64s(VCALL8))
    jmpbuf = put8(jmpbuf, 0x68, u64s(base + chainStart))

    N.call_deep(MEMSET, base, 0, limit, 0, 0)
    wr(base, jmpbuf)
    wr(base + chainStart, table.concat(regs))
    wr(base + results, string.rep(SENTINEL, count + 2))
    wr(base + jobsBase, table.concat(jobsData))

    local cancelJob = logical[math.min(2, #logical)]
    return {
        bytes = size, logicalCalls = #calls, nativeCalls = count,
        resultOffsets = offsets, logicalResultIndices = logical,
        resultOffset = offsets[count],
        cancelCell = base + jobsBase + cancelJob * JOBOFF + 0x48,
    }
end

local workers = {}
local workerCreates = 0
-- idleDeadline lets the serve loop release the launcher's /eval handler when the
-- bridge goes away (the launcher's HTTP thread is parked for the whole loop).
local RUN = {stop = false, conns = 0, requests = 0, idleMs = 90000, idleDeadline = 0}

-- Worker spec record (48 bytes): u64 base, limit, slot, snapshot, call count,
-- then u32 priority and u32 flags (bit 0 = pin at creation). Calls follow:
-- u64 function, u8 nargs, u8 dynamic[4], u16 pad, u64 args[4].
local CALLREC = 48
local function parseSpecs(b)
    local at, n = 8, u32(b, 0)
    local specs = {}
    for k = 1, n do
        local base, limit, slot, snapshot, count =
            u64(b, at), u64(b, at + 8), u64(b, at + 16), u64(b, at + 24), u64(b, at + 32)
        local priority, flags = u32(b, at + 40), u32(b, at + 44)
        at = at + 48
        local calls = {}
        for c = 1, count do
            local fn, nargs = u64(b, at), b:byte(at + 9)
            local args = {}
            for i = 1, 4 do
                local v = u64(b, at + 16 + (i - 1) * 8)
                args[i] = (b:byte(at + 9 + i) == 1) and {u32 = v} or v
            end
            calls[c] = {["function"] = fn, args = args}
            at = at + CALLREC
        end
        specs[k] = {base = base, limit = limit, slot = slot, snapshot = snapshot,
            priority = priority, affinity = (flags % 2) == 1, calls = calls}
    end
    return specs
end

local function startWorkers(specs)
    local out = {}
    local first = #workers
    local ok, err = pcall(function()
        for k, spec in ipairs(specs) do
            local base, limit, slot = spec.base, spec.limit, spec.slot
            if base % 4096 ~= 0 or limit < 0x1000 or slot % 8 ~= 0 or slot + 16 > base then
                error("invalid worker frame")
            end
            local proof, frameError = buildFrame(base, limit, spec.calls)
            if not proof then error(frameError) end
            if spec.snapshot and spec.snapshot > 0 then
                N.call_deep(MEMCPY, spec.snapshot, base, proof.bytes, 0, 0)
            end
            wr(slot, ZERO8 .. ZERO8)
            -- Optional thread tuning, requested per worker by the host:
            -- pin at creation (round robin, core 0 left to the RPC/main thread)
            -- and raise the scheduling priority so a fixed-schedule wave wakes
            -- promptly. Both are skipped when they would not fit or fail.
            local attr = 0
            if spec.affinity and proof.bytes <= limit - 0x100 then
                local allowed = signed(N.call_deep(AVAILABLE_CORES, 0, 0, 0, 0, 0))
                if not (allowed > 0) then allowed = 0x3f end
                allowed = allowed - allowed % 2
                if allowed == 0 then allowed = 2 end
                local bits, i = {}, 0
                while i < 32 do
                    local bit = 2 ^ i
                    if math.floor(allowed / bit) % 2 == 1 then bits[#bits + 1] = bit end
                    i = i + 1
                end
                local core = bits[(workerCreates % #bits) + 1]
                workerCreates = workerCreates + 1
                local attrAddr, setAddr = base + limit - 0x100, base + limit - 0x40
                N.call_deep(MEMSET, attrAddr, 0, 0x100, 0, 0)
                wr(setAddr, u64s(core))
                if signed(N.call_deep(PTHREAD_ATTR_INIT, attrAddr, 0, 0, 0, 0)) == 0 and
                    signed(N.call_deep(PTHREAD_ATTR_SETAFFINITY, attrAddr, 8, setAddr, 0, 0)) == 0 then
                    attr = attrAddr
                end
            end
            local rc = signed(N.call_deep(PTHREAD_CREATE, slot, attr, LONGJMP, base, 0))
            if attr ~= 0 then N.call_deep(PTHREAD_ATTR_DESTROY, attr, 0, 0, 0, 0) end
            if rc ~= 0 then error(string.format("pthread_create %d", rc)) end
            local thread = u64(scratch(slot, 8), 0)
            if not (thread > 0 and thread < 281474976710656) then error("invalid thread") end
            if spec.priority and spec.priority > 0 then
                N.call_deep(PTHREAD_SETPRIO, thread, spec.priority, 0, 0, 0)
            end
            local w = {base = base, slot = slot, thread = thread, snapshot = spec.snapshot or 0,
                proof = proof, joined = false, index = #workers + 1}
            workers[#workers + 1] = w
            out[#out + 1] = {thread = thread, bytes = proof.bytes, resultOffset = proof.resultOffset,
                cancelCell = proof.cancelCell, index = #workers, proof = proof,
                startCell = u64(scratch(base + proof.resultOffset, 8), 0)}
        end
    end)
    if not ok then
        -- Keep the table consistent. Threads that were already created are
        -- intentionally not joined here: a parallel worker may be parked or
        -- blocked in a native call, and blocking the RPC loop is worse.
        for i = #workers, first + 1, -1 do workers[i] = nil end
        return nil, tostring(err)
    end
    return out
end

-- A blocking pthread_join inside this loop freezes the whole RPC transport when a
-- worker is still parked (e.g. waiting on a gate that never fires). Wait for the
-- chain to store every result cell first, bounded, then join (which is immediate).
local JOIN_WAIT_MS = 10000
local function waitForCells(w, waitMs)
    local cells = w.proof.resultOffsets
    local deadline = nowMs() + waitMs
    local raw, filled
    while true do
        raw = scratch(w.base + cells[1], #cells * 8)
        filled = 0
        for i = 1, #cells do
            if raw:sub((i - 1) * 8 + 1, i * 8) ~= SENTINEL then filled = filled + 1 end
        end
        if filled == #cells then return raw, nil end
        if nowMs() > deadline then
            return nil, string.format("worker %d is still running (%d/%d results after %d ms)",
                w.index or 0, filled, #cells, waitMs)
        end
        sleepNs(2000000)
    end
end

local function joinWorkers(indices)
    local out = {}
    for _, idx in ipairs(indices) do
        local w = workers[idx]
        if not w or w.joined then return nil, "worker is not owned" end
        local cells = w.proof.resultOffsets
        local raw, waiting = waitForCells(w, JOIN_WAIT_MS)
        if not raw then return nil, waiting end
        local rc = signed(N.call_deep(PTHREAD_JOIN, w.thread, w.slot + 8, 0, 0, 0))
        if rc ~= 0 then return nil, string.format("pthread_join %d", rc) end
        for i = 1, #cells do
            if raw:sub((i - 1) * 8 + 1, i * 8) == SENTINEL then
                return nil, "native batch did not store every result"
            end
        end
        local last = u64(raw, (#cells - 1) * 8)
        local exitValue = u64(scratch(w.slot + 8, 8), 0)
        if exitValue ~= last then return nil, "thread exit result differs" end
        local values = {}
        for i, li in ipairs(w.proof.logicalResultIndices) do
            values[i] = u64(raw, li * 8)
        end
        w.joined = true
        out[#out + 1] = {index = idx, values = values, thread = w.thread, exitValue = exitValue}
    end
    return out
end

local function encodeStarted(list)
    local parts = {u64s(#list):sub(1, 4) .. string.rep("\0", 4)}
    for _, w in ipairs(list) do
        local p = w.proof
        parts[#parts + 1] = u64s(w.thread) .. u64s(p.bytes) .. u64s(p.resultOffset)
            .. u64s(p.cancelCell) .. u64s(w.startCell) .. u64s(w.index)
            .. u64s(#p.resultOffsets):sub(1, 4) .. u64s(#p.logicalResultIndices):sub(1, 4)
        for _, off in ipairs(p.resultOffsets) do parts[#parts + 1] = u64s(off) end
        for _, li in ipairs(p.logicalResultIndices) do parts[#parts + 1] = u64s(li):sub(1, 4) end
    end
    return table.concat(parts)
end

local function encodeJoined(list)
    local parts = {u64s(#list):sub(1, 4) .. string.rep("\0", 4)}
    for _, w in ipairs(list) do
        parts[#parts + 1] = u64s(w.exitValue) .. u64s(#w.values)
        for _, v in ipairs(w.values) do parts[#parts + 1] = u64s(v) end
    end
    return table.concat(parts)
end

local function dispatch(cmd, a0, a1, a2, a3, a4, payload)
    if cmd == 1 then -- status
        return 0, 0, string.format("S\0%d\0%d\0%d\0seedsow", SDK, MAIN, SCRATCH)
    elseif cmd == 2 then -- call by sdk offset
        local rc = signed(nativeCall(a0, a1, a2, a3, a4))
        return 0, rc, nil, rawFrom(SCRATCH + 0x4040, 0x40)
    elseif cmd == 3 then -- call by absolute address
        local rc = signed(N.call_deep(a0, a1, a2, a3, a4, 0))
        return 0, rc, nil, rawFrom(SCRATCH + 0x4040, 0x40)
    elseif cmd == 4 then -- read
        if a1 <= 0 then return 0, 0, "" end
        if a1 > #PAY - 24 then return 1, 0, "read exceeds the reply buffer" end
        return 0, 0, nil, rawFrom(a0, a1)
    elseif cmd == 5 then -- write (payload already sits at PAYADDR)
        N.call_deep(MEMCPY, a0, PAYADDR, #payload, 0, 0)
        return 0, 0, ""
    elseif cmd == 6 then -- query
        local rc = signed(N.call_deep(QUERY, INFO, ISTATE, a0, 0, 0))
        local i = scratch(INFO, 0x28)
        local st = scratch(ISTATE, 4) -- reuses PAYADDR; parse i first
        return 0, rc, u64s(u64(i, 0)) .. u64s(u64(i, 8)) .. u64s(u32(i, 16))
            .. u64s(u32(i, 20)) .. u64s(u32(i, 24)) .. u64s(u32(i, 28))
            .. u64s(u32(i, 32)) .. u64s(u32(st, 0))
    elseif cmd == 7 then -- verify hex against memory
        local n = #payload / 2
        return 0, hex(rd(a0, n)) == payload:lower() and 0 or 1, ""
    elseif cmd == 8 then -- workers start
        local out, err = startWorkers(parseSpecs(payload))
        if not out then return 1, 0, tostring(err) end
        return 0, #out, encodeStarted(out)
    elseif cmd == 9 then -- workers join
        local n = u32(payload, 0)
        local idx = {}
        for i = 1, n do idx[i] = u32(payload, 8 + (i - 1) * 4) end
        local out, err = joinWorkers(idx)
        if not out then return 1, 0, tostring(err) end
        return 0, #out, encodeJoined(out)
    elseif cmd == 10 then -- ping
        return 0, a0, ""
    elseif cmd == 11 then -- stop the serve loop
        RUN.stop = true
        return 0, 0, ""
    elseif cmd == 12 then -- run a Lua chunk, capture print
        local out = {}
        local old = print
        print = function(...)
            local t = {}
            for i = 1, select("#", ...) do t[i] = tostring(select(i, ...)) end
            out[#out + 1] = table.concat(t, "\t")
        end
        local chunk, cerr = loadstring(payload)
        local ok, err = false, cerr
        if chunk then ok, err = pcall(chunk) end
        print = old
        if not ok then return 1, 0, tostring(err) end
        return 0, 0, table.concat(out, "\n")
    end
    return 1, 0, "unknown command"
end

-- struct pollfd { int fd; short events; short revents; } (8 bytes), POLLIN = 1.
local function pollIn(fd, timeoutMs)
    wr(PFDADDR, string.char(fd % 256, math.floor(fd / 256) % 256,
        math.floor(fd / 65536) % 256, math.floor(fd / 16777216) % 256, 1, 0, 0, 0))
    return signed(N.call_deep(SOCK.poll, PFDADDR, 1, timeoutMs, 0, 0)) > 0
end

local function recvAll(cs, addr, n, deadline)
    local got = 0
    while got < n do
        if not pollIn(cs, 500) then
            local limit = math.min(deadline, RUN.idleDeadline)
            if nowMs() > limit then return got, "timeout" end
        else
            local rc = signed(N.call_deep(SOCK.recv, cs, addr + got, n - got, 0, 0))
            if rc > 0 then
                got = got + rc
            elseif rc == 0 then
                return got, "eof"
            else
                local e = errno()
                if e ~= 11 and e ~= 35 then return got, "errno " .. e end
            end
        end
    end
    return got
end

local function sendAll(cs, addr, n, deadline)
    local sent = 0
    while sent < n do
        local rc = signed(N.call_deep(SOCK.send, cs, addr + sent, n - sent, 0, 0))
        if rc > 0 then
            sent = sent + rc
        else
            local e = errno()
            if e ~= 11 and e ~= 35 then return false, "errno " .. e end
            if nowMs() > deadline then return false, "timeout" end
            sleepNs(300000)
        end
    end
    return true
end

-- One write per reply: a header send followed by a payload send stalls ~40 ms
-- on Nagle + delayed ACK.
local function sendReply(cs, status, aux, payload, rawLen)
    local len = rawLen or #(payload or "")
    local hdr = MAGIC4 .. u64s(status):sub(1, 4) .. u64s(len) .. u64s(aux)
    if len > 0 and not rawLen then wr(PAYADDR + 24, payload) end
    wr(PAYADDR, hdr)
    return sendAll(cs, PAYADDR, 24 + len, nowMs() + 60000)
end

local function serveClient(cs, deadline)
    RUN.conns = RUN.conns + 1
    while not RUN.stop do
        local got, err = recvAll(cs, RXADDR, 64, deadline)
        if got < 64 then return err end
        local h = RX
        if u32(h, 0) ~= MAGIC then return "bad magic" end
        local cmd = u32(h, 4)
        local a0, a1, a2, a3, a4 = u64(h, 8), u64(h, 16), u64(h, 24), u64(h, 32), u64(h, 40)
        local plen = u32(h, 48)
        if plen > #PAY then return "payload too large" end
        local payload = ""
        if plen > 0 then
            local n2, e2 = recvAll(cs, PAYADDR, plen, deadline)
            if n2 < plen then return e2 end
            payload = PAY:sub(1, plen)
        end
        RUN.requests = RUN.requests + 1
        RUN.idleDeadline = nowMs() + RUN.idleMs
        local ok, status, aux, out, rawLen = pcall(dispatch, cmd, a0, a1, a2, a3, a4, payload)
        if not ok then
            status, aux, out, rawLen = 1, 0, tostring(status), nil
        end
        if not sendReply(cs, status, aux, out, rawLen) then return "send" end
    end
    return "stop"
end

function R.serve(port, seconds, idleSeconds)
    port = port or 39380
    seconds = seconds or 900
    RUN.idleMs = (idleSeconds or 90) * 1000
    ensureBuffers()
    if signed(N.call_deep(SOCK.isinit, 0, 0, 0, 0, 0)) == 0 then
        N.call_deep(SOCK.init, 0, 0, 0, 0, 0)
    end
    local fd = signed(N.call_deep(SOCK.socket, 2, 1, 0, 0, 0))
    if fd < 0 then return "ERR socket " .. errno() end
    local sa = N.alloc(0x40)
    if not sa or sa == 0 then
        N.call_deep(SOCK.close, fd, 0, 0, 0, 0)
        return "ERR sockaddr alloc"
    end
    N.call_deep(MEMSET, sa, 0, 0x40, 0, 0)
    wr(sa, string.char(2, 0, math.floor(port / 256) % 256, port % 256) .. string.rep("\0", 12))
    local rc = signed(N.call_deep(SOCK.bind, fd, sa, 16, 0, 0))
    if rc ~= 0 then
        N.call_deep(SOCK.close, fd, 0, 0, 0, 0)
        return "ERR bind " .. errno()
    end
    rc = signed(N.call_deep(SOCK.listen, fd, 8, 0, 0, 0))
    if rc ~= 0 then
        N.call_deep(SOCK.close, fd, 0, 0, 0, 0)
        return "ERR listen " .. errno()
    end
    -- poll() bounds the accept wait, so a dead bridge cannot wedge /eval.
    local nb = detectNonblock(fd)
    if nb ~= 0 then fcntl(fd, 4, fcntl(fd, 3, 0) + nb) end
    RUN.stop = false
    local started = nowMs()
    local deadline = started + seconds * 1000
    RUN.idleDeadline = started + RUN.idleMs
    local conns = 0
    print(string.format("RPC SERVE port=%d fd=%d nonblock=%d", port, fd, nb))
    while not RUN.stop and nowMs() < deadline and nowMs() < RUN.idleDeadline do
        if pollIn(fd, 1000) then
            local cs = signed(N.call_deep(SOCK.accept, fd, 0, 0, 0, 0))
            if cs >= 0 then
                conns = conns + 1
                if nb ~= 0 then fcntl(cs, 4, fcntl(cs, 3, 0) + nb) end
                -- TCP_NODELAY (IPPROTO_TCP=6, option 1) keeps small replies prompt.
                N.call_deep(SOCK.setsockopt, cs, 6, 1, OPTADDR, 4)
                serveClient(cs, deadline)
                N.call_deep(SOCK.close, cs, 0, 0, 0, 0)
            else
                print("rpc: accept errno " .. errno())
            end
        end
    end
    N.call_deep(SOCK.close, fd, 0, 0, 0, 0)
    return string.format("SERVE DONE conns=%d requests=%d", conns, RUN.requests)
end

R.workers = workers
R.build_frame = buildFrame
_G.__rpc = R
print("RPC READY")

-- Frame pump for n2h_rpc.lua, in its own file because the save upload endpoint
-- rejects bodies over the http.lua REQ_CAP (0x8000 = 32768 on this save).
-- Serves the RPC socket from the game's frame handler instead of a blocking
-- loop, so the launcher can still render, suspend and close the game.
-- Loaded by n2h_rpc.lua R.serve via loadfile("save:/n2h_pump.lua").
return function(C)
    local N, SOCK, RUN = C.N, C.SOCK, C.RUN
    local pump = nil

    local function shut(fd)
        if fd and fd >= 0 then pcall(function() N.call_deep(SOCK.close, fd, 0, 0, 0, 0) end) end
    end

    local function stop(reason)
        local p = pump
        if not p then return end
        pump = nil
        shut(p.c)
        shut(p.f)
        C.print(string.format("SERVE DONE conns=%d requests=%d (%s)", RUN.conns, RUN.requests, reason))
    end

    local function tick()
        local p = pump
        if not p then return end
        if RUN.stop then stop("stop") return end
        if C.nowMs() > p.deadline or C.nowMs() > RUN.idleDeadline then stop("deadline") return end
        if p.c and p.c >= 0 then
            -- Never enter recvAll without data: its poll sleeps 500 ms.
            if not C.pollIn(p.c, 0) then return end
            local err = C.serve(p.c, C.nowMs() + 8)
            if RUN.stop then stop("stop") return end
            if err ~= "timeout" then shut(p.c) p.c = nil end
            return
        end
        if not C.pollIn(p.f, 0) then return end
        local cs = C.signed(N.call_deep(SOCK.accept, p.f, 0, 0, 0, 0))
        if cs < 0 then return end
        if p.nb ~= 0 then C.fcntl(cs, 4, C.fcntl(cs, 3, 0) + p.nb) end
        N.call_deep(SOCK.setsockopt, cs, 6, 1, C.OPTADDR, 4)
        p.c = cs
    end

    -- Wrap the launcher's frame handler instead of replacing it. The original is
    -- kept in a global so a reload of this shim rewraps it instead of nesting,
    -- and so the closure always uses the current module's `pump`. Lua 5.1
    -- functions are not tables, so the marker cannot live on the function.
    local function install()
        if not (_G.e and _G.e.setEventHandler) then return false end
        local base = _G.__n2h_http_base
        if base == nil then
            base = _G.n2h_http_frame or false
            _G.__n2h_http_base = base
        end
        if base == false then base = nil end
        local function frame(...)
            if base then pcall(base, ...) end
            if pump then pcall(tick) end
        end
        _G.n2h_http_frame = frame
        pcall(function() _G.e:setEventHandler({onEnterFrame = "n2h_http_frame"}) end)
        return true
    end

    return {
        start = function(fd, nb, deadline)
            if not install() then return false end
            pump = {f = fd, nb = nb, deadline = deadline, c = nil}
            return true
        end,
        stop = stop,
    }
end

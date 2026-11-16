// A small native RO proof server. No runtime, heap, or absolute pointers.
typedef unsigned char u8;
typedef unsigned int u32;
typedef unsigned long long u64;
typedef long long s64;
typedef struct { u64 result, value; } Reply;

// Fresh names the stock RO never registered (no SM tombstone). All are in the
// FS NPDM's service list; the FS raw GetService resolves whichever one this
// payload wins. Keep in sync with ro/fresh-names.cjs.
#define FRESH_COUNT 5
static const char *fresh_names[FRESH_COUNT] = {
    "ins:r", "pm:bm", "psc:m", "bpmpmr:m", "fgm:test"
};

extern Reply connect_port(const char *name);
extern u32 send_request(u32 handle);
extern u32 close_handle(u32 handle);
extern void sleep_thread(s64 ns);
extern void exit_process(void);
extern Reply wait_handles(const u32 *handles, u32 count, s64 timeout);
// The kernel takes (out, handles, count, replyTarget, timeout) and returns the
// signaled index in x1. Keep the out slot and the handles array separate: the
// reply path needs out != NULL and handles == NULL with count 0.
extern Reply reply_receive(u32 *out, const u32 *handles, u32 count, u32 reply, s64 timeout);
extern Reply accept_session(u32 port);
extern Reply process_id(u32 handle);
extern Reply thread_id(u32 handle);
extern u64 system_tick(void);
extern u32 process_request(u32 command, const u64 *input, u32 bytes,
    u32 handle, u64 *output, u32 *output_bytes, void *receive, u64 receive_size);

static u32 *message(void) {
    u32 *p;
    __asm__ volatile("mrs %0, tpidrro_el0" : "=r"(p));
    return p;
}

static void clear(u32 *p) {
    for (u32 i = 0; i < 64; i++) p[i] = 0;
}

static u32 register_service(u32 sm, u32 space, const char *name, u32 *last_result) {
    u32 *p = message();
    clear(p);
    p[0] = 0x12;
    p[1] = 5;
    p[2] = space;
    for (u32 i = 0; name[i] && i < 8; i++) ((u8 *)p)[12 + i] = name[i];
    p[5] = 4; // max sessions; the following bool is false (normal IPC).
    u32 transport = send_request(sm);
    if (transport) { *last_result = transport; return 0; }
    if (p[0] != 0x12 || p[1] != 0x80000001 || p[2] != 0x20) {
        *last_result = 0xffffffff;
        return 0;
    }
    *last_result = p[4];
    return p[4] ? 0 : p[3];
}

// Drop a stale registration left by the stock RO. The stock and this payload
// share program id 0x0400000000000037, so SM may allow the replacement to
// release the name the dead process still owns. The main loop calls this for
// ro:dmnt (space 1) before registering it; the corrected result parse makes a
// denial exit the payload so aliveAfter distinguishes it.
static u32 unregister_service(u32 sm, u32 space, const char *name, u32 *last_result) {
    u32 *p = message();
    clear(p);
    p[0] = 0x13;
    p[1] = 3;
    p[2] = space;
    for (u32 i = 0; name[i] && i < 8; i++) ((u8 *)p)[12 + i] = name[i];
    u32 transport = send_request(sm);
    if (transport) { *last_result = transport; return 0; }
    if (p[0] != 0x13) { *last_result = 0xffffffff; return 0; }
    // The reply may carry a special header (PID/copies/moves); the result is
    // the first raw word after it. A plain error reply (no special header, as
    // the FS-side NotAllowed reply showed) has the result at p[2].
    u32 at = 2;
    if (p[1] >> 31) {
        u32 special = p[at++];
        if (special & 1) at += 2;
        at += (special >> 1 & 15) + (special >> 5 & 15);
    }
    *last_result = p[at];
    return p[at] ? 0 : 1;
}

static Reply respond(u32 session, u64 registration_result) {
    u32 *p = message();
    u32 at = 2, handle = 0, valid = p[0] == 4 || p[0] == 0x01000004;
    u64 receive_address = 0, receive_size = 0;
    if (valid && p[1] >> 31) {
        u32 special = p[at++];
        // Process probes accept one copied handle and an optional kernel PID.
        valid = (special & ~1u) == 2;
        if (special & 1) at += 2;
        if (valid) handle = p[at++];
    }
    if (valid && p[0] == 0x01000004) {
        // One kernel-validated receive map-alias buffer, used only for bulk reads.
        u32 flags = p[at + 2];
        receive_size = p[at] | ((u64)((flags >> 24) & 15) << 32);
        receive_address = p[at + 1] | ((u64)(flags >> 28) << 32) |
            ((u64)((flags >> 2) & 7) << 36);
        at += 3;
    }
    u32 raw_words = p[1] & 0x3ff;
    u32 end = at + raw_words;
    at = (at + 3) & ~3u;
    valid = valid && end <= 64 && end >= at + 4 && p[at] == 0x49434653;
    u32 command = valid ? p[at + 2] : 0;
    u64 output[24] = {0};
    u32 output_bytes = 48, result = 0xf601;
    Reply pid = process_id(0xffff8001), tid = thread_id(0xffff8000);
    u64 tick = system_tick();
    if (valid && command == 0x524f0001 && !handle && end >= at + 6) {
        output[0] = 0x4558454f5232534eULL;
        output[1] = ((u64 *)(p + at + 4))[0] ^ 0x9d7c3a51e6b2048fULL;
        output[2] = pid.value; output[3] = tid.value;
        output[4] = tick; output[5] = registration_result;
        result = 0;
    } else if (valid && handle) {
        result = process_request(command, (u64 *)(p + at + 4),
            (end - at - 4) * 4, handle, output, &output_bytes,
            (void *)receive_address, receive_size);
    }
    if (handle) close_handle(handle);
    clear(p);
    // Plain TIPC reply: command mirrors the request, raw data is aligned to 16
    // and runs from offset 8 to 32 + output_bytes. The count must cover the
    // full output (24 + output_bytes bytes, not 16 + output_bytes).
    p[0] = 4;
    p[1] = (24 + output_bytes + 3) / 4;
    p[4] = 0x4f434653; // SFCO
    p[6] = result;
    u64 *out = (u64 *)(p + 8);
    for (u32 i = 0; i < (output_bytes + 7) / 8; i++) out[i] = output[i];
    u32 index = 0;
    return reply_receive(&index, 0, 0, session, 0);
}

__attribute__((noreturn)) void main(void) {
    Reply connected;
    do {
        connected = connect_port("sm:");
        if (connected.result) sleep_thread(50000000);
    } while (connected.result);
    u32 sm = connected.value;
    u32 *p = message();
    clear(p);
    p[0] = 0x10;
    p[1] = 0x80000000;
    p[2] = 1;
    if (send_request(sm) || p[2]) for (;;) sleep_thread(1000000000);

    u32 ports[3 + FRESH_COUNT] = {0}, sessions[4] = {0, 0, 0, 0};
    u32 registration[3 + FRESH_COUNT] = {0};
    u32 fresh_done = 0;
    for (;;) {
        // Native RO registers ro:1 only in space 1. Space 2 is optional here.
        if (!ports[0]) ports[0] = register_service(sm, 2, "ro:1", &registration[0]);
        // If the stock RO still owns ro:dmnt, release SM's stale registration
        // (same program id as the stock). Exit if the unregister itself fails:
        // that distinguishes a still-held name from an accept/reply fault.
        if (!ports[1]) {
            u32 stale = 0;
            if (!unregister_service(sm, 1, "ro:dmnt", &stale)) exit_process();
            ports[1] = register_service(sm, 1, "ro:dmnt", &registration[1]);
            if (!ports[1]) exit_process();
            // Self-test: the kernel named-port path must resolve our own port.
            // Exit on either failure so aliveAfter is decisive: 0 means the
            // name resolves to our port AND it accepts; 527 means the connect
            // failed (no kernel name) or our port could not accept (the name
            // resolves to the dead stock entry, or the registered handle is
            // not a port).
            Reply self = connect_port("ro:dmnt");
            if (self.result) exit_process();
            Reply accepted = accept_session(ports[1]);
            if (accepted.result) exit_process();
            close_handle(self.value);
            close_handle(accepted.value);
        }
        // The FS (space 1) can reach ldr:ro. The stock's ldr:ro entry is a
        // proxy; try to release it (same program id) and register our own in
        // space 1 so the FS raw GetService resolves our live port. Best effort:
        // do not exit, so a denial leaves the payload alive for diagnosis.
        if (!ports[2]) {
            u32 stale = 0;
            (void)unregister_service(sm, 1, "ldr:ro", &stale);
            ports[2] = register_service(sm, 1, "ldr:ro", &registration[2]);
        }
        // Fresh space-1 names: the stock RO never owned these, so SM has no
        // dead tombstone and its first match is our live port. Try them in
        // order and stop at the first success: only one fresh name is
        // registered, so an unnecessary registration of a later (possibly
        // reserved) name cannot wedge SM the way ro:2 did. The FS probes the
        // same order and finds ours at the first free candidate.
        if (!fresh_done) {
            u32 fresh_index = FRESH_COUNT;
            for (u32 i = 0; i < FRESH_COUNT; i++) {
                u32 port = register_service(sm, 1, fresh_names[i], &registration[3 + i]);
                if (!port) continue;
                ports[3 + i] = port;
                if (fresh_index == FRESH_COUNT) fresh_index = i;
            }
            fresh_done = 1;
            // Register every listed name: SM allows a duplicate registration,
            // so a name already owned by a system module still returns a port,
            // but SM's GetService keeps returning that module's (dead) session.
            // Only a genuinely free name resolves to this payload. Exit if none
            // registered so aliveAfter is decisive.
            if (fresh_index == FRESH_COUNT) exit_process();
            // Self-test the first registered name like ro:dmnt.
            Reply fresh_self = connect_port(fresh_names[fresh_index]);
            if (fresh_self.result) exit_process();
            Reply fresh_accepted = accept_session(ports[3 + fresh_index]);
            if (fresh_accepted.result) exit_process();
            close_handle(fresh_self.value);
            close_handle(fresh_accepted.value);
        }
        // Poll every port for a pending connection before waiting. The direct
        // AcceptSession path is the one the self-test proves; it does not depend
        // on ReplyAndReceive's port index. The SM's GetService connects
        // asynchronously, so the port may be signaled before we wait.
        for (u32 i = 0; i < 3 + FRESH_COUNT; i++) {
            if (!ports[i]) continue;
            Reply extra = accept_session(ports[i]);
            if (extra.result) continue;
            u32 free_slot = 0;
            while (free_slot < 4 && sessions[free_slot]) free_slot++;
            if (free_slot < 4) sessions[free_slot] = extra.value;
            else close_handle(extra.value);
        }
        // DIAGNOSTIC: wait on accepted sessions only. The ports are polled at
        // the top of the loop, so a port connection must be picked up by the
        // poll; this removes any dependence on ReplyAndReceive signalling a
        // port handle (the previous run never accepted, aliveAfter 0).
        u32 handles[16], kinds[16], count = 0;
        for (u32 i = 0; i < 4; i++) if (sessions[i]) {
            handles[count] = sessions[i]; kinds[count++] = (3 + FRESH_COUNT) + i;
        }
        if (!count) { sleep_thread(1000000); continue; }
        // A receive without a reply target needs a blank receive header.
        // Keep the index out-slot separate from the handles array: passing the
        // same pointer lets the kernel write the index over handles[0].
        clear(message());
        u32 index = 0;
        Reply ready = reply_receive(&index, handles, count, 0, 50000000);
        if (ready.result) {
            if (ready.result == 0xf601 && ready.value < count &&
              kinds[ready.value] >= 3 + FRESH_COUNT) {
                u32 slot = kinds[ready.value] - (3 + FRESH_COUNT);
                close_handle(sessions[slot]); sessions[slot] = 0;
            }
            continue;
        }
        if (ready.value >= count) continue;
        u32 kind = kinds[ready.value];
        if (kind >= 3 + FRESH_COUNT) {
            u32 slot = kind - (3 + FRESH_COUNT);
            if (message()[0] == 2) {
                close_handle(sessions[slot]); sessions[slot] = 0;
            } else {
                Reply sent = respond(sessions[slot], ((u64)registration[1] << 32) | registration[0]);
                if (sent.result == 0xf601) { close_handle(sessions[slot]); sessions[slot] = 0; }
            }
        }
        // A port signal: the next iteration's poll accepts it.
    }
}

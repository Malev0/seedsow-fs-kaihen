// Minimal replacement ldr:ro frontend for the Seedsow app.
//
// Registers ldr:ro in the application's space (2), implements
// RegisterProcessHandle (cmd 4), a reachability stub for
// MapManualLoadModuleMemory (cmd 0), and a read-only diagnostic on ldr:ro
// itself (the app cannot open ro:dmnt).
//
// First build: cmd 0 returns 0x4242 so the app's nro-test proves it reached
// this payload. The self-test counters (connect/accept) are in the diagnostic
// so a failed registration/port is distinguishable from a failed session.

typedef unsigned char u8;
typedef unsigned int u32;
typedef unsigned long long u64;
typedef long long s64;
typedef struct { u64 result, value; } Reply;

extern Reply connect_port(const char *name);
extern u32 send_request(u32 handle);
extern u32 close_handle(u32 handle);
extern void sleep_thread(s64 ns);
extern void exit_process(void);
extern Reply reply_receive(u32 *out, const u32 *handles, u32 count, u32 reply, s64 timeout);
extern Reply accept_session(u32 port);
extern Reply process_id(u32 handle);
extern u32 map_process(u64 destination, u32 handle, u64 source, u64 size);
extern u32 unmap_process(u64 destination, u32 handle, u64 source, u64 size);
extern u32 map_code(u32 handle, u64 destination, u64 source, u64 size);
extern u32 unmap_code(u32 handle, u64 destination, u64 source, u64 size);
extern u32 process_permission(u32 handle, u64 address, u64 size, u32 permission);
extern Reply query_process(void *info, u32 handle, u64 address);
extern Reply query_memory(void *info, u64 address);

#define MAX_SESSIONS 4

static u32 session_proc[MAX_SESSIONS];
static u64 session_pid[MAX_SESSIONS];
static u32 diag_accept;
static u32 diag_dispatch;
static u32 diag_last_cmd;
static u32 diag_last_result;
static u32 diag_self_connect = 0xffffffff;
static u32 diag_self_accept = 0xffffffff;
static u32 diag_registration;
static u32 self_tested;

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
    p[5] = 4; // max sessions; normal (non-light) IPC
    u32 transport = send_request(sm);
    if (transport) { *last_result = transport; return 0; }
    if (p[0] != 0x12 || p[1] != 0x80000001 || p[2] != 0x20) {
        *last_result = 0xffffffff;
        return 0;
    }
    *last_result = p[4];
    return p[4] ? 0 : p[3];
}

static Reply respond(u32 session, u32 slot) {
    u32 *p = message();
    u32 at = 2, handle = 0, valid = p[0] == 4 || p[0] == 0x01000004;
    u64 receive_address = 0, receive_size = 0;
    if (valid && p[1] >> 31) {
        u32 special = p[at++];
        valid = (special & ~1u) == 2;
        if (special & 1) at += 2;
        if (valid) handle = p[at++];
    }
    if (valid && p[0] == 0x01000004) {
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
    if (valid) diag_last_cmd = command;
    if (valid && command == 4) {
        if (!handle) result = 0x1759;
        else {
            Reply pid = process_id(handle);
            if (pid.result || !pid.value) { result = 0x1759; close_handle(handle); }
            else {
                session_proc[slot] = handle;
                session_pid[slot] = pid.value;
                result = 0;
                // Keep the registered process handle: cmd 0 needs it.
                handle = 0;
            }
        }
    } else if (valid && command == 0) {
        if (end < at + 4 + 32) result = 0x1759;
        else result = 0x4242; // reachability stub
    } else if (valid && command == 1) {
        if (end < at + 4 + 8) result = 0x1759;
        else result = 0x4243;
    } else if (valid && command == 0x524f0018) {
        if (receive_size >= 0x110) {
            u32 *out = (u32 *)receive_address;
            for (u32 i = 0; i < 0x110 / 4; i++) out[i] = 0;
            out[0] = diag_accept;
            out[3] = diag_dispatch;
            out[8] = diag_last_cmd;
            out[9] = diag_last_result;
            out[10] = diag_self_connect;
            out[11] = diag_self_accept;
            out[12] = diag_registration;
            out[13] = session_pid[slot] & 0xffffffff;
            result = 0;
        } else result = 0x1759;
    } else if (valid) result = 0x1759;
    if (handle) close_handle(handle);
    diag_last_result = result;
    clear(p);
    p[0] = 4;
    p[1] = (24 + output_bytes + 3) / 4;
    p[4] = 0x4f434653; // SFCO
    p[6] = result;
    u64 *o = (u64 *)(p + 8);
    for (u32 i = 0; i < (output_bytes + 7) / 8; i++) o[i] = output[i];
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

    u32 port = 0, sessions[MAX_SESSIONS] = {0};
    for (;;) {
        // Application space only: space 1 is held by the stock/loader entry.
        if (!port) port = register_service(sm, 2, "ldr:ro", &diag_registration);
        if (port && !self_tested) {
            // Prove the registered port accepts a kernel named-port connection
            // before the app connects. The counters are in the diagnostic.
            Reply self = connect_port("ldr:ro");
            diag_self_connect = (u32)self.result;
            if (!self.result) {
                Reply accepted = accept_session(port);
                diag_self_accept = (u32)accepted.result;
                if (!accepted.result) close_handle(accepted.value);
                close_handle(self.value);
            }
            self_tested = 1;
        }
        if (port) {
            Reply extra = accept_session(port);
            if (!extra.result) {
                diag_accept++;
                u32 free = 0;
                while (free < MAX_SESSIONS && sessions[free]) free++;
                if (free < MAX_SESSIONS) {
                    sessions[free] = extra.value;
                    session_proc[free] = 0;
                    session_pid[free] = 0;
                } else close_handle(extra.value);
            }
        }
        u32 handles[MAX_SESSIONS], slots[MAX_SESSIONS], count = 0;
        for (u32 i = 0; i < MAX_SESSIONS; i++) if (sessions[i]) {
            handles[count] = sessions[i];
            slots[count++] = i;
        }
        if (!count) { sleep_thread(1000000); continue; }
        clear(message());
        u32 index = 0;
        Reply ready = reply_receive(&index, handles, count, 0, 50000000);
        if (ready.result) {
            if (ready.result == 0xf601 && ready.value < count) {
                close_handle(sessions[slots[ready.value]]);
                sessions[slots[ready.value]] = 0;
            }
            continue;
        }
        if (ready.value >= count) continue;
        u32 slot = slots[ready.value];
        if (message()[0] == 2) {
            close_handle(sessions[slot]);
            sessions[slot] = 0;
        } else {
            diag_dispatch++;
            Reply sent = respond(sessions[slot], slot);
            if (sent.result == 0xf601) {
                close_handle(sessions[slot]);
                sessions[slot] = 0;
            }
        }
    }
}

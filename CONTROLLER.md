# Writing a controller bridge

The exploit needs a way to press buttons on the console: to relaunch Seedsow
after a failed run, to walk the console menus, and to run the button sequences in
the controller panel. Any program that can press buttons can do this - a Pico W
wired to the console's controller port, an ESP32, a PC applet, a phone - as long
as it serves the small HTTP API below.

You do not need to touch this repository to add a controller. Implement the API,
point the controller at it, done.

---

## 1. Where the controller is

`controller-connection.json` in the repository root, one per machine:

```json
{
  "host": "127.0.0.1",
  "port": 39391
}
```

- `host` - where the bridge listens. `127.0.0.1` for a bridge on the same PC,
  or the bridge's LAN address.
- `port` - default 39391.
- `token` - optional. When it is a non-empty string, every request carries
  `Authorization: Bearer <token>`. When it is missing or empty, no header is
  sent. Use it if the bridge is reachable from other machines on the network;
  skip it for a local-only bridge.

The GUI and the CLI both read this file through `tools/controller.cjs`. The
environment variable `NS2_CONTROLLER_CONN` can point somewhere else, which is
handy for testing.

## 2. The API

All requests and answers are JSON. Times are in seconds. Every call must answer
within 15 seconds or the GUI reports a failure.

| Method | Path | Body | Answer |
|---|---|---|---|
| `GET` | `/status` | – | `{"ok":true,"controller":"ready"}` |
| `POST` | `/press` | `{"buttons":["A"]}` | `{"ok":true,"confirmed":true}` |
| `POST` | `/release` | `{"buttons":["A"]}` | `{"ok":true}` |
| `POST` | `/tap` | `{"buttons":["A"],"down":0.12,"up":0.16}` | `{"ok":true,"confirmed":true}` |
| `POST` | `/sequence` | `{"steps":[{"buttons":["A"],"hold":0.15,"gap":1.0}]}` | `{"ok":true}` |
| `POST` | `/stop` | – | `{"ok":true}` |

### `/status`

Answers whether the bridge is usable. `controller` is free-form; the GUI shows
it next to the connection indicator. Anything other than HTTP 200, or an
unreachable host, shows as "bridge: offline".

### `/press` and `/release`

Level control. `press` holds the listed buttons down and returns; `release`
lets them go. Between them the console sees the buttons as held. Use these when
you want the exploit to hold a button across several console screens.

`buttons` is 1-8 names. Press them together (a chord), not one after another.

### `/tap`

Press, wait `down` seconds, release, and - if the bridge supports it - wait `up`
seconds before answering. `down` and `up` are clamped to 0.04-5 and 0-5
seconds. This is what the GUI's button panel uses, and what `Restart Game`
sends step by step.

### `/sequence`

The same thing for an ordered list, timed on the controller. Each step:

- `buttons` - 1-8 names.
- `hold` - how long to keep them down (default 0.15).
- `gap` - how long to wait after releasing before the next step (default 0).

A bridge that does not implement `/sequence` is fine: the GUI notices the 404 and
falls back to sending each step as a separate `/tap`, so the timing is a little
less precise but everything works.

### `/stop`

Drop anything queued and release every button. The GUI sends this when a run is
stopped or the attempt is declared failed, so it must be safe to call at any
time, including when nothing is queued.

### Button names

```
A B X Y L R ZL ZR PLUS MINUS HOME CAPTURE L_STICK R_STICK
DPAD_UP DPAD_DOWN DPAD_LEFT DPAD_RIGHT
```

Unknown names are rejected by the client before the request is sent.

## 3. Answering well

- **`confirmed`**: `true` when the controller itself acknowledged the press.
  If your bridge only queues the press and cannot tell, leave the field out -
  the GUI then says nothing. `false` produces a warning in the log
  ("the controller did not confirm the press"), which is useful while you are
  bringing a new controller up.
- **Errors**: answer a non-2xx status with `{"error":"..."}`. The GUI prints that
  text in its log, so keep it short and specific.
- **One request at a time**: the GUI never calls concurrently, but a run can
  send several taps in a row. Queue them in order rather than dropping them.
- **Do the timing on the controller.** If the PC has to wait between steps, a
  slow USB or network hop turns a 150 ms tap into something much longer, and the
  console may miss it. `Restart Game` is the sensitive one: HOME, X, A, A, Y
  with 1 s between presses.
- **Idempotent `/stop`**: never fail it because nothing was queued.

## 4. A minimal bridge

This is a complete, working bridge for a local test: it logs the calls and
pretends to press. Replace the `press`/`release` bodies with whatever talks to
your hardware.

```js
// node controller-stub.cjs
const http = require('node:http');
let held = new Set();

http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const answer = value => {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify(value));
    };
    const input = body ? JSON.parse(body) : {};
    const press = list => { for (const b of list) held.add(b); };
    const release = list => { for (const b of list) held.delete(b); };

    if (req.method === 'GET' && req.url === '/status')
      return answer({ok: true, controller: 'ready', held: [...held]});
    if (req.url === '/press') { press(input.buttons || []); return answer({ok: true, confirmed: true}); }
    if (req.url === '/release') { release(input.buttons || []); return answer({ok: true}); }
    if (req.url === '/tap') {
      press(input.buttons || []);
      setTimeout(() => { release(input.buttons || []); answer({ok: true, confirmed: true}); },
        Math.round((input.down ?? 0.12) * 1000));
      return;
    }
    if (req.url === '/sequence') {
      const steps = input.steps || [];
      let delay = 0;
      for (const step of steps) {
        delay += Math.round((step.hold ?? 0.15) * 1000);
        setTimeout(() => press(step.buttons || []), delay - Math.round((step.hold ?? 0.15) * 1000));
        setTimeout(() => release(step.buttons || []), delay);
        delay += Math.round((step.gap ?? 0) * 1000);
      }
      setTimeout(() => answer({ok: true, confirmed: true}), delay);
      return;
    }
    if (req.url === '/stop') { held = new Set(); return answer({ok: true}); }
    res.writeHead(404, {'content-type': 'application/json'});
    res.end(JSON.stringify({error: 'no ' + req.url}));
  });
}).listen(39391, '127.0.0.1', () => console.log('controller stub on 39391'));
```

Run it, set `"host": "127.0.0.1", "port": 39391` in
`controller-connection.json`, start the GUI and the indicator turns to
"bridge: active". Pressing a button in the panel logs `[ctl] tap A (120 ms)`.

For an embedded bridge, the only real work is mapping names to your hardware's
button reporting and keeping the timing on the device. A Pico W that already
implements `/status` and `/tap` only needs `/press`, `/release` and `/sequence`
to be complete - and `/sequence` is optional because the GUI can fall back.

## 5. Checking it

`node tools/controller.cjs` is not a program; it is the client. To test a bridge
without the GUI, from a Node prompt:

```js
const c = require('./tools/controller.cjs');
await c.status();
await c.tap('HOME');
await c.sequence([{buttons: ['HOME'], hold: 0.15, wait: 1000},
                  {buttons: ['X'], hold: 0.15, wait: 1000}]);
```

Any failure names the call and the reason, which is the same message the GUI
log shows.

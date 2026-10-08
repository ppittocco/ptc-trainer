# PTC TRAINER for the GTA V browser port

Made by **@ppittocco**.

An in-game trainer for the WebAssembly build of GTA V served by `serve_local.py`. It works like a Menyoo-style menu: press **F8** in game, pick an option, and the menu calls the game's own script natives (`CREATE_VEHICLE`, `SET_ENTITY_COORDS`, `GIVE_WEAPON_TO_PED`, …).

PC mods such as Menyoo cannot be used here. They are `.asi` files loaded by ScriptHookV, which hooks the native `GTA5.exe`. The browser build has no `GTA5.exe`: the engine is `game.wasm` running inside the browser. This menu takes the same approach as ScriptHookV, but does it by patching the WebAssembly binary.

## Install

1. Copy the `PTC TRAINER` folder into the game folder (the one with `Launch-Local.cmd`, `runtime\` and `mirror\`).
2. Double-click `PTC TRAINER\Install-PTCTrainer.cmd`.
3. Start the game. If the server is already running, restart it. Then press **F8**.

To remove it, double-click `PTC TRAINER\Uninstall-PTCTrainer.cmd`. Every file goes back to how it was.

The installer checks every patch point before it changes anything. If the game files are a different version, it stops and leaves them untouched. Running it twice does nothing; uninstall first if you want to reinstall.

## Controls

| Key | Action |
|---|---|
| F8 | Open / close the menu |
| ↑ / ↓ | Move |
| Enter or → | Select |
| Backspace or ← | Back |

While the menu is open, these keys go to the menu instead of the game. Everything else still reaches the game.

## Features

- **Player:** god mode, never wanted, super jump, fast run and swim, invisible, no ragdoll, police ignore you, fill health and armour, clear the wanted level or set it to 5 stars.
- **Weapons:** give all weapons (9999 rounds), infinite ammo, remove all weapons.
- **Vehicles:** spawn about 50 vehicles in 9 categories (you are placed in the driver's seat), repair, speed boost, flip upright, vehicle god mode, delete the current vehicle.
- **Teleport:** to the map waypoint (searches for the ground height), or to 12 preset locations.
- **World:** time of day, 12 weather types.

## How it works

```
 page (index.html)                         engine worker (game.js + game_ptc.wasm)
 ┌──────────────────────┐                  ┌───────────────────────────────────────────┐
 │ ptc_ui.js           │  command (JSON)  │ rage::scrThread::Run()  ← a game script   │
 │  overlay + keys      │ ───────────────► │   activeThread = this                     │
 │                      │  mailbox in      │   wasm_module_int_js(thread, 'PTCT') ─┐   │
 │                      │  shared memory   │                                       ▼   │
 │                      │                  │   ptc_engine.js  __ptcTick()            │
 │                      │ ◄─────────────── │     reads mailbox, calls N_<NATIVE>()     │
 │  toasts, ON/OFF      │ BroadcastChannel │   …script continues                       │
 └──────────────────────┘   'ptc-trainer'     └───────────────────────────────────────────┘
```

### 1. The natives are already in `game.wasm`

`game.wasm` was shipped with its **name section**: about 91,000 C++ function names. Among them are 8,056 script-native wrappers such as

```
vehicle_commands::SetupScriptCommands()::scrWrapped_CREATE_VEHICLE::Call(rage::scrThread::Info&)
```

Each wrapper takes a `rage::scrThread::Info*`. The module uses **memory64** (64-bit pointers), and the layout is the same as on PC, which is also what ScriptHookV uses:

| Offset | Field |
|---|---|
| +0 | pointer to the result |
| +8 | parameter count |
| +16 | pointer to the parameters |
| +24 | buffer count |

Every parameter and result slot is 8 bytes. A vector takes three float slots (x, y, z), a string is a `char*`, and an output parameter (`float&`, `Entity*`) is a pointer to wasm memory.

### 2. `patch_wasm.py` builds `game_ptc.wasm`

`game.wasm` is never modified. The patcher writes a new `game_ptc.wasm` next to it, with two changes:

- **Exports.** Every native wrapper is exported as `N_<NAME>` (for example `N_CREATE_VEHICLE`), and `operator new(unsigned long)` as `ptc_alloc`, so JavaScript can allocate a scratch block.
- **A hook in `rage::scrThread::Run`.** Right after the instruction that makes the thread the active one (`activeThread = this`), it inserts:

  ```wasm
  local.get 0                ;; the script thread
  i32.const 0x50544354       ;; 'PTCT'
  call $wasm_module_int_js   ;; an existing import
  drop
  ```

No function is added and no import is added, so the function indices stay the same and the name section stays valid. The hook reuses `wasm_module_int_js`, an import the port already has: the magic value tells the JavaScript side that the call comes from the menu.

### 3. Running natives inside a real script thread

Many natives expect to run inside a script. For example, `CREATE_VEHICLE` calls `scrThread::GetActiveThread()` and the thread's script handler. Because the hook fires while a game script is the active thread, the menu's native calls run in a valid script context, just as ScriptHookV's do on PC.

The hook fires once per running script per frame. `ptc_engine.js` uses `GET_FRAME_COUNT` so the menu runs only once per frame.

Each frame, the engine side:

- runs the queued commands;
- advances multi-frame jobs, such as waiting for a vehicle model to stream in, or searching for the ground after a waypoint teleport;
- reapplies the toggles that need it every frame (super jump, never wanted, vehicle god mode, …).

Spawned vehicles are released with `SET_ENTITY_AS_NO_LONGER_NEEDED`, so the script that happened to run the menu does not own them.

### 4. Getting commands into the engine: a mailbox in shared memory

The engine's main thread is a web worker that stays inside the game loop and never returns to its event loop. It can **send** messages, but its `onmessage` handlers never run. So:

- **page → engine:** the page already receives the wasm memory (a `SharedArrayBuffer`) for keyboard input, and the installer exposes it as `window.__ptcMemory`. `ptc_ui.js` writes each command as JSON into a mailbox inside the menu's scratch block. The mailbox holds a sequence number, a length, a "last read" number and the data. The engine reads it once per frame and acknowledges it, and the page sends the next command only after that acknowledgement. Access goes through `Atomics`.
- **engine → page:** `BroadcastChannel('ptc-trainer')` carries the mailbox address (re-sent every 30 frames, in case the page loads late), the toggle states and the notifications.

### 5. The overlay

`ptc_ui.js` draws the menu as HTML on top of the game canvas and listens to the keyboard in the capture phase. That way it sees the keys before the port's own input handler, and keeps the menu keys away from the game while the menu is open.

## Files

**In this folder:**

| File | Purpose |
|---|---|
| `Install-PTCTrainer.cmd`, `Uninstall-PTCTrainer.cmd` | Double-click launchers. They use the game's bundled `runtime\python.exe`, or `python` from PATH. |
| `install.py` | Installer / uninstaller |
| `patch_wasm.py` | Builds `game_ptc.wasm` from `game.wasm`. Can also be run alone: `python patch_wasm.py <build folder>` |
| `files/ptc_engine.js` | Engine side: native calls, actions, per-frame logic |
| `files/ptc_ui.js` | Page side: overlay, keys, mailbox |

**What the installer changes in the game** (the build folder is `mirror/playgta5.com/b/<build>/`):

| File | Change |
|---|---|
| `b/<build>/game_ptc.wasm` | New: the patched engine |
| `b/<build>/ptc_engine.js`, `ptc_ui.js` | New: copied from `files/` |
| `b/<build>/game.js` | `wasm_module_int_js` forwards the magic call to `self.__ptcTick`; loads `ptc_engine.js` |
| `b/<build>/loader.js` | Downloads `game_ptc.wasm` instead of `game.wasm` |
| `index.html` | Exposes the wasm memory as `window.__ptcMemory`; loads `ptc_ui.js` |
| `serve_local.py` | Sends `Cache-Control: no-cache` for everything except `/data/`, so the browser never runs stale copies of edited files |

Before an edit, each file is saved as `<name>.orig`. Uninstall restores those copies and deletes the new files.

## Adding an option

1. In `files/ptc_engine.js`, add an entry to `actions`. Inside it, call natives with the helpers:

   ```js
   int('NATIVE_NAME', ...args)     // returns the int result
   vec('NATIVE_NAME', ...args)     // returns [x, y, z]
   native('NATIVE_NAME', ...args)  // returns { int, float, vec }
   ```

   Plain numbers are passed as int, booleans as 0/1, `F(x)` as float, `P(address)` as pointer and `S('text')` as string. `joaat('adder')` gives the model or weapon hash.

2. In `files/ptc_ui.js`, add an item to the menu tree:

   ```js
   A('Label', 'action', arg)   // run an action
   T('Label', 'toggleName')    // an ON/OFF toggle
   M('Label', [...items])      // a submenu
   ```

3. Run `Uninstall-PTCTrainer.cmd`, then `Install-PTCTrainer.cmd`.

Native names come from this build. Check that a name exists before you use it: some differ from the usual lists. For example, `PLAYER_ID` is `GET_PLAYER_INDEX` here.

## Limitations

- **Unknown models:** some vehicles in the list may not exist in this build. The menu then shows "Vehicle not found in this build".
- **Errors:** if a native call throws, the menu disables itself until the page is reloaded, so the game keeps running.
- **Build dependency:** the patch needs the name section in `game.wasm`. A build stripped of names cannot be patched. The installer reports that and changes nothing.
- **Debug tools:** the port's own debug tools still work alongside the menu:
  - `?args=-wasmtestcar=<model>` spawns a vehicle at start;
  - **Shift+P** switches the keyboard mode, and **F** in the debug mode toggles free flight.

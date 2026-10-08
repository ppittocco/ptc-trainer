// PTC TRAINER, engine side. Loaded by game.js in every engine worker; only the thread that runs the game scripts uses it.
// game_ptc.wasm (patch_wasm.py) calls wasm_module_int_js(thread, PTC_MAGIC) inside rage::scrThread::Run right
// after a script thread became the active one: game.js forwards that call to self.__ptcTick, which runs the queued menu
// commands with the script natives (exported as N_<NAME>) while a real script thread is active, as ScriptHookV does on PC.
// This worker is blocked in the engine's main loop, so it never gets message events: the page writes its commands into a mailbox in
// the shared wasm memory (ptc_ui.js), read here every frame. Replies and notifications go to the page on the 'ptc-trainer' BroadcastChannel.
(() => {
	'use strict';
	let channel = null, queue = [], scratch = 0, lastFrame = -1, failed = false;
	const toggles = { god: false, neverWanted: false, superJump: false, fastRun: false, invisible: false, noRagdoll: false, infAmmo: false, vehGod: false, police: false };
	const jobs = [];		// multi-frame work (model streaming, ground search): functions that return true when done

	const reply = (msg) => { try { channel.postMessage(msg); } catch (e) {} };
	const notify = (text) => reply({ notify: text });

	// ---- native calls -----------------------------------------------------------------------------------------------
	// rage::scrThread::Info (64-bit layout): +0 result pointer, +8 parameter count, +16 parameter pointer, +24 buffer count.
	// Every parameter and result slot is 8 bytes; a vector is three float slots.
	// Mailbox (written by the page): +0 sequence number, +4 byte length, +8 last sequence read here, +16 the command as JSON.
	const INFO = 0, RESULT = 64, PARAMS = 128, OUT = 512, STR = 1024, MAILBOX = 4096, MAILBOX_DATA = 16, SCRATCH_SIZE = 8192;
	const F = (v) => ({ f: v });				// float parameter
	const P = (addr) => ({ p: addr });			// pointer parameter (absolute address)
	const S = (text) => ({ s: text });			// string parameter (written to the scratch block)
	let view = null, strOffset = 0;
	const dv = () => (view && view.buffer === wasmMemory.buffer) ? view : (view = new DataView(wasmMemory.buffer));
	const addr = (off) => scratch + off;
	function writeString(text) {
		const bytes = new TextEncoder().encode(text);
		const at = STR + strOffset;
		if (at + bytes.length + 1 > SCRATCH_SIZE) throw new Error('PTC TRAINER: string area full');
		new Uint8Array(wasmMemory.buffer, addr(at), bytes.length + 1).set([...bytes, 0]);
		strOffset += bytes.length + 1;
		return addr(at);
	}
	function native(name, ...args) {
		const fn = wasmExports['N_' + name];
		if (!fn) throw new Error('PTC TRAINER: native ' + name + ' is not exported (is game_ptc.wasm loaded?)');
		const v = dv();
		for (let i = 0; i < 3; i++) v.setBigUint64(addr(RESULT + i * 8), 0n, true);
		args.forEach((a, i) => {
			const at = addr(PARAMS + i * 8);
			v.setBigUint64(at, 0n, true);
			if (typeof a === 'boolean') v.setInt32(at, a ? 1 : 0, true);
			else if (typeof a === 'number') v.setInt32(at, a | 0, true);
			else if ('f' in a) v.setFloat32(at, a.f, true);
			else if ('p' in a) v.setBigUint64(at, BigInt(a.p), true);
			else if ('s' in a) v.setBigUint64(at, BigInt(writeString(a.s)), true);
		});
		v.setBigUint64(addr(INFO), BigInt(addr(RESULT)), true);
		v.setInt32(addr(INFO + 8), args.length, true);
		v.setBigUint64(addr(INFO + 16), BigInt(addr(PARAMS)), true);
		v.setInt32(addr(INFO + 24), 0, true);
		fn(BigInt(addr(INFO)));
		strOffset = 0;
		const r = dv();
		return { int: r.getInt32(addr(RESULT), true), float: r.getFloat32(addr(RESULT), true),
			vec: [r.getFloat32(addr(RESULT), true), r.getFloat32(addr(RESULT + 8), true), r.getFloat32(addr(RESULT + 16), true)] };
	}
	const int = (name, ...a) => native(name, ...a).int;
	const vec = (name, ...a) => native(name, ...a).vec;

	// Jenkins one-at-a-time hash of the lower-case name: the game's model and weapon hashes.
	function joaat(s) {
		let h = 0;
		for (const c of s.toLowerCase()) { h = (h + c.charCodeAt(0)) >>> 0; h = (h + (h << 10)) >>> 0; h = (h ^ (h >>> 6)) >>> 0; }
		h = (h + (h << 3)) >>> 0; h = (h ^ (h >>> 11)) >>> 0; h = (h + (h << 15)) >>> 0;
		return h | 0;
	}

	// ---- actions ------------------------------------------------------------------------------------------------------
	const ped = () => int('PLAYER_PED_ID');
	const player = () => int('GET_PLAYER_INDEX');
	const vehicle = () => int('IS_PED_IN_ANY_VEHICLE', ped(), false) ? int('GET_VEHICLE_PED_IS_IN', ped(), false) : 0;

	const WEAPONS = ['weapon_knife', 'weapon_nightstick', 'weapon_hammer', 'weapon_bat', 'weapon_crowbar', 'weapon_golfclub', 'weapon_pistol',
		'weapon_combatpistol', 'weapon_appistol', 'weapon_pistol50', 'weapon_microsmg', 'weapon_smg', 'weapon_assaultsmg', 'weapon_assaultrifle',
		'weapon_carbinerifle', 'weapon_advancedrifle', 'weapon_mg', 'weapon_combatmg', 'weapon_pumpshotgun', 'weapon_sawnoffshotgun',
		'weapon_assaultshotgun', 'weapon_bullpupshotgun', 'weapon_stungun', 'weapon_sniperrifle', 'weapon_heavysniper', 'weapon_grenadelauncher',
		'weapon_rpg', 'weapon_minigun', 'weapon_grenade', 'weapon_stickybomb', 'weapon_smokegrenade', 'weapon_molotov', 'weapon_fireextinguisher',
		'weapon_petrolcan', 'gadget_parachute'];

	function forward(distance) {
		const p = ped(), [x, y, z] = vec('GET_ENTITY_COORDS', p, true);
		const h = native('GET_ENTITY_HEADING', p).float * Math.PI / 180;
		return [x - Math.sin(h) * distance, y + Math.cos(h) * distance, z, native('GET_ENTITY_HEADING', p).float];
	}

	function spawnVehicle(model) {
		const hash = joaat(model);
		if (!int('IS_MODEL_IN_CDIMAGE', hash) || !int('IS_MODEL_A_VEHICLE', hash)) { notify('Vehicle not found in this build: ' + model); return; }
		int('REQUEST_MODEL', hash);
		let frames = 0;
		jobs.push(() => {
			if (!int('HAS_MODEL_LOADED', hash)) {
				if (++frames > 600) { notify('Timed out loading ' + model); return true; }
				int('REQUEST_MODEL', hash);
				return false;
			}
			const old = vehicle();
			const [x, y, z, heading] = forward(old ? 0 : 3);
			if (old) { int('SET_ENTITY_AS_MISSION_ENTITY', old, true, true); dv().setInt32(addr(OUT), old, true); int('DELETE_VEHICLE', P(addr(OUT))); }
			const veh = int('CREATE_VEHICLE', hash, F(x), F(y), F(z), F(heading), false, false, false);
			if (!veh) { notify('Could not create ' + model); return true; }
			int('SET_VEHICLE_ON_GROUND_PROPERLY', veh, F(5));
			int('SET_PED_INTO_VEHICLE', ped(), veh, -1);
			int('SET_VEHICLE_ENGINE_ON', veh, true, true, false);
			int('SET_MODEL_AS_NO_LONGER_NEEDED', hash);
			dv().setInt32(addr(OUT), veh, true);
			int('SET_ENTITY_AS_NO_LONGER_NEEDED', P(addr(OUT)));		// ambient: the script that ran the menu does not own it
			notify('Spawned ' + model);
			return true;
		});
	}

	function teleport(x, y, z) {
		const e = vehicle() || ped();
		if (z !== undefined) { int('SET_ENTITY_COORDS', e, F(x), F(y), F(z), false, false, false, true); notify('Teleported'); return; }
		// No height (waypoint): load the collision around the spot and look for the ground from high to low, over a few frames.
		let frames = 0;
		jobs.push(() => {
			int('REQUEST_COLLISION_AT_COORD', F(x), F(y), F(800));
			int('SET_ENTITY_COORDS', e, F(x), F(y), F(800), false, false, false, true);
			for (let h = 800; h >= -50; h -= 50) {
				dv().setFloat32(addr(OUT), 0, true);
				if (int('GET_GROUND_Z_FOR_3D_COORD', F(x), F(y), F(h), P(addr(OUT)), false, false)) {
					int('SET_ENTITY_COORDS', e, F(x), F(y), F(dv().getFloat32(addr(OUT), true) + 1), false, false, false, true);
					notify('Teleported to the waypoint');
					return true;
				}
			}
			if (++frames > 120) { notify('Could not find the ground at the waypoint'); return true; }
			return false;
		});
	}

	const actions = {
		heal() { const p = ped(); int('SET_ENTITY_HEALTH', p, int('GET_ENTITY_MAX_HEALTH', p), 0); int('SET_PED_ARMOUR', p, 100); notify('Health and armour filled'); },
		clearWanted() { int('CLEAR_PLAYER_WANTED_LEVEL', player()); notify('Wanted level cleared'); },
		wanted(level) { int('SET_PLAYER_WANTED_LEVEL', player(), level, false); int('SET_PLAYER_WANTED_LEVEL_NOW', player(), false); },
		allWeapons() { const p = ped(); for (const w of WEAPONS) int('GIVE_WEAPON_TO_PED', p, joaat(w), 9999, false, false); notify('All weapons given'); },
		removeWeapons() { int('REMOVE_ALL_PED_WEAPONS', ped(), true); notify('Weapons removed'); },
		vehicle(model) { spawnVehicle(model); },
		repair() { const v = vehicle(); if (!v) return notify('You are not in a vehicle'); int('SET_VEHICLE_FIXED', v); int('SET_VEHICLE_DIRT_LEVEL', v, F(0)); notify('Vehicle repaired'); },
		boost() { const v = vehicle(); if (v) int('SET_VEHICLE_FORWARD_SPEED', v, F(70)); },
		flip() { const v = vehicle(); if (v) int('SET_VEHICLE_ON_GROUND_PROPERLY', v, F(5)); },
		deleteVehicle() { const v = vehicle(); if (!v) return; int('SET_ENTITY_AS_MISSION_ENTITY', v, true, true); dv().setInt32(addr(OUT), v, true); int('DELETE_VEHICLE', P(addr(OUT))); notify('Vehicle deleted'); },
		teleport(c) { teleport(c[0], c[1], c[2]); },
		waypoint() {
			const blip = int('GET_FIRST_BLIP_INFO_ID', 8);
			if (!blip || !int('DOES_BLIP_EXIST', blip)) return notify('Set a waypoint on the map first');
			const [x, y] = vec('GET_BLIP_INFO_ID_COORD', blip);
			teleport(x, y);
		},
		time(hour) { int('SET_CLOCK_TIME', hour, 0, 0); notify('Time set to ' + hour + ':00'); },
		weather(type) { int('SET_WEATHER_TYPE_NOW_PERSIST', S(type)); notify('Weather: ' + type); },
		toggle(name) { toggles[name] = !toggles[name]; applyToggleOnce(name); notify(name + ': ' + (toggles[name] ? 'on' : 'off')); reply({ toggles }); },
		state() { reply({ toggles }); },
	};

	// Toggles with a lasting native state are set when they change; the others are refreshed every frame in perFrame().
	function applyToggleOnce(name) {
		const p = ped(), on = toggles[name];
		if (name === 'god') int('SET_PLAYER_INVINCIBLE', player(), on);
		if (name === 'invisible') int('SET_ENTITY_VISIBLE', p, !on, false);
		if (name === 'noRagdoll') int('SET_PED_CAN_RAGDOLL', p, !on);
		if (name === 'infAmmo') int('SET_PED_INFINITE_AMMO_CLIP', p, on);
		if (name === 'fastRun') { int('SET_RUN_SPRINT_MULTIPLIER_FOR_PLAYER', player(), F(on ? 1.49 : 1)); int('SET_SWIM_MULTIPLIER_FOR_PLAYER', player(), F(on ? 1.49 : 1)); }
		if (name === 'police') int('SET_POLICE_IGNORE_PLAYER', player(), on);
	}
	function perFrame() {
		const p = ped();
		if (toggles.god) { int('SET_PLAYER_INVINCIBLE', player(), true); }
		if (toggles.neverWanted) int('CLEAR_PLAYER_WANTED_LEVEL', player());
		if (toggles.superJump) int('SET_SUPER_JUMP_THIS_FRAME', player());
		if (toggles.infAmmo) int('SET_PED_INFINITE_AMMO_CLIP', p, true);
		if (toggles.vehGod) { const v = vehicle(); if (v) { int('SET_ENTITY_INVINCIBLE', v, true); int('SET_VEHICLE_TYRES_CAN_BURST', v, false); } }
	}

	function readMailbox() {
		const i32 = new Int32Array(wasmMemory.buffer), at = addr(MAILBOX) >> 2;
		const seq = Atomics.load(i32, at);
		if (seq === Atomics.load(i32, at + 2)) return;
		const length = Atomics.load(i32, at + 1);
		const bytes = new Uint8Array(length);
		bytes.set(new Uint8Array(wasmMemory.buffer, addr(MAILBOX + MAILBOX_DATA), length));		// TextDecoder does not take shared memory
		try { queue.push(JSON.parse(new TextDecoder().decode(bytes))); } catch (e) { console.warn('[ptc] bad command: ' + e); }
		Atomics.store(i32, at + 2, seq);
	}

	// ---- tick: called from inside rage::scrThread::Run, once per running script per frame ------------------------------
	self.__ptcTick = (thread) => {
		if (failed || typeof wasmExports === 'undefined' || !wasmExports.N_GET_FRAME_COUNT) return;
		try {
			if (!channel) {
				channel = new BroadcastChannel('ptc-trainer');
				scratch = Number(wasmExports.ptc_alloc(BigInt(SCRATCH_SIZE)));
				new Uint8Array(wasmMemory.buffer, scratch, SCRATCH_SIZE).fill(0);
			}
			const frame = int('GET_FRAME_COUNT');
			if (frame === lastFrame) return;		// the first script of each frame runs the menu
			lastFrame = frame;
			if (frame % 30 === 0) reply({ ready: true, mailbox: addr(MAILBOX), toggles });		// (again and again: the page may load after the engine)
			readMailbox();
			while (queue.length) {
				const { action, arg } = queue.shift();
				if (actions[action]) actions[action](arg);
			}
			for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i]()) jobs.splice(i, 1);
			perFrame();
		} catch (e) {
			failed = true;
			console.error('[ptc] stopped: ' + (e && e.stack || e));
			reply({ notify: 'PTC TRAINER error: ' + (e && e.message || e) + ' (menu disabled until reload)' });
		}
	};
})();

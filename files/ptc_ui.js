// PTC TRAINER, page side: the overlay and its keyboard navigation. F8 opens/closes; arrows move, Enter/Right select, Backspace/Left go back.
// While the menu is open those keys are kept from the game. The engine worker is blocked in the game loop and never gets message events,
// so actions go into a mailbox in the shared wasm memory that ptc_engine.js reads every frame (its address comes with the 'ready' message
// on the 'ptc-trainer' BroadcastChannel; index.html keeps the memory in window.__ptcMemory). One command at a time: the next is written once
// the engine has read the previous one.
(() => {
	'use strict';
	const channel = new BroadcastChannel('ptc-trainer');
	const outbox = [];
	let toggles = {}, ready = false, mailbox = 0;
	function pump() {
		const memory = window.__ptcMemory;
		if (!memory || !mailbox || !outbox.length) return;
		const i32 = new Int32Array(memory.buffer), at = mailbox >> 2;
		const seq = Atomics.load(i32, at);
		if (seq !== Atomics.load(i32, at + 2)) return;		// the engine has not read the previous command yet
		const bytes = new TextEncoder().encode(JSON.stringify(outbox.shift()));
		new Uint8Array(memory.buffer, mailbox + 16, bytes.length).set(bytes);
		Atomics.store(i32, at + 1, bytes.length);
		Atomics.store(i32, at, (seq + 1) | 0);
	}
	setInterval(pump, 30);
	const send = (action, arg) => { if (outbox.length < 32) outbox.push({ action, arg }); pump(); };

	const T = (label, name) => ({ label, toggle: name });
	const A = (label, action, arg) => ({ label, action, arg });
	const M = (label, items) => ({ label, items });
	const cars = (list) => list.map(([label, model]) => A(label, 'vehicle', model));

	const root = M('Main menu', [
		M('Player', [
			T('God mode', 'god'), T('Never wanted', 'neverWanted'), T('Super jump', 'superJump'), T('Fast run and swim', 'fastRun'),
			T('Invisible', 'invisible'), T('No ragdoll', 'noRagdoll'), T('Police ignore you', 'police'),
			A('Fill health and armour', 'heal'), A('Clear wanted level', 'clearWanted'), A('Wanted level: 5 stars', 'wanted', 5),
		]),
		M('Weapons', [A('Give all weapons', 'allWeapons'), T('Infinite ammo', 'infAmmo'), A('Remove all weapons', 'removeWeapons')]),
		M('Vehicles', [
			M('Spawn vehicle', [
				M('Super', cars([['Adder', 'adder'], ['Zentorno', 'zentorno'], ['Entity XF', 'entityxf'], ['T20', 't20'], ['Infernus', 'infernus'], ['Vacca', 'vacca'], ['Bullet', 'bullet'], ['Cheetah', 'cheetah'], ['Turismo R', 'turismor']])),
				M('Sports', cars([['Carbonizzare', 'carbonizzare'], ['Comet', 'comet2'], ['Elegy', 'elegy2'], ['Feltzer', 'feltzer2'], ['Banshee', 'banshee'], ['Sultan', 'sultan'], ['Kuruma', 'kuruma'], ['Kuruma (armoured)', 'kuruma2']])),
				M('Muscle', cars([['Dominator', 'dominator'], ['Gauntlet', 'gauntlet'], ['Phoenix', 'phoenix'], ['Vigero', 'vigero'], ['Sabre GT', 'sabregt']])),
				M('Off-road', cars([['Bifta', 'bifta'], ['Blazer', 'blazer'], ['Sandking', 'sandking'], ['Mesa (merryweather)', 'mesa3'], ['Dune', 'dune']])),
				M('Motorcycles', cars([['Bati 801', 'bati'], ['Akuma', 'akuma'], ['Sanchez', 'sanchez'], ['Double-T', 'double'], ['Hakuchou', 'hakuchou'], ['BMX', 'bmx']])),
				M('Military', cars([['Rhino tank', 'rhino'], ['Barracks', 'barracks'], ['Crusader', 'crusader'], ['Insurgent', 'insurgent']])),
				M('Helicopters', cars([['Buzzard', 'buzzard'], ['Frogger', 'frogger'], ['Maverick', 'maverick'], ['Annihilator', 'annihilator'], ['Cargobob', 'cargobob']])),
				M('Planes', cars([['Lazer', 'lazer'], ['Hydra', 'hydra'], ['Besra', 'besra'], ['Luxor', 'luxor'], ['Mammatus', 'mammatus'], ['Duster', 'duster'], ['Titan', 'titan']])),
				M('Boats', cars([['Jetmax', 'jetmax'], ['Speeder', 'speeder'], ['Dinghy', 'dinghy'], ['Seashark', 'seashark'], ['Submersible', 'submersible']])),
			]),
			A('Repair vehicle', 'repair'), A('Speed boost', 'boost'), A('Flip upright', 'flip'), T('Vehicle god mode', 'vehGod'), A('Delete current vehicle', 'deleteVehicle'),
		]),
		M('Teleport', [
			A('To waypoint', 'waypoint'),
			A("Michael's house", 'teleport', [-852.4, 160.0, 65.6]), A("Franklin's house", 'teleport', [7.9, 548.1, 175.5]),
			A("Trevor's trailer", 'teleport', [1985.7, 3812.2, 32.2]), A('Los Santos airport', 'teleport', [-1336.0, -3044.0, 13.9]),
			A('Mount Chiliad', 'teleport', [501.8, 5604.8, 797.9]), A('Maze Bank tower (roof)', 'teleport', [-75.0, -818.0, 326.2]),
			A('Fort Zancudo', 'teleport', [-2047.4, 3132.1, 32.8]), A('Vinewood sign', 'teleport', [711.4, 1198.1, 348.5]),
			A('Paleto Bay', 'teleport', [-276.0, 6226.0, 31.5]), A('Sandy Shores airfield', 'teleport', [1747.0, 3273.7, 41.1]),
			A('Del Perro pier', 'teleport', [-1850.1, -1231.7, 13.0]), A('Los Santos Customs', 'teleport', [-365.4, -131.8, 37.9]),
		]),
		M('World', [
			M('Time', [0, 6, 9, 12, 15, 18, 21].map((h) => A(String(h).padStart(2, '0') + ':00', 'time', h))),
			M('Weather', [['Extra sunny', 'EXTRASUNNY'], ['Clear', 'CLEAR'], ['Clouds', 'CLOUDS'], ['Smog', 'SMOG'], ['Foggy', 'FOGGY'], ['Overcast', 'OVERCAST'],
				['Rain', 'RAIN'], ['Thunder', 'THUNDER'], ['Clearing', 'CLEARING'], ['Snow', 'SNOW'], ['Blizzard', 'BLIZZARD'], ['Christmas', 'XMAS']].map(([l, w]) => A(l, 'weather', w))),
		]),
	]);

	// ---- overlay ----
	const style = document.createElement('style');
	style.textContent = `
		#ptc { position: fixed; left: 32px; top: 32px; width: 320px; font: 15px/1 'Segoe UI', Arial, sans-serif; color: #fff; z-index: 20; display: none; user-select: none; pointer-events: none; }
		#ptc .head { background: #2b6cb0; padding: 16px 16px 10px; font: 700 26px/1 'Segoe UI', Arial, sans-serif; text-align: center; letter-spacing: .5px; }
		#ptc .head small { display: block; margin-top: 6px; font: 600 11px/1 'Segoe UI', Arial, sans-serif; letter-spacing: 1px; color: #dbeafe; }
		#ptc .sub { background: #000; padding: 8px 12px; font-size: 13px; color: #9cf; text-transform: uppercase; display: flex; justify-content: space-between; }
		#ptc .item { background: rgba(0,0,0,.72); padding: 10px 12px; display: flex; justify-content: space-between; }
		#ptc .item.sel { background: #eee; color: #000; }
		#ptc .on { color: #4ade80; } #ptc .sel .on { color: #15803d; } #ptc .off { color: #f87171; } #ptc .sel .off { color: #b91c1c; }
		#ptc .foot { background: #000; padding: 7px 12px; font-size: 12px; color: #aaa; }
		#ptc-toast { position: fixed; right: 24px; top: 24px; z-index: 21; display: flex; flex-direction: column; gap: 6px; pointer-events: none; }
		#ptc-toast div { background: rgba(0,0,0,.8); color: #fff; border-left: 4px solid #2b6cb0; padding: 8px 12px; font: 14px 'Segoe UI', Arial, sans-serif; }`;
	document.head.appendChild(style);
	const box = document.createElement('div'); box.id = 'ptc'; document.body.appendChild(box);
	const toasts = document.createElement('div'); toasts.id = 'ptc-toast'; document.body.appendChild(toasts);

	const toast = (text) => {
		const el = document.createElement('div'); el.textContent = text; toasts.appendChild(el);
		setTimeout(() => el.remove(), 3000);
	};
	channel.onmessage = (ev) => {
		const m = ev.data || {};
		if (m.toggles) toggles = m.toggles;
		if (m.mailbox) mailbox = m.mailbox;
		if (m.ready && !ready) { ready = true; toast('PTC TRAINER ready: press F8 · Made by @ppittocco'); }
		if (m.notify) toast(m.notify);
		if (open) render();
	};

	let open = false;
	const stack = [{ menu: root, index: 0 }];
	const top = () => stack[stack.length - 1];
	const VISIBLE = 12;
	function render() {
		const { menu, index } = top();
		const first = Math.max(0, Math.min(index - VISIBLE + 1, menu.items.length - VISIBLE));
		const rows = menu.items.slice(first, first + VISIBLE).map((it, k) => {
			const i = first + k;
			const right = it.items ? '&#9656;' : it.toggle ? (toggles[it.toggle] ? '<span class="on">ON</span>' : '<span class="off">OFF</span>') : '';
			return `<div class="item${i === index ? ' sel' : ''}"><span>${it.label}</span><span>${right}</span></div>`;
		}).join('');
		box.innerHTML = `<div class="head">PTC TRAINER<small>Made by @ppittocco</small></div><div class="sub"><span>${menu.label}</span><span>${index + 1} / ${menu.items.length}</span></div>${rows}`
			+ `<div class="foot">${ready ? 'Arrows: move · Enter: select · Backspace: back · F8: close' : 'Waiting for the game to start…'}</div>`;
	}
	function setOpen(v) { open = v; box.style.display = v ? 'block' : 'none'; if (v) { send('state'); render(); } }
	function select() {
		const it = top().menu.items[top().index];
		if (it.items) stack.push({ menu: it, index: 0 });
		else if (it.toggle) send('toggle', it.toggle);
		else send(it.action, it.arg);
		render();
	}

	const MENU_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'NumpadEnter', 'Backspace']);
	addEventListener('keydown', (e) => {
		if (e.code === 'F8') { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) setOpen(!open); return; }
		if (!open || !MENU_KEYS.has(e.code)) return;
		e.preventDefault(); e.stopImmediatePropagation();		// keep the menu keys from the game while it is open
		const t = top(), n = t.menu.items.length;
		if (e.code === 'ArrowUp') t.index = (t.index + n - 1) % n;
		else if (e.code === 'ArrowDown') t.index = (t.index + 1) % n;
		else if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'ArrowRight') { if (!e.repeat) select(); }
		else if (stack.length > 1) stack.pop();
		else setOpen(false);
		render();
	}, true);
	addEventListener('keyup', (e) => { if (e.code === 'F8' || (open && MENU_KEYS.has(e.code))) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
})();

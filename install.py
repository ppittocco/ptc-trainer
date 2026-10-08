"""Installs (or removes) PTC TRAINER in a clean copy of the game.

usage: python install.py [--uninstall] [game folder]
The game folder is the one with serve_local.py and mirror/ (default: the parent of this PTC TRAINER folder).

Install:
  - builds game_ptc.wasm next to game.wasm (patch_wasm.py; game.wasm itself is not changed)
  - copies files/ptc_engine.js and files/ptc_ui.js into the build folder
  - patches game.js, loader.js and index.html (each one saved first as <name>.orig)
  - makes serve_local.py tell the browser to revalidate the page and the build, so changed files are picked up
Uninstall puts the .orig files back and deletes what the install added.
"""
import shutil, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import patch_wasm  # noqa: E402

PTC_MAGIC = 1347699540  # patch_wasm.PTC_MAGIC


def patches(build_url):
    """(file, [(old, new), ...]) per file, relative to the site folder. `old` must occur exactly once."""
    return [
        ('b/{build}/game.js', [
            ('function wasm_module_int_js(name,defaultValue){',
             'function wasm_module_int_js(name,defaultValue){if(defaultValue===%d){if(self.__ptcTick)self.__ptcTick(name);return 0}' % PTC_MAGIC),
        ], 'try{importScripts(new URL("ptc_engine.js",self.location.href).href)}catch(e){try{importScripts("%s/ptc_engine.js")}catch(e2){console.warn("[ptc] ptc_engine.js not loaded: "+e2)}}\n' % build_url),
        ('b/{build}/loader.js', [
            ("res = await fetch(B + '/game.wasm');", "res = await fetch(B + '/game_ptc.wasm');"),
            ("throw new Error('HTTP ' + res.status + ' for game.wasm')", "throw new Error('HTTP ' + res.status + ' for game_ptc.wasm')"),
        ], None),
        ('index.html', [
            ('if (ev.data.input) installInput(ev.data.input.memory, ev.data.input.block);',
             'if (ev.data.input) { window.__ptcMemory = ev.data.input.memory; installInput(ev.data.input.memory, ev.data.input.block); }\t\t// __ptcMemory: PTC TRAINER\'s mailbox (ptc_ui.js)'),
            ('</body>', '<script src="%s/ptc_ui.js"></script>\n</body>' % build_url),
        ], None),
    ]


SERVER_OLD = "        self.send_header('Accept-Ranges', 'bytes')\n        super().end_headers()"
SERVER_NEW = ("        self.send_header('Accept-Ranges', 'bytes')\n"
              "        if not self.path.startswith('/data/'):\n"
              "            self.send_header('Cache-Control', 'no-cache')\t\t# revalidate the page and the build (304 when unchanged): edited files are picked up at once\n"
              "        super().end_headers()")


def read(p):
    return p.read_bytes().decode('utf-8')


def write(p, text):
    p.write_bytes(text.encode('utf-8'))		# bytes: keeps the line endings as they are


def locate(game):
    site = game / 'mirror' / 'playgta5.com'
    if not (site / 'index.html').is_file():
        raise SystemExit('Not a game folder (no mirror/playgta5.com/index.html): %s' % game)
    builds = [p.parent for p in (site / 'b').glob('*/game.wasm')]
    if len(builds) != 1:
        raise SystemExit('Expected one build folder with game.wasm under %s, found %d' % (site / 'b', len(builds)))
    return site, builds[0]


def install(game):
    site, build = locate(game)
    build_url = '/b/' + build.name
    if (build / 'ptc_engine.js').exists() or (build / 'game.js.orig').exists():
        raise SystemExit('PTC TRAINER is already installed (run Uninstall-PTCTrainer.cmd first to reinstall).')

    # Check every patch point before changing anything: a game that is not the expected version is left untouched.
    plan = []
    for rel, edits, append in patches(build_url):
        path = site / rel.format(build=build.name)
        text = read(path)
        for old, _ in edits:
            if text.count(old) != 1:
                raise SystemExit('%s: patch point found %d times (different game version?): %s' % (path.name, text.count(old), old[:60]))
        plan.append((path, text, edits, append))

    print('Building game_ptc.wasm (about a minute)...')
    natives = patch_wasm.build(build)
    print('  %d script natives exported' % natives)

    for path, text, edits, append in plan:
        shutil.copy2(path, path.with_name(path.name + '.orig'))
        for old, new in edits:
            text = text.replace(old, new)
        if append:
            text += ('' if text.endswith('\n') else '\n') + append
        write(path, text)
        print('  patched ' + path.name)
    for f in ('ptc_engine.js', 'ptc_ui.js'):
        shutil.copy2(HERE / 'files' / f, build / f)
        print('  copied ' + f)

    server = game / 'serve_local.py'
    if server.is_file():
        text = read(server).replace('\r\n', '\n')
        if 'no-cache' not in text and text.count(SERVER_OLD) == 1:
            shutil.copy2(server, server.with_name(server.name + '.orig'))
            crlf = b'\r\n' in server.read_bytes()
            text = text.replace(SERVER_OLD, SERVER_NEW)
            write(server, text.replace('\n', '\r\n') if crlf else text)
            print('  patched serve_local.py (no stale files from the browser cache)')
    print('\nPTC TRAINER installed. Start the game (restart the server if it is running) and press F8.')


def uninstall(game):
    site, build = locate(game)
    restored = 0
    for path in [build / 'game.js', build / 'loader.js', site / 'index.html', game / 'serve_local.py']:
        orig = path.with_name(path.name + '.orig')
        if orig.exists():
            shutil.move(str(orig), str(path)); restored += 1
            print('  restored ' + path.name)
    for f in ('game_ptc.wasm', 'ptc_engine.js', 'ptc_ui.js'):
        if (build / f).exists():
            (build / f).unlink(); print('  removed ' + f)
    print('\nPTC TRAINER removed.' if restored else '\nPTC TRAINER was not installed.')


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    game = Path(args[0]).resolve() if args else HERE.parent
    (uninstall if '--uninstall' in sys.argv else install)(game)

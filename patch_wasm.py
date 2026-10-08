"""Builds game_ptc.wasm from game.wasm for PTC TRAINER (files/ptc_engine.js). Used by install.py.

- Exports every script native wrapper (scrWrapped_<NAME>::Call(rage::scrThread::Info&)) as "N_<NAME>",
  and operator new(unsigned long) as "ptc_alloc".
- Inserts `wasm_module_int_js(thread, PTC_MAGIC)` into rage::scrThread::Run right after the thread is made
  the active one, so the menu runs its natives inside a real script thread, once per running script per frame.

The function indices do not change (nothing is imported or added), so the name section stays valid.
usage: python patch_wasm.py <build folder>   (reads game.wasm, writes game_ptc.wasm next to it)
"""
import re, sys
from pathlib import Path

PTC_MAGIC = 0x50544354  # 'PTCT': the default value argument that marks a menu tick


def leb_u(n):
    out = bytearray()
    while True:
        b = n & 0x7f; n >>= 7
        if n: out.append(b | 0x80)
        else: out.append(b); return bytes(out)


def leb_s(n):
    out = bytearray()
    while True:
        b = n & 0x7f; n >>= 7
        if (n == 0 and not b & 0x40) or (n == -1 and b & 0x40): out.append(b); return bytes(out)
        out.append(b | 0x80)


def read_leb(d, p):
    r = s = 0
    while True:
        b = d[p]; p += 1; r |= (b & 0x7f) << s; s += 7
        if b < 0x80: return r, p


def sections(d):
    out, p = [], 8
    while p < len(d):
        sid = d[p]; p += 1; size, p = read_leb(d, p)
        out.append([sid, d[p:p + size]]); p += size
    return out


def function_names(secs):
    for sid, body in secs:
        if sid != 0: continue
        nl, q = read_leb(body, 0)
        if body[q:q + nl] != b'name': continue
        q += nl; names = {}
        while q < len(body):
            sub = body[q]; q += 1; size, q = read_leb(body, q); end = q + size
            if sub == 1:
                n, q = read_leb(body, q)
                for _ in range(n):
                    idx, q = read_leb(body, q); l, q = read_leb(body, q)
                    names[idx] = body[q:q + l].decode('utf-8', 'replace'); q += l
            q = end
        return names
    raise SystemExit('game.wasm has no name section')


def import_count(secs):
    for sid, body in secs:
        if sid != 2: continue
        n, q = read_leb(body, 0); funcs = 0
        for _ in range(n):
            l, q = read_leb(body, q); q += l; l, q = read_leb(body, q); q += l; k = body[q]; q += 1
            if k == 0: _, q = read_leb(body, q); funcs += 1
            elif k == 1:
                q += 1; f, q = read_leb(body, q); q = read_leb(body, q)[1]
                if f & 1: q = read_leb(body, q)[1]
            elif k == 2:
                f, q = read_leb(body, q); q = read_leb(body, q)[1]
                if f & 1: q = read_leb(body, q)[1]
            elif k == 3: q += 2
        return funcs
    return 0


def import_index(secs, field):
    for sid, body in secs:
        if sid != 2: continue
        n, q = read_leb(body, 0); fi = 0
        for _ in range(n):
            l, q = read_leb(body, q); q += l; l, q = read_leb(body, q); name = body[q:q + l].decode(); q += l; k = body[q]; q += 1
            if k == 0:
                _, q = read_leb(body, q)
                if name == field: return fi
                fi += 1
            elif k == 1:
                q += 1; f, q = read_leb(body, q); q = read_leb(body, q)[1]
                if f & 1: q = read_leb(body, q)[1]
            elif k == 2:
                f, q = read_leb(body, q); q = read_leb(body, q)[1]
                if f & 1: q = read_leb(body, q)[1]
            elif k == 3: q += 2
    raise SystemExit('import not found: ' + field)


def build(folder):
    folder = Path(folder)
    d = (folder / 'game.wasm').read_bytes()
    secs = sections(d)
    names = function_names(secs)
    nimp = import_count(secs)
    by_name = {v: k for k, v in names.items()}

    run = by_name['rage::scrThread::Run(int)']
    alloc = by_name['operator new(unsigned long)']
    hook_import = import_index(secs, 'wasm_module_int_js')

    natives = {}
    pat = re.compile(r'::scrWrapped_([A-Z0-9_]+)::Call\(rage::scrThread::Info&\)$')
    for idx, n in names.items():
        m = pat.search(n)
        if m and m.group(1) not in natives: natives[m.group(1)] = idx

    # ---- code: hook in scrThread::Run --------------------------------------------------------------
    for s in secs:
        if s[0] != 10: continue
        body = s[1]; n, q = read_leb(body, 0); funcs = []
        for _ in range(n):
            size, q2 = read_leb(body, q); funcs.append(body[q2:q2 + size]); q = q2 + size
        f = funcs[run - nimp]
        # local.get 24; local.get 0; i64.store align=3 offset=0   (activeThread = this)
        anchor = bytes([0x20, 24, 0x20, 0, 0x37, 3, 0])
        if f.count(anchor) != 1: raise SystemExit('scrThread::Run: anchor found %d times' % f.count(anchor))
        at = f.index(anchor) + len(anchor)
        hook = bytes([0x20, 0]) + bytes([0x41]) + leb_s(PTC_MAGIC) + bytes([0x10]) + leb_u(hook_import) + bytes([0x1a])
        funcs[run - nimp] = f[:at] + hook + f[at:]
        s[1] = leb_u(len(funcs)) + b''.join(leb_u(len(x)) + x for x in funcs)

    # ---- exports -------------------------------------------------------------------------------------
    for s in secs:
        if s[0] != 7: continue
        body = s[1]; n, q = read_leb(body, 0)
        extra = [('ptc_alloc', alloc)] + [('N_' + k, v) for k, v in sorted(natives.items())]
        add = b''.join(leb_u(len(k)) + k.encode() + b'\0' + leb_u(v) for k, v in extra)
        s[1] = leb_u(n + len(extra)) + body[q:] + add

    out = bytearray(d[:8])
    for sid, body in secs:
        out.append(sid); out += leb_u(len(body)); out += body
    (folder / 'game_ptc.wasm').write_bytes(out)
    return len(natives)


if __name__ == '__main__':
    print('game_ptc.wasm: %d natives exported' % build(sys.argv[1] if len(sys.argv) > 1 else '.'))

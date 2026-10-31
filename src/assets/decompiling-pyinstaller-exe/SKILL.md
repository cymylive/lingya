---
name: decompiling-pyinstaller-exe
description: Use when asked to recover readable source from a PyInstaller-packaged .exe, or when a .pyc decompile returns "Stack history is not empty", "Decompyle incomplete", "Unexpected end of stream", or produces self replaced by None
---

# Decompiling PyInstaller EXE

## Overview

Recovering source from a PyInstaller .exe is **not** "run a decompiler and read the output."
On Python 3.9+ decompilers fail partially, and **fail silently with wrong logic** where they do
produce output. The only reliable deliverable is: decompile what works, hand-rebuild what doesn't
from bytecode, then verify by execution.

**Core principle:** a decompiler's output is a draft, not an answer. Bytecode is the ground truth.

## When to Use

- Given a .exe and asked "what does it do" / "recover the source" / "modify it"
- A .pyc decompile emits `Stack history is not empty`, `Decompyle incomplete`,
  `Unexpected end of stream`, or `pass # WARNING` stubs
- Decompiled output contains `None.something(...)` where `self` belongs
- Decompiled code is syntactically valid but behaves wrong

**Not for:** Nuitka / py2exe / cx_Freeze (different structure, untested — investigate first),
or .pyc for Python ≤ 3.8 (use decompyle3/uncompyle6, they actually work there).

## Phase 1 — Unpack

```
pyinstxtractor.py target.exe        → target.exe_extracted/
```

The main script's .pyc sits at the top level, usually named after the entry point.
Sibling `pyimod*.pyc` / `pyi_rth_*.pyc` are PyInstaller's own bootstrap — ignore them.

**Verify the .pyc before decompiling anything:**

```python
import marshal, dis
data = open(pyc, 'rb').read()
print('magic', data[:4].hex(), 'flags', data[4:8].hex(), 'size', len(data))
co = marshal.loads(data[16:])
print('top-level code objects:', sum(1 for c in co.co_consts if hasattr(c, 'co_code')))
```

If `marshal.loads` throws, the extraction is broken — re-extract, don't decompile garbage.

## Phase 2 — Pick the Decompiler

| Python | Use | Notes |
|---|---|---|
| ≤ 3.8 | decompyle3 / uncompyle6 | Reliable. Skip the rest of this skill. |
| 3.9 – 3.11 | **pycdc** (build from source) | Must be a recent build. Old binaries lack 3.11 exception tables. |
| 3.12+ | none reliable | Expect to hand-rebuild most of it. |

Build pycdc from source (`zrax/pycdc`, MinGW on Windows). Prebuilt binaries are stale and
their absence of 3.11 support looks identical to "the tool is broken."

> **Windows DLL trap:** a self-built pycdc.exe needs `libstdc++-6.dll`,
> `libgcc_s_seh-1.dll`, `libwinpthread-1.dll` next to it. Missing them surfaces as
> exit code `3221225781` (0xC0000135) **with no error message**.
> Pull them from the MSYS2 `gcc-libs` and `libwinpthread` ucrt64 packages.
> Also invoke pycdc via `subprocess` from Python, not through `cmd /c` — an AutoRun
> or PATH quirk in the shell layer can produce the same silent exit code.

## Phase 3 — Decompile Per Code Object, Not Per File

Whole-file decompilation fails as a unit and tells you nothing about *where*.
Split it:

```python
import marshal, os, subprocess
co = marshal.loads(open(pyc,'rb').read()[16:])
magic = open(pyc,'rb').read()[:4]

def dump(c, name):
    p = f'{name}.pyc'
    open(p,'wb').write(magic + b'\x00'*12 + marshal.dumps(c))
    r = subprocess.run([PYCDC, p], capture_output=True)
    ok = r.returncode == 0 and b'Unexpected end' not in r.stderr
    print(('OK  ' if ok else 'FAIL'), name)
    for sub in c.co_consts:
        if hasattr(sub, 'co_code'):
            dump(sub, name + '.' + sub.co_name)

dump(co, 'module')
```

This gives you a **precise failure list**. In practice on 3.11: ~55/59 objects succeed,
and failures cluster (all `async` methods of one class, all `lambda`s in one method).

Also export full disassembly for every object — you will need it in Phase 4:

```python
dis.dis(c, file=f, depth=0)   # per object, with try/except so one failure doesn't stop the run
```

## Phase 4 — Hand-Rebuild What Failed

Read the bytecode file for the failed object and write the Python by hand.
`co_consts` + `co_names` + `co_varnames` headers at the top of each dump give you
every literal, every attribute, every local name — you are not guessing.

**Trust the bytecode over any decompiler output you already have.** Decompilers for 3.9+
produce *silently wrong* code in these specific shapes:

| Decompiler writes | Bytecode actually means |
|---|---|
| `if not (a > b or self.flag):` | `if a > b and not self.flag:` — condition got inverted |
| `cookie_str = None` then `+=` | `cookie_str = ''` |
| `pyperclip.copy(x)` inside a loop | call sits *after* the loop |
| `if not path or os.path.exists(path):` | `if not path or not os.path.exists(path):` |
| `None.tree.selection()` | `self.tree.selection()` |
| `pass  # WARNING` | read the disassembly, method is fully recoverable |
| body indented under `with` / `try` garbage | check the `ExceptionTable` at the end of the dump |

When a method body is scrambled, the exception table tells you which instruction ranges
are protected and what handlers wrap them — reconstruct `try/except` from that, not from
the decompiler's indentation.

## Phase 5 — Verify by Execution

Three gates, in order. Do not skip to the third.

1. `ast.parse(src)` — syntax. Fix the first error, re-run; don't fix by eye.
2. `importlib.util.spec_from_file_location(...).loader.exec_module(mod)` — import-time errors,
   missing globals, bad decorators.
3. **Run it.** For a GUI app: launch as a background task, confirm the window exists and
   `Responding == True`, then screenshot it. Widgets that look right but are `state='disabled'`
   only show up visually.

Then diff the method list against the bytecode's class body:

```python
expected = ['__init__', 'start', 'close']   # from the class dump's co_consts
actual   = [n.name for n in node.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
assert not set(expected) ^ set(actual)
```

**An exact method-name match plus a running window is the definition of done.**

## Common Mistakes

**Adding behavior the original doesn't have.** If the source has a `schedule_expiration_check()`
method, do not wire it into `__main__` because it seems intended. Read the module-level
bytecode: if there is no `CALL` to it, it is dead code, and calling it changes program behavior
(in this project: it triggered a hardcoded expiry date and greyed out every button).
**The entry point is 4–6 instructions — read them literally.**

**Believing `Decompyle incomplete` means unrecoverable.** Almost every `pass # WARNING` body
is a straightforward method. The disassembly has every instruction.

**Leaving the original file open.** When reading decompiler output through a file-reading tool
that wraps content in `<content>` / footer markers, those markers end up inside the source you
write back. Strip them by slicing between markers, never by regex over the whole document.

**Declaring success from `ast.parse` alone.** Syntax-valid, import-clean, and non-functional
is the normal failure mode of a bad reconstruction.

**Not stating which lines are reconstructions.** Keep the original line numbers visible where
possible, and list every deliberate deviation (e.g. holding a `PhotoImage` reference so Tk
doesn't GC it) in your final message. The user is going to diff this against the binary.

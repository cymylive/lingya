# -*- mode: python ; coding: utf-8 -*-
# graphify-mcp 单文件打包 spec
# 只保留 LingYa 实际需要的语言：JS/TS/JSON/Python（其余语言包体积大且用不上）
from PyInstaller.utils.hooks import collect_submodules

LANG_PKGS = [
    'tree_sitter_javascript',
    'tree_sitter_typescript',
    'tree_sitter_json',
    'tree_sitter_python',
]

hiddenimports = [
    'mcp', 'mcp.server', 'mcp.server.stdio', 'mcp_types',
    'networkx', 'jsonschema', 'pydantic', 'starlette', 'uvicorn',
    'sse_starlette', 'anyio', 'httpx2', 'yaml',
] + LANG_PKGS

a = Analysis(
    ['graphify-mcp-entry.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter', 'matplotlib', 'scipy', 'pandas', 'IPython',
        'pytest', 'setuptools', 'pip',
        'tree_sitter_bash', 'tree_sitter_c', 'tree_sitter_cpp',
        'tree_sitter_c_sharp', 'tree_sitter_elixir', 'tree_sitter_fortran',
        'tree_sitter_go', 'tree_sitter_groovy', 'tree_sitter_java',
        'tree_sitter_julia', 'tree_sitter_kotlin', 'tree_sitter_lua',
        'tree_sitter_objc', 'tree_sitter_php', 'tree_sitter_powershell',
        'tree_sitter_ruby', 'tree_sitter_rust', 'tree_sitter_scala',
        'tree_sitter_swift', 'tree_sitter_verilog', 'tree_sitter_zig',
    ],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='graphify-mcp',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

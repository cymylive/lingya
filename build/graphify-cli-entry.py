import os
import sys

# PyInstaller 冻结环境下，graphify 的 _pin_hash_seed_if_needed 会 re-exec
# [sys.executable, "-m", "graphify", ...]，而 sys.executable 在这里就是本 exe，
# 导致 "-m" 被当成子命令报 "unknown command '-m'"。
# 预先设置 PYTHONHASHSEED 让该函数直接 return（它检查到已存在就不 re-exec）。
os.environ.setdefault("PYTHONHASHSEED", "0")

from graphify.__main__ import main

if __name__ == "__main__":
    main()

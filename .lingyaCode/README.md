# LingYa Downloader — 清单驱动的下载安装器

一个通用 GUI 工具：读 JSON 清单 → 下载 → 校验 → 解压 → 静默安装。

## 快速开始

1. 双击 `启动下载器.bat`
2. 点「加载清单」选 `manifest.example.json`（或自己写一个）
3. 选好下载目录和安装目录
4. 点「开始下载并安装」

## 清单格式

```json
{
  "download_dir": "downloads",
  "install_dir": "installed",
  "items": [
    {
      "name": "显示名称",
      "url": "https://example.com/file.7z",
      "filename": "file.7z",
      "size": 104857600,
      "md5": "可选，小写十六进制",
      "sha256": "可选，小写十六进制",
      "extract": "7z",
      "extract_to": "子目录名",
      "installer": {
        "cmd": "setup.exe",
        "args": ["/S"],
        "workdir": "."
      },
      "note": "备注文字",
      "enabled": true
    }
  ]
}
```

### 字段说明

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 表格里显示的名称 |
| `url` | 是 | 下载地址（http/https） |
| `filename` | 否 | 保存文件名，不填从 URL 推断 |
| `size` | 否 | 预期字节数，仅用于显示 |
| `md5` / `sha256` | 否 | 下载后校验，不匹配则报错 |
| `extract` | 否 | `7z` / `zip` / `rar` / `auto`，null 表示不解压 |
| `extract_to` | 否 | 解压到 `install_dir` 下的子目录名 |
| `installer` | 否 | 解压后执行的安装器 |
| `enabled` | 否 | 默认 true，false 则该行不加载 |

### 静默安装参数速查

| 安装器 | 参数 |
|---|---|
| Inno Setup | `/SILENT /SUPPRESSMSGBOXES /NORESTART` |
| NSIS | `/S` |
| InstallShield | `/s /v"/qn"` |
| MSI | 用 `msiexec /i xxx.msi /qn` 作为 cmd |

## 功能

- **多线程分片下载**：默认 8 线程，按 Range 分片，小文件自动退化为单线程
- **断点续传**：分片进度存在 `.part.json`，中断后重新打开自动续
- **完整性校验**：MD5 / SHA256，不匹配直接报错不继续
- **解压**：7z / zip / rar（7z 自动查找常见安装位置）
- **静默安装**：任意可执行安装器 + 自定义参数
- **实时进度**：每行显示百分比和速度，日志区有完整过程

## 文件说明

| 文件 | 作用 |
|---|---|
| `downloader.py` | 主程序（GUI + 下载引擎） |
| `启动下载器.bat` | Windows 启动脚本 |
| `manifest.example.json` | 清单示例 |
| `selftest_server.py` | 自测用的本地 HTTP 服务器（支持 Range） |
| `test_downloader.py` | 引擎自测（4 个用例） |

## 自测

```bash
# 终端 1：起本地服务器
python selftest_server.py

# 终端 2：跑测试
python test_downloader.py
```

覆盖：小文件单线程、20MB 分片、断点续传、MD5 校验（正确 + 错误）。

## 依赖

- Python 3.9+（用到了 `pathlib` / `threading` / `tkinter`）
- `requests`（`pip install requests`）
- 7-Zip（解压 7z/rar 时需要，会自动查找 `C:\Program Files\7-Zip\7z.exe` 等位置）

## 注意

- 下载源请使用你有权访问的地址
- `installer` 会真的执行程序，清单来源要可信
- 校验字段建议填，能挡住下载损坏和中间篡改

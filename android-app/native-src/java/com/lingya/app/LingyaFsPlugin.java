package com.lingya.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Environment;
import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/**
 * LingyaFs —— 安卓文件系统插件
 *
 * 能力：
 *   - 通过 SAF（Storage Access Framework）操作用户授权目录下的文件
 *   - 通过 app 私有目录（getExternalFilesDir）免授权读写
 *   - read / write / edit / listDir / delete / stat / glob / grep
 *
 * 安全边界（安卓系统强制）：
 *   - 未授权路径一律不可访问（除 app 私有目录）
 *   - 不提供 shell / 任意二进制执行
 *
 * 路径约定：
 *   - "app://<rel>"    → app 私有外部目录
 *   - "root://<rootId>/<rel>" → 已授权的 SAF root 下的相对路径
 *   - 其它绝对路径 → 尝试当作 SAF tree uri 或直接拒绝
 */
@CapacitorPlugin(name = "LingyaFs")
public class LingyaFsPlugin extends Plugin {

    private static final String PREFS = "lingya_fs_roots";
    private static final int MAX_READ_BYTES = 50 * 1024; // 与桌面 READ_MAX_BYTES 对齐
    private static final int MAX_GREP_MATCHES = 250;

    private final Map<String, Uri> rootCache = new HashMap<>();
    private String pendingPickRootId = null;

    @Override
    public void load() {
        // 恢复已授权的 root
        SharedPreferences sp = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        for (Map.Entry<String, ?> e : sp.getAll().entrySet()) {
            try {
                rootCache.put(e.getKey(), Uri.parse((String) e.getValue()));
            } catch (Exception ignored) { }
        }
    }

    // ==================== SAF 授权目录 ====================

    @PluginMethod
    public void pickDirectory(PluginCall call) {
        pendingPickRootId = "root_" + System.currentTimeMillis();
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "pickDirectoryResult");
    }

    @ActivityCallback
    private void pickDirectoryResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("用户取消了目录选择");
            return;
        }
        Uri treeUri = result.getData().getData();
        if (treeUri == null) {
            call.reject("未获得有效目录 URI");
            return;
        }
        try {
            getContext().getContentResolver().takePersistableUriPermission(
                    treeUri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (SecurityException e) {
            call.reject("无法持久化授权: " + e.getMessage());
            return;
        }
        String rootId = pendingPickRootId != null ? pendingPickRootId : ("root_" + System.currentTimeMillis());
        pendingPickRootId = null;
        rootCache.put(rootId, treeUri);
        getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(rootId, treeUri.toString()).apply();

        DocumentFile df = DocumentFile.fromTreeUri(getContext(), treeUri);
        JSObject res = new JSObject();
        res.put("id", rootId);
        res.put("name", df != null && df.getName() != null ? df.getName() : "selected");
        res.put("uri", treeUri.toString());
        call.resolve(ok(res));
    }

    @PluginMethod
    public void listRoots(PluginCall call) {
        JSArray arr = new JSArray();
        for (Map.Entry<String, Uri> e : rootCache.entrySet()) {
            DocumentFile df = DocumentFile.fromTreeUri(getContext(), e.getValue());
            JSObject o = new JSObject();
            o.put("id", e.getKey());
            o.put("name", df != null && df.getName() != null ? df.getName() : "root");
            o.put("uri", e.getValue().toString());
            arr.put(o);
        }
        JSObject res = new JSObject();
        res.put("roots", arr);
        call.resolve(ok(res));
    }

    @PluginMethod
    public void releaseRoot(PluginCall call) {
        String rootId = call.getString("rootId");
        if (rootId == null) { call.reject("缺少 rootId"); return; }
        rootCache.remove(rootId);
        getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(rootId).apply();
        JSObject res = new JSObject();
        res.put("rootId", rootId);
        call.resolve(ok(res));
    }

    // ==================== 文件操作 ====================

    @PluginMethod
    public void readFile(PluginCall call) {
        try {
            Resolved r = resolve(call.getString("path"), false);
            if (r == null) { call.resolve(err("路径无法解析（未授权或不存在）")); return; }
            String content = readText(r);
            if (content == null) { call.resolve(err("读取失败")); return; }
            JSObject res = new JSObject();
            res.put("path", call.getString("path"));
            res.put("content", content.length() > MAX_READ_BYTES
                    ? content.substring(0, MAX_READ_BYTES) : content);
            res.put("totalLines", content.split("\r?\n", -1).length);
            call.resolve(ok(res));
        } catch (Exception e) {
            call.resolve(err(e.getMessage()));
        }
    }

    @PluginMethod
    public void writeFile(PluginCall call) {
        try {
            String path = call.getString("path");
            String content = call.getString("content", "");
            Resolved r = resolveForWrite(path);
            if (r == null) { call.resolve(err("路径无法写入（需先授权目录）")); return; }
            boolean existed = r.doc != null ? r.doc.exists() : r.file.exists();
            writeText(r, content);
            JSObject res = new JSObject();
            res.put("path", path);
            res.put("operation", existed ? "update" : "create");
            call.resolve(ok(res));
        } catch (Exception e) {
            call.resolve(err(e.getMessage()));
        }
    }

    @PluginMethod
    public void editFile(PluginCall call) {
        try {
            String path = call.getString("path");
            String oldStr = call.getString("oldString");
            String newStr = call.getString("newString", "");
            boolean replaceAll = Boolean.TRUE.equals(call.getBoolean("replaceAll", false));
            Resolved r = resolve(path, false);
            if (r == null) { call.resolve(err("路径无法解析")); return; }
            String content = readText(r);
            if (content == null) { call.resolve(err("读取失败")); return; }
            if (oldStr == null || oldStr.isEmpty()) { call.resolve(err("oldString 不能为空")); return; }
            int count = 0, idx = 0;
            StringBuilder sb = new StringBuilder();
            while (true) {
                int found = content.indexOf(oldStr, idx);
                if (found < 0) { sb.append(content, idx, content.length()); break; }
                sb.append(content, idx, found).append(newStr);
                count++;
                idx = found + oldStr.length();
                if (!replaceAll) { sb.append(content, idx, content.length()); break; }
            }
            if (count == 0) { call.resolve(err("未找到匹配文本")); return; }
            writeText(r, sb.toString());
            JSObject res = new JSObject();
            res.put("path", path);
            res.put("replacements", count);
            call.resolve(ok(res));
        } catch (Exception e) {
            call.resolve(err(e.getMessage()));
        }
    }

    @PluginMethod
    public void listDir(PluginCall call) {
        try {
            Resolved r = resolve(call.getString("path"), false);
            if (r == null) { call.resolve(err("目录无法解析")); return; }
            JSArray arr = new JSArray();
            if (r.doc != null) {
                for (DocumentFile child : r.doc.listFiles()) {
                    JSObject o = new JSObject();
                    o.put("name", child.getName());
                    o.put("isDir", child.isDirectory());
                    o.put("size", child.length());
                    arr.put(o);
                }
            } else {
                File[] children = r.file.listFiles();
                if (children != null) for (File child : children) {
                    JSObject o = new JSObject();
                    o.put("name", child.getName());
                    o.put("isDir", child.isDirectory());
                    o.put("size", child.length());
                    arr.put(o);
                }
            }
            JSObject res = new JSObject();
            res.put("path", call.getString("path"));
            res.put("entries", arr);
            call.resolve(ok(res));
        } catch (Exception e) {
            call.resolve(err(e.getMessage()));
        }
    }

    @PluginMethod
    public void deleteFile(PluginCall call) {
        try {
            Resolved r = resolve(call.getString("path"), false);
            if (r == null) { call.resolve(err("路径无法解析")); return; }
            boolean deleted = r.doc != null ? r.doc.delete() : r.file.delete();
            if (!deleted) { call.resolve(err("删除失败")); return; }
            JSObject res = new JSObject();
            res.put("path", call.getString("path"));
            call.resolve(ok(res));
        } catch (Exception e) {
            call.resolve(err(e.getMessage()));
        }
    }

    @PluginMethod
    public void stat(PluginCall call) {
        try {
            Resolved r = resolve(call.getString("path"), false);
            JSObject res = new JSObject();
            if (r == null) {
                res.put("exists", false);
                call.resolve(ok(res));
                return;
            }
            res.put("path", call.getString("path"));
            res.put("exists", true);
            if (r.doc != null) {
                res.put("isDir", r.doc.isDirectory());
                res.put("size", r.doc.length());
                res.put("lastModified", r.doc.lastModified());
            } else {
                res.put("isDir", r.file.isDirectory());
                res.put("size", r.file.length());
                res.put("lastModified", r.file.lastModified());
            }
            call.resolve(ok(res));
        } catch (Exception e) {
            call.resolve(err(e.getMessage()));
        }
    }

    @PluginMethod
    public void glob(PluginCall call) {
        try {
            String pattern = call.getString("pattern", "*");
            String searchPath = call.getString("searchPath", "app://");
            Resolved r = resolve(searchPath, false);
            if (r == null) { call.resolve(err("搜索目录无法解析")); return; }
            Pattern p = globToRegex(pattern);
            JSArray matches = new JSArray();
            walkAndMatch(r, "", p, matches, 500);
            JSObject res = new JSObject();
            res.put("matches", matches);
            res.put("truncated", matches.length() >= 500);
            call.resolve(ok(res));
        } catch (Exception e) {
            call.resolve(err(e.getMessage()));
        }
    }

    @PluginMethod
    public void grep(PluginCall call) {
        try {
            String pattern = call.getString("pattern");
            String searchPath = call.getString("searchPath", "app://");
            String include = call.getString("include", null);
            if (pattern == null) { call.resolve(err("缺少 pattern")); return; }
            Resolved r = resolve(searchPath, false);
            if (r == null) { call.resolve(err("搜索目录无法解析")); return; }
            Pattern re;
            try { re = Pattern.compile(pattern); }
            catch (PatternSyntaxException e) { call.resolve(err("正则非法: " + e.getMessage())); return; }
            Pattern includeRe = include != null ? globToRegex(include) : null;
            JSArray matches = new JSArray();
            grepWalk(r, "", re, includeRe, matches, MAX_GREP_MATCHES);
            JSObject res = new JSObject();
            res.put("matches", matches);
            res.put("truncated", matches.length() >= MAX_GREP_MATCHES);
            call.resolve(ok(res));
        } catch (Exception e) {
            call.resolve(err(e.getMessage()));
        }
    }

    // ==================== 路径解析 ====================

    /** 已解析的目标：doc（SAF）或 file（私有目录），二者取其一 */
    private static class Resolved {
        DocumentFile doc;
        File file;
    }

    /**
     * 解析路径：
     *   app://<rel>              → 私有外部目录
     *   root://<rootId>/<rel>    → SAF 授权目录
     */
    private Resolved resolve(String path, boolean forWrite) {
        if (path == null) return null;
        if (path.startsWith("app://") || path.equals("app:/")) {
            String rel = path.substring("app://".length());
            File base = getContext().getExternalFilesDir(null);
            if (base == null) base = getContext().getFilesDir();
            File f = rel.isEmpty() ? base : new File(base, rel);
            // 防路径遍历：解析后的规范路径必须仍在 base 之内
            try {
                String basePath = base.getCanonicalPath();
                String filePath = f.getCanonicalPath();
                if (!filePath.equals(basePath) && !filePath.startsWith(basePath + File.separator)) {
                    return null;
                }
            } catch (Exception e) {
                return null;
            }
            Resolved r = new Resolved();
            r.file = f;
            return r;
        }
        if (path.startsWith("root://")) {
            String rest = path.substring("root://".length());
            int slash = rest.indexOf('/');
            String rootId = slash < 0 ? rest : rest.substring(0, slash);
            String rel = slash < 0 ? "" : rest.substring(slash + 1);
            Uri tree = rootCache.get(rootId);
            if (tree == null) return null;
            DocumentFile root = DocumentFile.fromTreeUri(getContext(), tree);
            if (root == null) return null;
            DocumentFile target = root;
            if (!rel.isEmpty()) {
                String[] segs = rel.split("/");
                for (int si = 0; si < segs.length; si++) {
                    String seg = segs[si];
                    if (seg.isEmpty()) continue;
                    // 防路径遍历：拒绝 . 与 .. 段
                    if (seg.equals(".") || seg.equals("..")) return null;
                    DocumentFile next = target.findFile(seg);
                    if (next == null) {
                        boolean isLast = (si == segs.length - 1);
                        if (forWrite && isLast) {
                            // 按扩展名推断 MIME，避免部分设备强制加 .bin 后缀
                            next = target.createFile(mimeForName(seg), seg);
                        }
                        if (next == null) return null;
                    }
                    target = next;
                }
            }
            Resolved r = new Resolved();
            r.doc = target;
            return r;
        }
        return null; // 未授权绝对路径一律拒绝
    }

    private Resolved resolveForWrite(String path) {
        return resolve(path, true);
    }

    /** 按文件扩展名推断 MIME；未知则用 text/plain（SAF 新建文件必须给 MIME） */
    private String mimeForName(String name) {
        String lower = name == null ? "" : name.toLowerCase();
        int dot = lower.lastIndexOf('.');
        String ext = dot >= 0 ? lower.substring(dot + 1) : "";
        switch (ext) {
            case "txt": case "md": case "log": case "json": case "js":
            case "ts": case "html": case "css": case "xml": case "csv":
                return "text/plain";
            case "jpg": case "jpeg": return "image/jpeg";
            case "png": return "image/png";
            case "gif": return "image/gif";
            case "pdf": return "application/pdf";
            case "zip": return "application/zip";
            default: return "text/plain";
        }
    }

    // ==================== 读写实现 ====================

    private String readText(Resolved r) throws Exception {
        InputStream in = r.doc != null
                ? getContext().getContentResolver().openInputStream(r.doc.getUri())
                : new java.io.FileInputStream(r.file);
        if (in == null) return null;
        try (BufferedReader br = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            char[] buf = new char[8192];
            int n;
            while ((n = br.read(buf)) > 0) sb.append(buf, 0, n);
            return sb.toString();
        }
    }

    private void writeText(Resolved r, String content) throws Exception {
        OutputStream out = r.doc != null
                ? getContext().getContentResolver().openOutputStream(r.doc.getUri(), "wt")
                : new java.io.FileOutputStream(r.file);
        if (out == null) throw new Exception("无法打开输出流");
        try (OutputStream os = out) {
            os.write(content.getBytes(StandardCharsets.UTF_8));
        }
    }

    // ==================== 遍历 / 匹配 ====================

    private void walkAndMatch(Resolved base, String rel, Pattern p, JSArray out, int limit) {
        if (out.length() >= limit) return;
        Iterable<DocumentFile> children = null;
        File[] fileChildren = null;
        if (base.doc != null) children = java.util.Arrays.asList(base.doc.listFiles());
        else fileChildren = base.file.listFiles();
        List<Object> items = new ArrayList<>();
        if (children != null) for (DocumentFile c : children) items.add(c);
        if (fileChildren != null) for (File c : fileChildren) items.add(c);
        for (Object it : items) {
            if (out.length() >= limit) return;
            String name = it instanceof DocumentFile ? ((DocumentFile) it).getName() : ((File) it).getName();
            boolean isDir = it instanceof DocumentFile ? ((DocumentFile) it).isDirectory() : ((File) it).isDirectory();
            String childRel = rel.isEmpty() ? name : rel + "/" + name;
            if (p.matcher(childRel).matches()) out.put(childRel);
            if (isDir) {
                Resolved sub = new Resolved();
                if (it instanceof DocumentFile) sub.doc = (DocumentFile) it;
                else sub.file = (File) it;
                walkAndMatch(sub, childRel, p, out, limit);
            }
        }
    }

    private void grepWalk(Resolved base, String rel, Pattern re, Pattern includeRe, JSArray out, int limit) {
        if (out.length() >= limit) return;
        Iterable<DocumentFile> children = null;
        File[] fileChildren = null;
        if (base.doc != null) children = java.util.Arrays.asList(base.doc.listFiles());
        else fileChildren = base.file.listFiles();
        List<Object> items = new ArrayList<>();
        if (children != null) for (DocumentFile c : children) items.add(c);
        if (fileChildren != null) for (File c : fileChildren) items.add(c);
        for (Object it : items) {
            if (out.length() >= limit) return;
            String name = it instanceof DocumentFile ? ((DocumentFile) it).getName() : ((File) it).getName();
            boolean isDir = it instanceof DocumentFile ? ((DocumentFile) it).isDirectory() : ((File) it).isDirectory();
            String childRel = rel.isEmpty() ? name : rel + "/" + name;
            if (isDir) {
                Resolved sub = new Resolved();
                if (it instanceof DocumentFile) sub.doc = (DocumentFile) it;
                else sub.file = (File) it;
                grepWalk(sub, childRel, re, includeRe, out, limit);
            } else {
                if (includeRe != null && !includeRe.matcher(name).matches()) continue;
                try {
                    Resolved fileR = new Resolved();
                    if (it instanceof DocumentFile) fileR.doc = (DocumentFile) it;
                    else fileR.file = (File) it;
                    String content = readText(fileR);
                    if (content == null) continue;
                    String[] lines = content.split("\r?\n", -1);
                    for (int i = 0; i < lines.length && out.length() < limit; i++) {
                        if (re.matcher(lines[i]).find()) {
                            JSObject m = new JSObject();
                            m.put("path", childRel);
                            m.put("line", i + 1);
                            m.put("text", lines[i]);
                            out.put(m);
                        }
                    }
                } catch (Exception ignored) { }
            }
        }
    }

    /** glob → java.util.regex（支持 * ? **） */
    private Pattern globToRegex(String glob) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < glob.length(); i++) {
            char c = glob.charAt(i);
            switch (c) {
                case '*':
                    if (i + 1 < glob.length() && glob.charAt(i + 1) == '*') { sb.append(".*"); i++; }
                    else sb.append("[^/]*");
                    break;
                case '?': sb.append("[^/]"); break;
                case '.': case '(': case ')': case '+': case '|': case '^':
                case '$': case '@': case '%': case '{': case '}': case '[':
                case ']': case '\\':
                    sb.append('\\').append(c); break;
                default: sb.append(c);
            }
        }
        return Pattern.compile(sb.toString());
    }

    // ==================== 结果封装 ====================

    private JSObject ok(JSObject data) {
        JSObject o = new JSObject();
        o.put("ok", true);
        o.put("data", data);
        return o;
    }

    private JSObject err(String message) {
        JSObject o = new JSObject();
        o.put("ok", false);
        o.put("error", message == null ? "unknown error" : message);
        return o;
    }
}


package kr.ms.gyenam.fileupdown;

import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.PowerManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 웹 화면(index.html)이 부르는 안드로이드 기능 모음
 *  - startService / stopService : 접속 유지(포그라운드 서비스)
 *  - isIgnoringBatteryOptimizations / requestIgnoreBatteryOptimizations : 배터리 제한 해제 안내
 *  - moveToBack : 접속을 유지한 채 앱을 뒤로 보냄(홈 화면)
 *  - saveBegin / saveChunk / saveEnd / saveAbort : 받은 파일을 다운로드 폴더(또는 공유용 임시 폴더)에 저장
 *  - consumeShared : 다른 앱에서 [공유하기]로 넘어온 내용 가져오기
 *  - openUrl : 외부 브라우저로 열기(업데이트 다운로드)
 */
@CapacitorPlugin(name = "GyenamNative")
public class GyenamNativePlugin extends Plugin {
    private static final String SAVE_SUBDIR = "계남중파일업다운";

    static class SharedFile {
        final String name, mime, path;
        final long lastModified;

        SharedFile(String name, String mime, String path, long lastModified) {
            this.name = name;
            this.mime = mime;
            this.path = path;
            this.lastModified = lastModified;
        }
    }

    private static final Object SHARE_LOCK = new Object();
    private static String pendingTitle, pendingText;
    private static List<SharedFile> pendingFiles;
    private static GyenamNativePlugin instance;

    private static class SaveSession {
        OutputStream os;
        Uri mediaUri;          // MediaStore에 저장하는 경우
        File file;             // 일반 파일로 저장하는 경우
        String name;
        String location;
        boolean cache;
    }

    private final Map<String, SaveSession> sessions = new HashMap<>();

    @Override
    public void load() {
        instance = this;
    }

    static void setPendingShared(String title, String text, List<SharedFile> files) {
        synchronized (SHARE_LOCK) {
            pendingTitle = title;
            pendingText = text;
            pendingFiles = files;
        }
        GyenamNativePlugin p = instance;
        if (p != null) {
            try {
                p.notifyListeners("sharedAvailable", new JSObject());
            } catch (Exception ignored) {
            }
        }
    }

    // ---------------------------------------------------------------- 접속 유지 서비스
    @PluginMethod
    public void startService(PluginCall call) {
        try {
            Context ctx = getContext();
            Intent i = new Intent(ctx, KeepAliveService.class);
            i.putExtra("room", call.getString("room", ""));
            ContextCompat.startForegroundService(ctx, i);
            call.resolve();
        } catch (Exception e) {
            call.reject("서비스 시작 실패: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopService(PluginCall call) {
        try {
            getContext().stopService(new Intent(getContext(), KeepAliveService.class));
            call.resolve();
        } catch (Exception e) {
            call.reject("서비스 종료 실패: " + e.getMessage());
        }
    }

    @PluginMethod
    public void isIgnoringBatteryOptimizations(PluginCall call) {
        boolean ignoring = true;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
                ignoring = pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
            }
        } catch (Exception ignored) {
        }
        JSObject r = new JSObject();
        r.put("ignoring", ignoring);
        call.resolve(r);
    }

    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            i.setData(Uri.parse("package:" + getContext().getPackageName()));
            getActivity().startActivity(i);
        } catch (Exception e) {
            try {
                getActivity().startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            } catch (Exception ignored) {
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void moveToBack(PluginCall call) {
        try {
            getActivity().moveTaskToBack(true);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
            call.reject("잘못된 주소");
            return;
        }
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("열 수 있는 앱이 없습니다");
        }
    }

    // ---------------------------------------------------------------- 파일 저장
    private static String safeName(String raw) {
        String n = raw == null ? "" : raw.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
        if (n.isEmpty()) n = "file";
        return n;
    }

    @PluginMethod
    public void saveBegin(PluginCall call) {
        try {
            String name = safeName(call.getString("name"));
            String mime = call.getString("mime", "");
            if (mime == null || mime.isEmpty()) mime = "application/octet-stream";
            String target = call.getString("target", "downloads");
            SaveSession s = new SaveSession();
            s.name = name;
            s.cache = "cache".equals(target);

            if (s.cache) {
                File dir = new File(getContext().getCacheDir(), "outshare");
                MainActivity.deleteRecursive(dir);
                File sub = new File(dir, UUID.randomUUID().toString().substring(0, 8));
                //noinspection ResultOfMethodCallIgnored
                sub.mkdirs();
                s.file = new File(sub, name);
                s.os = new FileOutputStream(s.file);
                s.location = s.file.getAbsolutePath();
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentResolver cr = getContext().getContentResolver();
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + SAVE_SUBDIR);
                v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                s.mediaUri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (s.mediaUri == null) throw new Exception("저장 위치를 만들지 못했습니다");
                s.os = cr.openOutputStream(s.mediaUri);
                s.location = "다운로드/" + SAVE_SUBDIR;
            } else {
                // 안드로이드 9 이하: 별도 권한 없이 쓸 수 있는 앱 전용 다운로드 폴더에 저장
                File base = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                File dir = new File(base, SAVE_SUBDIR);
                //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
                File f = new File(dir, name);
                int k = 1;
                while (f.exists()) {
                    int dot = name.lastIndexOf('.');
                    String stem = dot > 0 ? name.substring(0, dot) : name;
                    String ext = dot > 0 ? name.substring(dot) : "";
                    f = new File(dir, stem + " (" + (k++) + ")" + ext);
                }
                s.file = f;
                s.name = f.getName();
                s.os = new FileOutputStream(f);
                s.location = "Android/data/" + getContext().getPackageName() + "/files/Download/" + SAVE_SUBDIR;
            }
            if (s.os == null) throw new Exception("파일을 열지 못했습니다");

            String id = UUID.randomUUID().toString();
            synchronized (sessions) {
                sessions.put(id, s);
            }
            JSObject r = new JSObject();
            r.put("id", id);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("저장 시작 실패: " + e.getMessage());
        }
    }

    @PluginMethod
    public void saveChunk(PluginCall call) {
        SaveSession s;
        synchronized (sessions) {
            s = sessions.get(call.getString("id"));
        }
        if (s == null) {
            call.reject("저장 세션이 없습니다");
            return;
        }
        try {
            String data = call.getString("data", "");
            if (data != null && !data.isEmpty()) {
                s.os.write(Base64.decode(data, Base64.DEFAULT));
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("저장 중 오류: " + e.getMessage());
        }
    }

    @PluginMethod
    public void saveEnd(PluginCall call) {
        SaveSession s;
        synchronized (sessions) {
            s = sessions.remove(call.getString("id"));
        }
        if (s == null) {
            call.reject("저장 세션이 없습니다");
            return;
        }
        try {
            s.os.flush();
            s.os.close();
            String finalName = s.name;
            if (s.mediaUri != null) {
                ContentResolver cr = getContext().getContentResolver();
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.IS_PENDING, 0);
                cr.update(s.mediaUri, v, null, null);
                try (Cursor c = cr.query(s.mediaUri, new String[]{MediaStore.MediaColumns.DISPLAY_NAME}, null, null, null)) {
                    if (c != null && c.moveToFirst()) finalName = c.getString(0);
                }
            }
            JSObject r = new JSObject();
            r.put("name", finalName);
            r.put("location", s.location);
            if (s.file != null) r.put("uri", "file://" + s.file.getAbsolutePath());
            call.resolve(r);
        } catch (Exception e) {
            call.reject("저장 마무리 실패: " + e.getMessage());
        }
    }

    @PluginMethod
    public void saveAbort(PluginCall call) {
        SaveSession s;
        synchronized (sessions) {
            s = sessions.remove(call.getString("id"));
        }
        if (s != null) {
            try {
                if (s.os != null) s.os.close();
            } catch (Exception ignored) {
            }
            try {
                if (s.mediaUri != null) getContext().getContentResolver().delete(s.mediaUri, null, null);
                if (s.file != null) //noinspection ResultOfMethodCallIgnored
                    s.file.delete();
            } catch (Exception ignored) {
            }
        }
        call.resolve();
    }

    // ---------------------------------------------------------------- 공유 수신
    @PluginMethod
    public void consumeShared(PluginCall call) {
        String title, text;
        List<SharedFile> files;
        synchronized (SHARE_LOCK) {
            title = pendingTitle;
            text = pendingText;
            files = pendingFiles;
            pendingTitle = null;
            pendingText = null;
            pendingFiles = null;
        }
        JSObject r = new JSObject();
        r.put("title", title == null ? "" : title);
        r.put("text", text == null ? "" : text);
        r.put("url", "");
        JSArray arr = new JSArray();
        if (files != null) {
            for (SharedFile f : files) {
                JSObject o = new JSObject();
                o.put("name", f.name);
                o.put("mime", f.mime);
                o.put("path", f.path);
                o.put("lastModified", f.lastModified);
                arr.put(o);
            }
        }
        r.put("files", arr);
        call.resolve(r);
    }
}

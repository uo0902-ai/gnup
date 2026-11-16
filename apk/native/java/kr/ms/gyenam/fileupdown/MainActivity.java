package kr.ms.gyenam.fileupdown;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.view.View;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {
    private final Handler handler = new Handler(Looper.getMainLooper());

    /**
     * 앱이 화면 밖으로 나가면 안드로이드가 웹 화면(WebView)의 타이머를 늦추거나 멈춥니다.
     * 접속 유지 서비스가 켜져 있는 동안은 WebView가 계속 '보이는 상태'라고 알려서 연결 확인 신호가 끊기지 않게 합니다.
     */
    private final Runnable keepWebViewAlive = new Runnable() {
        @Override
        public void run() {
            try {
                WebView wv = getBridge().getWebView();
                if (wv != null) {
                    wv.resumeTimers();
                    wv.dispatchWindowVisibilityChanged(View.VISIBLE);
                }
            } catch (Throwable ignored) {
            }
            if (KeepAliveService.running) {
                handler.postDelayed(this, 15000);
            }
        }
    };

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GyenamNativePlugin.class);
        super.onCreate(savedInstanceState);
        handleShareIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleShareIntent(intent);
    }

    @Override
    public void onPause() {
        super.onPause();
        handler.removeCallbacks(keepWebViewAlive);
        if (KeepAliveService.running) {
            handler.postDelayed(keepWebViewAlive, 1000);
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        handler.removeCallbacks(keepWebViewAlive);
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(keepWebViewAlive);
        super.onDestroy();
    }

    /** 다른 앱의 [공유하기]로 들어온 파일/글을 앱 임시 폴더로 복사해 두고 웹 화면에 알림 */
    private void handleShareIntent(Intent intent) {
        if (intent == null) return;
        final String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;

        final String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        final String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        final List<Uri> uris = new ArrayList<>();
        try {
            if (Intent.ACTION_SEND.equals(action)) {
                Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (u != null) uris.add(u);
            } else {
                ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (list != null) uris.addAll(list);
            }
            ClipData clip = intent.getClipData();
            if (uris.isEmpty() && clip != null) {
                for (int i = 0; i < clip.getItemCount(); i++) {
                    Uri u = clip.getItemAt(i).getUri();
                    if (u != null) uris.add(u);
                }
            }
        } catch (Exception ignored) {
        }

        final ContentResolver cr = getContentResolver();
        final File baseDir = new File(getCacheDir(), "inshare");
        new Thread(new Runnable() {
            @Override
            public void run() {
                deleteRecursive(baseDir);
                baseDir.mkdirs();
                List<GyenamNativePlugin.SharedFile> files = new ArrayList<>();
                int index = 0;
                for (Uri uri : uris) {
                    try {
                        String name = queryName(cr, uri);
                        if (name == null || name.isEmpty()) name = "shared_file_" + (index + 1);
                        name = name.replaceAll("[\\\\/:*?\"<>|]", "_");
                        File out = new File(baseDir, (index++) + "_" + name);
                        try (InputStream in = cr.openInputStream(uri); OutputStream os = new FileOutputStream(out)) {
                            if (in == null) continue;
                            byte[] buf = new byte[64 * 1024];
                            int n;
                            while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                        }
                        String mime = cr.getType(uri);
                        files.add(new GyenamNativePlugin.SharedFile(name, mime == null ? "" : mime, out.getAbsolutePath(), System.currentTimeMillis()));
                    } catch (Exception ignored) {
                    }
                }
                GyenamNativePlugin.setPendingShared(subject, text, files);
            }
        }).start();
    }

    private static String queryName(ContentResolver cr, Uri uri) {
        try (Cursor c = cr.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) {
        }
        String last = uri.getLastPathSegment();
        return last;
    }

    static void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteRecursive(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}

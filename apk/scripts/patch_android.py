#!/usr/bin/env python3
"""`npx cap add android`로 만들어진 안드로이드 프로젝트에 계남중 파일업다운 전용 설정을 입힙니다.
 (apk 폴더에서 실행: python3 scripts/patch_android.py)
  1) 자바 파일(백그라운드 서비스·파일 저장·공유 수신) 복사
  2) AndroidManifest.xml에 권한·서비스·공유 수신 필터 추가
  3) build.gradle에 서명 설정·버전 번호 반영
  4) 앱 아이콘/시작 화면을 계남중 아이콘으로 교체
"""
import os, re, sys, glob, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
APK = os.path.dirname(HERE)                      # .../apk
ROOT = os.path.dirname(APK)                      # 저장소 루트(아이콘 위치)
AND = os.path.join(APK, 'android')
MAIN = os.path.join(AND, 'app', 'src', 'main')
APP_ID = 'kr.ms.gyenam.fileupdown'
VERSION = os.environ.get('APP_VERSION', 'v3.0').lstrip('vV')
RUN_NUMBER = int(os.environ.get('RUN_NUMBER', '1') or 1)

def read(p):
    with open(p, encoding='utf-8') as f: return f.read()
def write(p, t):
    with open(p, 'w', encoding='utf-8') as f: f.write(t)

# 1) 자바/리소스 복사 -------------------------------------------------
jdst = os.path.join(MAIN, 'java', *APP_ID.split('.'))
os.makedirs(jdst, exist_ok=True)
jsrc = os.path.join(APK, 'native', 'java', *APP_ID.split('.'))
for fn in os.listdir(jsrc):
    shutil.copy(os.path.join(jsrc, fn), os.path.join(jdst, fn))
    print('복사:', fn)
shutil.copytree(os.path.join(APK, 'native', 'res'), os.path.join(MAIN, 'res'), dirs_exist_ok=True)
print('리소스 복사 완료')

# 2) AndroidManifest ---------------------------------------------------
mp = os.path.join(MAIN, 'AndroidManifest.xml')
m = read(mp)
PERMS = ['ACCESS_NETWORK_STATE', 'ACCESS_WIFI_STATE', 'WAKE_LOCK', 'FOREGROUND_SERVICE',
         'FOREGROUND_SERVICE_SPECIAL_USE', 'POST_NOTIFICATIONS', 'REQUEST_IGNORE_BATTERY_OPTIMIZATIONS', 'REQUEST_INSTALL_PACKAGES']
perm_xml = ''.join(f'    <uses-permission android:name="android.permission.{p}" />\n' for p in PERMS)
assert '</manifest>' in m and '</application>' in m and '</activity>' in m, '예상과 다른 AndroidManifest.xml'
service_xml = '''        <service
            android:name=".KeepAliveService"
            android:exported="false"
            android:foregroundServiceType="specialUse">
            <property
                android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
                android:value="peer-to-peer file sharing connection kept alive while the app is in the background" />
        </service>
        <provider
            android:name=".GyenamFileProvider"
            android:authorities="${applicationId}.gyenamfiles"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/gyenam_file_paths" />
        </provider>
'''
share_xml = '''            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="*/*" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SEND_MULTIPLE" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="*/*" />
            </intent-filter>
'''
# 공유로 들어올 때 앱 화면이 두 개 생기지 않도록 한 화면만 쓰는 모드(singleTask)로 고정
def _fix_launch_mode(mx):
    mm = re.search(r'<activity\b[^>]*>', mx)
    tag = mm.group(0)
    if 'android:launchMode' in tag:
        new = re.sub(r'android:launchMode="[^"]*"', 'android:launchMode="singleTask"', tag)
    else:
        new = tag[:-1] + ' android:launchMode="singleTask">'
    return mx.replace(tag, new, 1)
m = _fix_launch_mode(m)
if 'KeepAliveService' not in m:
    m = m.replace('</activity>', share_xml + '        </activity>', 1)
    m = m.replace('</application>', service_xml + '    </application>', 1)
    m = m.replace('</manifest>', perm_xml + '</manifest>', 1)
write(mp, m)
print('매니페스트 수정 완료')

# 3) build.gradle -------------------------------------------------------
gp = os.path.join(AND, 'app', 'build.gradle')
g = read(gp)
g, n1 = re.subn(r'(versionCode\s*=?\s*)\d+', lambda x: f'{x.group(1)}{RUN_NUMBER}', g, count=1)
g, n2 = re.subn(r'(versionName\s*=?\s*)"[^"]*"', lambda x: f'{x.group(1)}"{VERSION}"', g, count=1)
print('versionCode', n1, 'versionName', n2, '->', RUN_NUMBER, VERSION)
if 'signingConfigs.gyenam' not in g:
    g += '''

// ---- 계남중 파일업다운: 서명 설정(항상 같은 키로 서명해야 기존 앱 위에 업데이트 설치가 됩니다) ----
android {
    signingConfigs {
        gyenam {
            storeFile = file("../../signing/gyenam.jks")
            storePassword = "gyenam-fileupdown"
            keyAlias = "gyenam"
            keyPassword = "gyenam-fileupdown"
        }
    }
    buildTypes {
        release {
            signingConfig = signingConfigs.gyenam
        }
    }
    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}
'''
write(gp, g)

# 4) 아이콘 / 시작 화면 -----------------------------------------------
from PIL import Image, ImageDraw
icon = Image.open(os.path.join(ROOT, 'icon-512.png')).convert('RGBA')
mask_icon = Image.open(os.path.join(ROOT, 'icon-maskable-512.png')).convert('RGBA')
res = os.path.join(MAIN, 'res')
legacy = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
fg = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}
for d, px in legacy.items():
    out = os.path.join(res, f'mipmap-{d}'); os.makedirs(out, exist_ok=True)
    sq = icon.resize((px, px), Image.LANCZOS)
    sq.save(os.path.join(out, 'ic_launcher.png'))
    rd = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    mk = Image.new('L', (px * 4, px * 4), 0)
    ImageDraw.Draw(mk).ellipse((0, 0, px * 4 - 1, px * 4 - 1), fill=255)
    mk = mk.resize((px, px), Image.LANCZOS)
    rd.paste(sq, (0, 0), mk)
    rd.save(os.path.join(out, 'ic_launcher_round.png'))
    fpx = fg[d]
    mask_icon.resize((fpx, fpx), Image.LANCZOS).save(os.path.join(out, 'ic_launcher_foreground.png'))
any26 = os.path.join(res, 'mipmap-anydpi-v26'); os.makedirs(any26, exist_ok=True)
adaptive = '''<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
'''
write(os.path.join(any26, 'ic_launcher.xml'), adaptive)
write(os.path.join(any26, 'ic_launcher_round.xml'), adaptive)
os.makedirs(os.path.join(res, 'values'), exist_ok=True)
write(os.path.join(res, 'values', 'ic_launcher_background.xml'),
      '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#3730A3</color>\n</resources>\n')

# 시작 화면(splash): 기본 캐패시터 로고 대신 남색 바탕 + 계남중 아이콘
count = 0
for p in glob.glob(os.path.join(res, '**', 'splash*.png'), recursive=True):
    try:
        w, h = Image.open(p).size
    except Exception:
        continue
    bg = Image.new('RGBA', (w, h), (55, 48, 163, 255))
    s = int(min(w, h) * 0.28)
    ic = icon.resize((s, s), Image.LANCZOS)
    bg.paste(ic, ((w - s) // 2, (h - s) // 2), ic)
    bg.convert('RGB').save(p)
    count += 1
print('시작 화면 이미지 교체:', count)
print('완료')

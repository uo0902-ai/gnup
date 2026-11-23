/**
 * 계남중 파일업다운 - 전송 기록 수신 스크립트 (구글 시트에 붙여서 사용)
 * 설치: 기록용 구글 시트 열기 → 확장 프로그램 → Apps Script → 이 코드 전체 붙여넣기 → 저장
 *       → 배포 → 새 배포 → 유형 '웹 앱' → 실행: 나, 액세스 권한: 모든 사용자 → 배포 → 웹 앱 URL 복사
 * 시트에는 '로그', '기기목록' 탭이 자동으로 만들어집니다.
 */
var TOKEN = 'gyenam-c2f9f473b99507fbbb1e';                       // 앱(index.html)의 LOG_TOKEN과 같아야 함
var TZ = 'Asia/Seoul';
var DANGEROUS = /\.(exe|msi|bat|cmd|com|scr|vbs|js|jse|wsf|ps1|jar|apk|dmg|pkg|sh|lnk|reg|dll|hta|iso)$/i;
var FLOOD_COUNT = 10;                       // 이 횟수 이상
var FLOOD_SECONDS = 60;                     // 이 시간(초) 안에 같은 기기가 보내면 '과다전송'
var NICK_LIMIT = 3;                         // 한 기기가 닉네임을 이 개수 이상 쓰면 '닉네임 여러 개'
var TEACHER_FOLDER_ID = '1GqOhJHp94A9szAVjIhzFOfQxPPhcT-hX';   // 학생이 '선생님께 전송'한 파일이 저장될 구글 드라이브 폴더
var TEACHER_MAX_BYTES = 20 * 1024 * 1024;                      // 파일 1개당 최대 크기
var BLOCKED = /\.(exe|msi|bat|cmd|scr|vbs|jse|wsf|ps1|jar|apk|dll|hta|reg|lnk)$/i;  // 받지 않는 파일 형식

var LOG_HEAD = ['시간','기기번호','닉네임','플랫폼','기기모델','방코드','구분','상대','종류','파일명','크기','결과','메시지 내용','이상 표시','기기ID(접속)','설치ID','안드로이드ID','앱버전','전송ID'];
var DEV_HEAD = ['기기번호','기기키','처음 본 시간','마지막 시간','플랫폼','기기모델','사용한 닉네임'];

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.token !== TOKEN) return json_({ ok: false, error: '허용되지 않은 요청입니다' });
    var ss = SpreadsheetApp.getActive();
    if (ss.getSpreadsheetTimeZone() !== TZ) ss.setSpreadsheetTimeZone(TZ);
    if (body.action === 'resetAll') {
      var ep = Date.now();
      PropertiesService.getScriptProperties().setProperty('RESET_EPOCH', String(ep));
      return json_({ ok: true, epoch: ep });
    }
    if (body.action === 'diag') return diagRow_(ss, body);
    if (body.action === 'setServer') {
      var sv = body.server || {};
      var rev = Date.now();
      var cfg = sv.host ? { rev: rev, host: String(sv.host).slice(0, 100), port: Number(sv.port) || 9000, path: String(sv.path || '/'), secure: !!sv.secure } : { rev: rev };
      PropertiesService.getScriptProperties().setProperty('SERVER_CFG', JSON.stringify(cfg));
      return json_({ ok: true, rev: rev });
    }
    if (body.action === 'teacherUpload') return teacherUpload_(ss, body);
    var log = sheet_(ss, '로그', LOG_HEAD);
    var dev = sheet_(ss, '기기목록', DEV_HEAD);
    var rows = body.rows || [];
    for (var i = 0; i < rows.length; i++) addRow_(log, dev, rows[i]);
    return out_('ok ' + rows.length);
  } catch (err) {
    return out_('error ' + err);
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  if (e && e.parameter && e.parameter.a === 'epoch') {
    var P = PropertiesService.getScriptProperties();
    var srv = null;
    try { srv = JSON.parse(P.getProperty('SERVER_CFG') || 'null'); } catch (x) { srv = null; }
    return json_({ ok: true, epoch: Number(P.getProperty('RESET_EPOCH') || 0), server: srv });
  }
  if (e && e.parameter && e.parameter.a === 'update') return json_(updateInfo_());
  return out_('계남중 파일업다운 기록 수신 준비됨 (v3.31 · 선생님께 전송 · 전체 초기화 · 경로 진단 · 업데이트 정보 · 서버 지정 지원)');
}

var DIAG_HEAD = ['서버시간','기기측 시간','기기ID','닉네임','방코드','앱버전','사유','판정','공인IP','내부IP','회선','구글(ms)','기록서버(ms)','PeerJS HTTPS(ms)','웹소켓 열림(ms)','웹소켓 응답(ms)','웹소켓 성공','STUN(ms)','직전 로그'];

// 학생 기기의 '경로 진단' 결과를 '진단' 탭에 한 줄씩 기록 (28대를 시간순으로 비교하는 용도)
function diagRow_(ss, b) {
  var r = b.rec || {}, x = r.res || {};
  var sh = sheet_(ss, '진단', DIAG_HEAD);
  var row = [
    Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'),
    Utilities.formatDate(new Date(r.t || Date.now()), TZ, 'HH:mm:ss'),
    String(b.device || ''), String(b.nick || ''), String(b.room || ''), String(b.ver || ''),
    String(r.reason || ''), String(r.verdict || ''), String(x.pubIp || ''), String(x.lanIp || ''), String(x.net || ''),
    x.google, x.script, x.peerHttp, x.wsOpen, x.wsMsg, x.wsOk ? 'O' : 'X', x.stun,
    String((r.lines || []).join('\n')).slice(0, 45000)
  ];
  sh.appendRow(row);
  return json_({ ok: true });
}

// 학생 기기들이 GitHub를 직접 부르면 학교 공인 IP 하나로 '시간당 60번' 한도에 걸리므로,
// 이 스크립트가 10분에 한 번만 GitHub에 묻고 저장해 둔 값을 모두에게 돌려줍니다.
var GH_LATEST = 'https://api.github.com/repos/uo0902-ai/gnup/releases/latest';
function updateInfo_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('UPD');
  if (hit) return JSON.parse(hit);
  var props = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();
  var locked = false;
  try { locked = lock.tryLock(5000); } catch (e) {}
  try {
    hit = cache.get('UPD');
    if (hit) return JSON.parse(hit);
    try {
      var r = UrlFetchApp.fetch(GH_LATEST, { muteHttpExceptions: true, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'gyenam-fileupdown' } });
      if (r.getResponseCode() === 200) {
        var j = JSON.parse(r.getContentText());
        var apk = (j.assets || []).filter(function (a) { return /\.apk$/i.test(a.name || ''); })[0];
        var o = { ok: true, tag: j.tag_name, apkUrl: apk ? apk.browser_download_url : '', htmlUrl: j.html_url || '', at: Date.now() };
        cache.put('UPD', JSON.stringify(o), 600);
        props.setProperty('UPD_LAST', JSON.stringify(o));
        return o;
      }
    } catch (e) {}
    var last = props.getProperty('UPD_LAST');
    if (last) { var s = JSON.parse(last); s.stale = true; cache.put('UPD', JSON.stringify(s), 60); return s; }
    return { ok: false };
  } finally {
    if (locked) lock.releaseLock();
  }
}

function out_(t) { return ContentService.createTextOutput(t); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function cleanName_(x, max) { return String(x || '').replace(/[\\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, max || 60); }

// 학생이 '선생님께 전송'으로 보낸 파일을 드라이브 폴더에 저장: 폴더/1학년 3반/이름_날짜시간_파일명
function teacherUpload_(ss, b) {
  try {
    var grade = cleanName_(b.grade, 2), cls = cleanName_(b.cls, 3), name = cleanName_(b.name, 20);
    var fname = cleanName_(b.filename, 100) || 'file';
    if (!/^[1-3]$/.test(grade) || !/^\d{1,2}$/.test(cls) || !name) return json_({ ok: false, error: '학년·반·이름이 올바르지 않습니다' });
    if (BLOCKED.test(fname)) return json_({ ok: false, error: '받을 수 없는 파일 형식입니다' });
    var bytes = Utilities.base64Decode(String(b.data || ''));
    if (!bytes.length) return json_({ ok: false, error: '빈 파일입니다' });
    if (bytes.length > TEACHER_MAX_BYTES) return json_({ ok: false, error: '파일이 너무 큽니다' });

    var root = DriveApp.getFolderById(TEACHER_FOLDER_ID);
    var folderName = grade + '학년 ' + cls + '반';
    var it = root.getFoldersByName(folderName);
    var folder = it.hasNext() ? it.next() : root.createFolder(folderName);

    // 같은 전송을 다시 보내도(재시도) 중복 저장되지 않도록 전송ID를 이름에 넣어 확인
    var tag = String(b.uploadId || '').replace(/[^A-Za-z0-9_]/g, '').slice(-10);
    var stamp = Utilities.formatDate(new Date(b.t || Date.now()), TZ, 'MMdd_HHmm');
    var finalName = name + '_' + stamp + (tag ? '_' + tag : '') + '_' + fname;
    var dup = folder.getFilesByName(finalName);
    var file;
    var duplicate = false;
    if (dup.hasNext()) { file = dup.next(); duplicate = true; }
    else file = folder.createFile(Utilities.newBlob(bytes, b.mime || 'application/octet-stream', finalName));

    if (!duplicate) {
      var log = sheet_(ss, '로그', LOG_HEAD);
      var dev = sheet_(ss, '기기목록', DEV_HEAD);
      var nick = grade + '학년 ' + cls + '반 ' + name;
      addRow_(log, dev, {
        t: b.t, nick: nick, room: '', deviceId: b.deviceId, installId: b.installId, androidId: b.androidId, model: b.model,
        platform: b.platform, appVer: b.appVer, dir: '선생님께 전송', peer: '선생님(드라이브)', kind: '파일',
        filename: fname, size: b.sizeLabel || '', result: '저장 완료', text: file.getUrl(), transferId: b.uploadId
      });
    }
    return json_({ ok: true, name: finalName, url: file.getUrl(), duplicate: duplicate });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function sheet_(ss, name, head) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(head);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, head.length).setFontWeight('bold').setBackground('#e0e7ff');
  }
  return sh;
}

var DATE_FMT = 'yyyy-MM-dd HH:mm:ss';

// 글자는 '일반 글자'로 기록 (v1_7.md 같은 파일명이 자동으로 링크가 되지 않게 함)
function put_(sh, row, formats) {
  var rg = sh.getRange(sh.getLastRow() + 1, 1, 1, row.length);
  rg.setNumberFormats([formats]);
  rg.setValues([row]);
  return rg;
}

function fmt_(ms) { return Utilities.formatDate(new Date(ms || Date.now()), TZ, 'yyyy-MM-dd HH:mm:ss'); }

// 기기번호 부여: 안드로이드ID가 있으면 그것, 없으면 설치ID로 같은 기기를 알아봄
function deviceNo_(dev, r) {
  var key = r.androidId ? ('A:' + r.androidId) : ('I:' + r.installId);
  var last = dev.getLastRow();
  var data = last > 1 ? dev.getRange(2, 1, last - 1, DEV_HEAD.length).getValues() : [];
  var maxNo = 0, hit = -1;
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] > maxNo) maxNo = data[i][0];
    if (data[i][1] === key) hit = i;
  }
  var nick = r.nick || '';
  if (hit < 0) {
    var no = maxNo + 1;
    put_(dev, [no, key, new Date(r.t || Date.now()), new Date(r.t || Date.now()), r.platform || '', r.model || '', nick],
         ['0', '@', DATE_FMT, DATE_FMT, '@', '@', '@']);
    return { no: no, nickCount: nick ? 1 : 0 };
  }
  var rowNo = hit + 2;
  var nicks = String(data[hit][6] || '').split(', ').filter(function (x) { return x; });
  if (nick && nicks.indexOf(nick) < 0) nicks.push(nick);
  dev.getRange(rowNo, 4).setNumberFormat(DATE_FMT).setValue(new Date(r.t || Date.now()));
  dev.getRange(rowNo, 5, 1, 3).setNumberFormat('@').setValues([[r.platform || data[hit][4], r.model || data[hit][5], nicks.join(', ')]]);
  return { no: data[hit][0], nickCount: nicks.length };
}

function addRow_(log, dev, r) {
  var d = deviceNo_(dev, r);
  var flags = [];
  if (r.filename && DANGEROUS.test(String(r.filename))) flags.push('위험 확장자');
  if (r.dir === '송신') {
    var last = log.getLastRow();
    if (last > 1) {
      var from = Math.max(2, last - 300);
      var recent = log.getRange(from, 1, last - from + 1, 7).getValues();
      var cutoff = (r.t || Date.now()) - FLOOD_SECONDS * 1000;
      var n = 1;
      for (var i = 0; i < recent.length; i++) {
        if (recent[i][1] === d.no && recent[i][6] === '송신') {
          var t0 = recent[i][0];
          var t = (t0 instanceof Date) ? t0.getTime() : new Date(String(t0).replace(' ', 'T') + '+09:00').getTime();
          if (t >= cutoff) n++;
        }
      }
      if (n >= FLOOD_COUNT) flags.push('과다전송(' + FLOOD_SECONDS + '초 ' + n + '회)');
    }
  }
  if (d.nickCount >= NICK_LIMIT) flags.push('닉네임 여러 개');
  if (/^실패/.test(String(r.result || ''))) flags.push('전송 실패');
  var row = [new Date(r.t || Date.now()), d.no, r.nick || '', r.platform || '', r.model || '', r.room || '', r.dir || '', r.peer || '',
             r.kind || '', r.filename || '', r.size || '', r.result || '', r.text || '', flags.join(' / '),
             r.deviceId || '', r.installId || '', r.androidId || '', r.appVer || '', r.transferId || ''];
  var rg = put_(log, row, [DATE_FMT, '0', '@', '@', '@', '@', '@', '@', '@', '@', '@', '@', '@', '@', '@', '@', '@', '@', '@']);
  if (flags.length) rg.setBackground('#fee2e2');
}

/**
 * (한 번만 실행) 이미 쌓인 기록에서 파일명 등에 걸린 링크를 없애고 일반 글자로 바꿈
 * Apps Script 위쪽 함수 선택 칸에서 '링크없애기'를 고르고 [실행]
 */
function 링크없애기() {
  var sh = SpreadsheetApp.getActive().getSheetByName('로그');
  if (!sh || sh.getLastRow() < 2) return;
  var n = sh.getLastRow() - 1;
  [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19].forEach(function (c) {
    var rg = sh.getRange(2, c, n, 1);
    var v = rg.getValues();
    rg.clearFormat().setNumberFormat('@').setValues(v);
  });
}

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

var LOG_HEAD = ['시간','기기번호','닉네임','플랫폼','기기모델','방코드','구분','상대','종류','파일명','크기','결과','메시지 내용','이상 표시','기기ID(접속)','설치ID','안드로이드ID','앱버전','전송ID'];
var DEV_HEAD = ['기기번호','기기키','처음 본 시간','마지막 시간','플랫폼','기기모델','사용한 닉네임'];

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.token !== TOKEN) return out_('bad token');
    var ss = SpreadsheetApp.getActive();
    if (ss.getSpreadsheetTimeZone() !== TZ) ss.setSpreadsheetTimeZone(TZ);
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

function doGet() { return out_('계남중 파일업다운 기록 수신 준비됨'); }

function out_(t) { return ContentService.createTextOutput(t); }

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

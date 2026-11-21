// 계남중 파일업다운 - 학교 노트북용 PeerJS 연결 중계 서버
// 파일과 메시지는 이 서버를 거치지 않고 기기끼리 직접 오갑니다. 이 서버는 '서로 찾기'만 도와줍니다.
// v3.23: 상태 화면 보강 (현재 접속 대수, 방별 방장, 최근 1분 새 접속, 최근 기록)
// v3.24: 끊어진 옛 방장 ID를 더 빨리 풀도록 alive_timeout 단축 (기본 60초 → 30초)
const os = require('os');
const { PeerServer } = require('peer');

const PORT = parseInt(process.env.PORT || '9000', 10);
const RENDER_MS = parseInt(process.env.RENDER_MS || '2000', 10);   // 화면 새로고침 간격
// 기기가 신호를 30초 넘게 안 보내면 '죽은 접속'으로 보고 ID를 풀어 줍니다. (PeerJS 기본값은 60초)
// 너무 짧으면 화면이 꺼진 기기가 잘못 끊길 수 있으니 시험 후 조정하세요. 예) set ALIVE_TIMEOUT=20000
const ALIVE_TIMEOUT = Math.max(10000, parseInt(process.env.ALIVE_TIMEOUT || '30000', 10));
const HOST_ID_RE = /^gyenam-ms-room2-(\d{4})-host$/;               // 방장 노드 ID (방 코드가 들어 있음)

const server = PeerServer({
  port: PORT,
  path: '/',
  key: 'peerjs',
  concurrent_limit: 5000,
  alive_timeout: ALIVE_TIMEOUT,
  allow_discovery: false,
  corsOptions: { origin: true }
});

const startedAt = Date.now();
const clients = new Map();      // id -> { since, room|null }
const recentConnects = [];      // 새 접속 시각(ms) 목록 (최근 1분 계산용)
const events = [];              // 최근 기록
let peak = 0;
let totalConnects = 0;
let lastError = '';

function hhmmss(t) { return new Date(t || Date.now()).toTimeString().split(' ')[0]; }
function dur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}
function addEvent(msg) {
  events.push(`[${hhmmss()}] ${msg}`);
  while (events.length > 12) events.shift();
}
function describe(id) {
  const m = HOST_ID_RE.exec(id);
  return m ? `방장 #${m[1]}` : `게스트 ${String(id).slice(0, 8)}`;
}

server.on('connection', (client) => {
  const id = client.getId();
  const m = HOST_ID_RE.exec(id);
  clients.set(id, { since: Date.now(), room: m ? m[1] : null });
  totalConnects++;
  recentConnects.push(Date.now());
  if (clients.size > peak) peak = clients.size;
  addEvent(`접속 +1  ${describe(id)}`);
});
server.on('disconnect', (client) => {
  const id = client.getId();
  clients.delete(id);
  addEvent(`퇴장 -1  ${describe(id)}`);
});
server.on('error', (e) => {
  lastError = (e && e.message) ? e.message : String(e);
  addEvent('서버 오류: ' + lastError);
});

function addressLines() {
  const out = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach((name) => {
    (ifs[name] || []).filter(a => a.family === 'IPv4' && !a.internal).forEach(a => out.push(`   ${a.address}   (${name})`));
  });
  return out;
}

function render() {
  const now = Date.now();
  while (recentConnects.length && now - recentConnects[0] > 60000) recentConnects.shift();
  const hosts = [...clients.entries()].filter(([, c]) => c.room).sort((a, b) => a[1].room.localeCompare(b[1].room));
  const guests = clients.size - hosts.length;

  const L = [];
  L.push('==================================================');
  L.push(` 계남중 파일업다운 · 노트북 서버 (켜진 지 ${dur(now - startedAt)})`);
  L.push(` 포트: ${PORT}   ·   지금 시각 ${hhmmss(now)}   ·   끊김 판정 ${Math.round(ALIVE_TIMEOUT / 1000)}초`);
  L.push(' 앱 [교사 설정]에 입력할 IP 주소 (학교 와이파이/학내망 주소):');
  addressLines().forEach(l => L.push(l));
  L.push('--------------------------------------------------');
  L.push(` 현재 접속 ${clients.size}대  (방장 ${hosts.length} · 게스트 ${guests})     최고 ${peak}대`);
  L.push(` 최근 1분 새 접속 ${recentConnects.length}건   ·   누적 ${totalConnects}건`);
  if (clients.size === 0) L.push(' ※ 지금 접속한 기기가 없습니다. (앱에서 서버를 바꿨는지, 방화벽을 확인하세요)');
  L.push('--------------------------------------------------');
  L.push(' 방 목록 (방장이 접속해 있는 방)');
  if (!hosts.length) L.push('   (없음)');
  hosts.forEach(([, c]) => L.push(`   #${c.room}   방장 접속 중 (${hhmmss(c.since)}부터 ${dur(now - c.since)})`));
  L.push('--------------------------------------------------');
  L.push(' 최근 기록 (최신이 아래)');
  if (!events.length) L.push('   (아직 없음)');
  events.forEach(e => L.push('   ' + e));
  L.push('==================================================');
  L.push(' 이 창을 닫으면 서버가 꺼집니다. 수업이 끝날 때까지 열어 두세요.');

  if (process.stdout.isTTY) console.clear();
  console.log(L.join('\n'));
}

addEvent('서버가 켜졌습니다');
render();
setInterval(render, RENDER_MS);

process.on('uncaughtException', (e) => addEvent('예외(계속 실행): ' + (e && e.message ? e.message : e)));
process.on('unhandledRejection', (e) => addEvent('예외(계속 실행): ' + (e && e.message ? e.message : e)));

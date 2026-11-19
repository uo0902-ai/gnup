// 계남중 파일업다운 - 학교 노트북용 PeerJS 연결 중계 서버
// 파일과 메시지는 이 서버를 거치지 않고 기기끼리 직접 오갑니다. 이 서버는 '서로 찾기'만 도와줍니다.
const os = require('os');
const { PeerServer } = require('peer');

const PORT = parseInt(process.env.PORT || '9000', 10);

const server = PeerServer({
  port: PORT,
  path: '/',
  key: 'peerjs',
  concurrent_limit: 5000,
  allow_discovery: false,
  corsOptions: { origin: true }
});

let online = 0;
server.on('connection', (client) => { online++; log(`접속 +1 (현재 ${online}대) ${client.getId()}`); });
server.on('disconnect', (client) => { online = Math.max(0, online - 1); log(`퇴장 -1 (현재 ${online}대) ${client.getId()}`); });
server.on('error', (e) => log('서버 오류: ' + (e && e.message ? e.message : e)));

function log(m) { console.log(`[${new Date().toTimeString().split(' ')[0]}] ${m}`); }

console.log('==================================================');
console.log(' 계남중 파일업다운 · 노트북 서버가 켜졌습니다');
console.log(` 포트: ${PORT}`);
console.log(' 앱의 [교사 설정]에 아래 IP 주소 중 학교 와이파이/학내망 주소를 입력하세요:');
const ifs = os.networkInterfaces();
Object.keys(ifs).forEach((name) => {
  (ifs[name] || []).filter(a => a.family === 'IPv4' && !a.internal).forEach(a => console.log(`   ${a.address}   (${name})`));
});
console.log(' 이 창을 닫으면 서버가 꺼집니다. 수업이 끝날 때까지 열어 두세요.');
console.log('==================================================');

process.on('uncaughtException', (e) => log('예외(계속 실행): ' + (e && e.message ? e.message : e)));
process.on('unhandledRejection', (e) => log('예외(계속 실행): ' + (e && e.message ? e.message : e)));

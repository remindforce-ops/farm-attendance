// 로컬 시험 서버: node dev/server.mjs  →  http://localhost:8765
// 메모리 안의 가짜 구글 시트에 예시 데이터를 넣고 gas/Code.gs를 그대로 실행한다.
// 여기의 계정과 비밀번호는 이 시험 서버 전용이며, 서버를 끄면 데이터는 사라진다.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGas } from './gas.mjs';

const PORT = 8765;
// 비밀번호는 코드에 적지 않고 서버를 켤 때마다 새로 만들어 터미널에 보여 준다.
const pw = () => crypto.randomUUID().slice(0, 12);
const DEV_ADMIN = { name: '대표', phone: '01000000000', pin: pw() };
const DEV_EMP_PIN = pw(); // 직원 전화번호는 01000000001 ~ 01000000010

const gas = loadGas();
const call = (fn, p) => {
  const r = gas.post(JSON.stringify({ fn, p }));
  if (!r.ok) throw new Error(r.error);
  return r.data;
};
seed();

function seed() {
  const token = call('setup', DEV_ADMIN).token;
  for (const name of ['1농장', '2농장', '3농장', '4농장']) call('farm_save', { token, name });
  const names = ['김민수', '이영희', '박철수', '최지은', '정대호', '응우옌 반 안', '쩐 티 흐엉', '소카 림', '한상우', '오미경'];
  const empPhone = n => `010000000${String(n).padStart(2, '0')}`;
  const ids = names.map((name, i) => {
    const type = ['월급', '월급', '일급', '시급'][i % 4];
    return call('emp_save', {
      token, name, phone: empPhone(i + 1), pin: DEV_EMP_PIN, type,
      base: { 월급: 2600000, 일급: 110000, 시급: 11000 }[type],
      rate_ot: 15000, rate_night: 16500, rate_hol: 15000,
      allow: [{ n: '식대', a: 100000 }, ...(i % 3 == 0 ? [{ n: '직책수당', a: 150000 }] : [])],
      mgmt: i >= 5 && i <= 7 ? 200000 : 0,
    }).id;
  });
  // 이번 달 1일부터 어제까지(일요일 제외) 08:00~17:00 근무 기록
  const today = call('me', { token }).today;
  const [y, m, dd] = today.split('-').map(Number);
  const dateOf = d => `${today.slice(0, 8)}${String(d).padStart(2, '0')}`;
  for (let d = 1; d < dd; d++) {
    if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() == 0) continue;
    ids.forEach((id, i) => {
      if ((d + i) % 11) gas.insert('punches', { user_id: id, farm_id: i % 4 + 1, date: dateOf(d), in: '08:00', out: '17:00' });
    });
  }
  const login = n => call('login', { phone: empPhone(n), pin: DEV_EMP_PIN }).token;
  call('request_create', { token: login(3), kind: 'ot', date: dateOf(Math.max(1, dd - 1)), hours: 3, reason: '모종 정식 마무리' });
  call('request_create', { token: login(6), kind: 'hol', date: dateOf(Math.max(1, dd - 1)), hours: 4, reason: '일요일 관수 작업' });
  call('request_create', { token: login(4), kind: 'leave', date: today, reason: '병원 진료' });
}

const root = fileURLToPath(new URL('../docs/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };
const send = (res, code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };

http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path == '/api' && req.method == 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    return send(res, 200, types['.json'], JSON.stringify(gas.post(body)));
  }
  if (path == '/config.js') return send(res, 200, types['.js'], `window.CONFIG={url:'/api'}`);
  const file = normalize(join(root, path == '/' ? 'index.html' : decodeURIComponent(path)));
  if (!file.startsWith(root)) return send(res, 403, 'text/plain', 'forbidden');
  try { send(res, 200, types[extname(file)] || 'application/octet-stream', await readFile(file)); }
  catch { send(res, 404, 'text/plain', 'not found'); }
}).listen(PORT, '127.0.0.1', () => console.log(`시험 서버: http://localhost:${PORT}\n대표 ${DEV_ADMIN.phone} / ${DEV_ADMIN.pin}\n직원 01000000001~10 / ${DEV_EMP_PIN}`));

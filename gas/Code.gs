/**
 * 농장 근태·급여 서버 (Google Apps Script)
 *
 * 구글 시트의 "확장 프로그램 > Apps Script"에 이 파일 전체를 붙여 넣고 "웹 앱"으로 배포합니다.
 * 데이터는 이 시트의 탭(직원, 농장, 출퇴근, 요청, 급여 등)에 저장됩니다. 탭은 처음 실행할 때 자동으로 만들어집니다.
 * 시트는 공유하지 마세요. 앱은 아래 doPost를 통해서만 데이터를 읽고 쓰며, 요청마다 로그인과 권한을 확인합니다.
 */
const TZ = 'Asia/Seoul';
const SESSION_DAYS = 90;
const HASH_ROUNDS = 1000;

// 탭 이름과 열(코드에서 쓰는 이름: 시트 머리글). 열 순서를 바꾸지 마세요.
const TABLES = {
  settings: ['설정', { key: '항목', value: '값' }],
  farms: ['농장', { id: '번호', name: '이름', lat: '위도', lng: '경도', rad: '허용반경' }],
  users: ['직원', { id: '번호', name: '이름', phone: '전화번호', role: '권한', active: '재직', type: '급여형태', base: '기본금액',
    rate_ot: '연장단가', rate_night: '야간단가', rate_hol: '휴일단가', allow: '고정수당', mgmt: '관리비',
    salt: '암호1', hash: '암호2', fails: '로그인실패', locked: '잠금해제' }],
  sessions: ['로그인', { token_hash: '토큰', user_id: '직원번호', expires: '만료' }],
  punches: ['출퇴근', { id: '번호', user_id: '직원번호', farm_id: '농장번호', date: '날짜', in: '출근', out: '퇴근' }],
  requests: ['요청', { id: '번호', user_id: '직원번호', kind: '종류', date: '날짜', hours: '시간', farm_id: '농장번호',
    in: '출근', out: '퇴근', reason: '사유', status: '상태', reject: '반려사유' }],
  payroll: ['급여', { ym: '월', user_id: '직원번호', inc: '인센티브', ins: '4대보험', tax: '소득세', mgmt: '관리비',
    sent: '발송일', viewed: '열람일', snap: '명세서' }],
};
const WORK = { ot: '연장근무', night: '야간근무', hol: '휴일근무' };
const KINDS = ['ot', 'night', 'hol', 'fix', 'leave'];

/* ============ 요청 처리 ============ */

class UserError extends Error {}
function fail(message) { throw new UserError(message); }

// 진단용: 어느 기능을 쓸 때 응답이 멈추는지 가려내기 위한 호출
function probe(s) {
  if (s.includes('L')) { const l = LockService.getScriptLock(); l.waitLock(20000); l.releaseLock(); }
  if (s.includes('C')) CacheService.getScriptCache().get('x');
  if (s.includes('S')) SpreadsheetApp.getActiveSpreadsheet().getSheetByName('설정');
  return ContentService.createTextOutput('pong');
}
function doGet(e) { return probe(String(e.parameter.ping || '')); }

function doPost(e) {
  if (e.postData.contents.startsWith('ping')) return probe(e.postData.contents);
  const lock = LockService.getScriptLock();
  let text;
  try {
    lock.waitLock(20000); // 동시에 들어온 요청은 한 번에 하나씩 처리
    const req = JSON.parse(e.postData.contents);
    // 응답이 중간에 끊기면 앱이 같은 요청 번호(rid)로 다시 보낸다. 두 번 처리하지 않고 처음 결과를 돌려준다.
    const cache = CacheService.getScriptCache(), key = req.rid ? 'rid-' + String(req.rid).slice(0, 64) : '';
    text = key && cache.get(key);
    if (!text) {
      // 시트를 매번 읽으면 느려서, 탭 내용을 캐시에 보관해 두고 쓴다(바뀐 탭은 요청 끝에 다시 보관).
      _cache = {}; _dirty = {};
      _stored = cache.getAll(Object.keys(TABLES).map(n => 'tbl-' + n));
      let out;
      try {
        // calls가 있으면 여러 요청을 순서대로 처리해 결과를 배열로 돌려준다(앱과 서버 사이 왕복을 줄이려고).
        out = { ok: true, data: req.calls ? req.calls.map(c => handle(c.fn, c.p)) : handle(req.fn, req.p) };
      } catch (err) { if (!(err instanceof UserError)) throw err; out = { ok: false, error: err.message }; }
      for (const name in _dirty) {
        // 시트에서 읽을 때와 같은 모양(모든 값이 글자)으로 보관한다.
        const keys = Object.keys(TABLES[name][1]);
        const list = _cache[name].map(o => { const r = { _row: o._row }; keys.forEach(k => r[k] = o[k] == null ? '' : String(o[k])); return r; });
        try { cache.put('tbl-' + name, JSON.stringify(list), 600); } catch (err) { cache.remove('tbl-' + name); } // 너무 크면 보관하지 않는다
      }
      text = JSON.stringify(out);
      if (key) try { cache.put(key, text, 300); } catch (err) {} // 너무 큰 응답은 저장되지 않는다(조회라서 다시 처리해도 된다)
    }
  } catch (err) {
    console.error(err);
    // 처리 도중 예기치 않게 멈췄으면 보관해 둔 탭 내용이 시트와 다를 수 있으므로 버린다.
    try { CacheService.getScriptCache().removeAll(Object.keys(TABLES).map(n => 'tbl-' + n)); } catch (e2) {}
    text = JSON.stringify({ ok: false, error: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

function handle(fn, p) {
  if (!Object.prototype.hasOwnProperty.call(API, fn)) fail('알 수 없는 요청입니다.');
  return API[fn](p || {});
}

/* ============ 시트 읽기/쓰기 ============ */
// 모든 값은 글자로 저장한다(전화번호 앞자리 0, 날짜, 시각이 시트에서 자동 변환되지 않도록).

// _cache: 이번 요청에서 읽은 탭, _dirty: 이번 요청에서 바뀐(또는 시트에서 새로 읽은) 탭, _stored: 캐시에 보관돼 있던 탭
let _cache = {}, _dirty = {}, _stored = {};

function sheetOf(name) {
  const title = TABLES[name][0];
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(title);
  if (!sh) {
    sh = ss.insertSheet(title);
    writeRow(sh, 1, Object.values(TABLES[name][1]));
    sh.setFrozenRows(1);
  }
  return sh;
}
// =, +, -, @ 로 시작하는 값이 수식으로 해석되지 않도록 작은따옴표를 붙인다.
function cell(v) {
  const s = v == null ? '' : String(v);
  return /^[=+\-@']/.test(s) ? "'" + s : s;
}
function writeRow(sh, row, values) {
  sh.getRange(row, 1, 1, values.length).setNumberFormat('@').setValues([values.map(cell)]);
}
function rows(name) {
  if (_cache[name]) return _cache[name];
  if (_stored['tbl-' + name]) return _cache[name] = JSON.parse(_stored['tbl-' + name]);
  _dirty[name] = true;
  const keys = Object.keys(TABLES[name][1]);
  const values = sheetOf(name).getDataRange().getDisplayValues();
  return _cache[name] = values.slice(1).map((v, i) => {
    const o = { _row: i + 2 };
    keys.forEach((k, j) => o[k] = v[j] || '');
    return o;
  });
}
function insert(name, obj) {
  const list = rows(name), keys = Object.keys(TABLES[name][1]);
  const o = { _row: list.length + 2 };
  keys.forEach(k => o[k] = obj[k] == null ? '' : String(obj[k]));
  if (keys[0] === 'id') o.id = String(list.reduce((m, r) => Math.max(m, +r.id), 0) + 1);
  writeRow(sheetOf(name), o._row, keys.map(k => o[k]));
  list.push(o);
  _dirty[name] = true;
  return o;
}
function save(name, o) {
  writeRow(sheetOf(name), o._row, Object.keys(TABLES[name][1]).map(k => o[k]));
  _dirty[name] = true;
}
function remove(name, pred) {
  const hit = rows(name).filter(pred);
  if (!hit.length) return;
  const sh = sheetOf(name);
  hit.map(r => r._row).sort((a, b) => b - a).forEach(r => sh.deleteRow(r));
  // 지운 줄 아래의 줄 번호가 당겨지므로 다시 매긴다.
  _cache[name] = rows(name).filter(r => !hit.includes(r));
  _cache[name].forEach((r, i) => r._row = i + 2);
  _dirty[name] = true;
}

/* ============ 공통 함수 ============ */

const text = v => String(v == null ? '' : v).trim();
const phone = v => String(v == null ? '' : v).replace(/\D/g, '');
const won = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '원';
const isInt = v => /^\d{1,9}$/.test(String(v));
const minutes = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

// 한국 시각 기준 오늘 날짜와 현재 시각
function kst() {
  const [date, time] = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm").split('T');
  return { date, time };
}
function sha(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}
function pinHash(pin, salt) {
  let h = salt + pin;
  for (let i = 0; i < HASH_ROUNDS; i++) h = sha(h + salt);
  return h;
}
function newPin(pin, role) {
  const min = role === 'admin' ? 8 : 6;
  if (String(pin == null ? '' : pin).length < min) fail(`비밀번호는 ${min}자 이상이어야 합니다.`);
  const salt = Utilities.getUuid();
  return { salt, hash: pinHash(String(pin), salt) };
}
function newSession(uid) {
  const token = Utilities.getUuid() + Utilities.getUuid();
  insert('sessions', { token_hash: sha(token), user_id: uid, expires: Date.now() + SESSION_DAYS * 86400000 });
  return token;
}
// 토큰으로 로그인 사용자를 확인. 실패하면 'AUTH' 오류(앱이 로그인 화면으로 돌아감).
function auth(p, needAdmin) {
  const hash = sha(String(p.token == null ? '' : p.token));
  const s = rows('sessions').find(x => x.token_hash === hash && +x.expires > Date.now());
  const u = s && rows('users').find(x => x.id == s.user_id && x.active === 'Y');
  if (!u) fail('AUTH');
  if (needAdmin && u.role !== 'admin') fail('관리자만 사용할 수 있습니다.');
  return u;
}
const userJson = u => ({ id: +u.id, name: u.name, role: u.role });
const farmName = id => { const f = rows('farms').find(x => x.id == id); return f ? f.name : null; };
const userName = id => { const u = rows('users').find(x => x.id == id); return u ? u.name : null; };
const reqJson = r => ({ id: +r.id, name: userName(r.user_id), kind: r.kind, date: r.date, hours: +r.hours || 0,
  farm: farmName(r.farm_id), in: r.in || null, out: r.out || null, reason: r.reason, status: r.status, reject: r.reject || null });
function checkYm(ym) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(ym))) fail('대상 월이 올바르지 않습니다.');
  return ym;
}
function payDay() {
  const s = rows('settings').find(x => x.key === 'pay_day');
  return s ? +s.value : 10;
}
const payRow = (ym, uid) => rows('payroll').find(r => r.ym === ym && r.user_id == uid);
function ensurePayRow(ym, uid) {
  return payRow(ym, uid) || insert('payroll', { ym, user_id: uid });
}
// 두 좌표 사이 거리(m)
function dist(a, b, c, d) {
  const R = Math.PI / 180;
  const x = Math.sin((c - a) * R / 2) ** 2 + Math.cos(a * R) * Math.cos(c * R) * Math.sin((d - b) * R / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(x));
}

/* ============ 근태 집계와 급여 계산 ============ */

// 정규 근무시간: 하루 출퇴근 합계가 4시간을 넘으면 휴게 1시간 제외, 하루 8시간 한도.
// 연장/야간/휴일은 승인된 요청 시간만 반영.
function stats(uid, ym) {
  const byDay = {};
  rows('punches').filter(x => x.user_id == uid && x.date.startsWith(ym) && x.out)
    .forEach(x => byDay[x.date] = (byDay[x.date] || 0) + Math.max(0, minutes(x.out) - minutes(x.in)));
  let reg = 0;
  for (const d in byDay) { const m = byDay[d]; reg += Math.min(480, m > 240 ? m - 60 : m); }
  const st = { days: Object.keys(byDay).length, reg: Math.round(reg / 6) / 10, ot: 0, night: 0, hol: 0, leave: 0 };
  rows('requests').filter(r => r.user_id == uid && r.date.startsWith(ym) && r.status === '승인').forEach(r => {
    if (WORK[r.kind]) st[r.kind] += +r.hours; else if (r.kind === 'leave') st.leave++;
  });
  return st;
}
// items/ded는 [항목, 금액, 계산 근거] 목록
function calc(u, ym) {
  const st = stats(u.id, ym), r = payRow(ym, u.id) || {}, base = +u.base || 0;
  const items = [
    u.type === '월급' ? ['기본급', base, '월 고정']
    : u.type === '일급' ? ['기본급', st.days * base, `${st.days}일 × ${won(base)}`]
    : ['기본급', Math.round(st.reg * base), `${st.reg}시간 × ${won(base)}`]];
  for (const k in WORK) {
    const rate = +u['rate_' + k] || 0;
    if (st[k] > 0) items.push([WORK[k] + '수당', Math.round(st[k] * rate), `${st[k]}시간 × ${won(rate)}`]);
  }
  JSON.parse(u.allow || '[]').forEach(a => { if (a.n && a.a > 0) items.push([a.n, a.a, '고정 수당']); });
  if (+r.inc > 0) items.push(['인센티브', +r.inc, '']);
  const mgmt = r.mgmt != null && r.mgmt !== '' ? +r.mgmt : +u.mgmt || 0;
  const ded = [['4대보험', +r.ins || 0], ['소득세', +r.tax || 0], ['관리비', mgmt]].filter(d => d[1] > 0);
  const sum = a => a.reduce((s, x) => s + x[1], 0);
  const [y, m] = ym.split('-').map(Number);
  const gross = sum(items), dsum = sum(ded);
  return { name: u.name, type: u.type, pay_date: new Date(Date.UTC(y, m, payDay())).toISOString().slice(0, 10),
    st, items, ded, gross, dsum, net: gross - dsum };
}
// 요청 승인. 승인된 출퇴근 정정은 해당 날짜 기록을 대체.
function approve(r) {
  if (r.status !== '대기') fail('이미 처리된 요청입니다.');
  r.status = '승인';
  save('requests', r);
  if (r.kind === 'fix') {
    remove('punches', x => x.user_id == r.user_id && x.date === r.date);
    insert('punches', { user_id: r.user_id, farm_id: r.farm_id, date: r.date, in: r.in, out: r.out });
  }
}

/* ============ 앱이 호출하는 기능 ============ */

const API = {
  // 최초 설정이 필요한지(관리자 계정이 아직 없는지)
  status() {
    return { setup: !rows('users').some(u => u.role === 'admin') };
  },

  // 최초 1회: 관리자 계정 만들기
  setup(p) {
    if (rows('users').some(u => u.role === 'admin')) fail('이미 설정이 끝났습니다.');
    const name = text(p.name), ph = phone(p.phone);
    if (!name || ph.length < 9) fail('이름과 전화번호를 입력해 주세요.');
    const u = insert('users', { name, phone: ph, role: 'admin', active: 'Y', type: '월급', ...newPin(p.pin, 'admin') });
    return { token: newSession(u.id), user: userJson(u) };
  },

  // 로그인. 5회 틀리면 15분 잠금.
  login(p) {
    const bad = '전화번호 또는 비밀번호가 맞지 않습니다.';
    const ph = phone(p.phone);
    const u = rows('users').find(x => x.phone === ph && x.active === 'Y');
    if (!u) fail(bad);
    if (+u.locked > Date.now()) fail('비밀번호를 여러 번 틀려 잠겼습니다. 15분 뒤에 다시 시도해 주세요.');
    if (pinHash(String(p.pin == null ? '' : p.pin), u.salt) !== u.hash) {
      const n = (+u.fails || 0) + 1;
      u.fails = n >= 5 ? 0 : n;
      u.locked = n >= 5 ? Date.now() + 15 * 60000 : '';
      save('users', u);
      fail(bad);
    }
    if (+u.fails || u.locked) { u.fails = 0; u.locked = ''; save('users', u); }
    remove('sessions', s => +s.expires < Date.now());
    return { token: newSession(u.id), user: userJson(u) };
  },

  logout(p) {
    const hash = sha(String(p.token == null ? '' : p.token));
    remove('sessions', s => s.token_hash === hash);
    return {};
  },

  change_pin(p) {
    const u = auth(p);
    if (pinHash(String(p.old == null ? '' : p.old), u.salt) !== u.hash) fail('현재 비밀번호가 맞지 않습니다.');
    Object.assign(u, newPin(p.new, u.role));
    save('users', u);
    const hash = sha(String(p.token));
    remove('sessions', s => s.user_id == u.id && s.token_hash !== hash);
    return {};
  },

  // 첫 화면 정보: 사용자, 농장 목록, 오늘 출퇴근, 알림 개수
  me(p) {
    const u = auth(p), today = kst().date;
    return {
      user: userJson(u), today,
      farms: rows('farms').map(f => ({ id: +f.id, name: f.name })),
      punches: rows('punches').filter(x => x.user_id == u.id && x.date === today)
        .map(x => ({ farm: farmName(x.farm_id), in: x.in, out: x.out || null })),
      unviewed: rows('payroll').filter(r => r.user_id == u.id && r.sent && !r.viewed).length,
      pending: u.role === 'admin' ? rows('requests').filter(r => r.status === '대기').length : 0,
    };
  },

  // QR 출퇴근. 위치가 등록된 농장은 허용 반경 안에서만 기록. 퇴근 QR은 출근한 농장의 것만 인정.
  scan(p) {
    const u = auth(p);
    if (u.role !== 'emp') fail('직원 계정으로 로그인해 주세요.');
    const f = rows('farms').find(x => x.id == p.farm);
    if (!f || (p.act !== 'in' && p.act !== 'out')) fail('등록되지 않은 QR 코드입니다.');
    if (f.lat !== '') {
      if (typeof p.lat !== 'number' || typeof p.lng !== 'number') {
        fail('위치를 확인할 수 없습니다. 휴대폰의 위치 권한을 허용한 뒤 다시 찍어 주세요.');
      }
      const m = Math.round(dist(p.lat, p.lng, +f.lat, +f.lng));
      if (m > +f.rad) fail(`${f.name}에서 약 ${m}m 떨어져 있습니다. 농장 안에서 찍어 주세요.`);
    }
    const { date, time } = kst();
    const open = rows('punches').filter(x => x.user_id == u.id && x.date === date && !x.out).pop();
    if (p.act === 'in') {
      if (open) fail(`이미 ${farmName(open.farm_id)}에 출근한 상태입니다. 먼저 퇴근 QR을 찍어 주세요.`);
      insert('punches', { user_id: u.id, farm_id: f.id, date, in: time });
      return { msg: `${f.name} 출근 ${time} 기록되었습니다.` };
    }
    if (!open) fail('출근 기록이 없습니다. 출근 QR을 먼저 찍어 주세요.');
    if (open.farm_id != f.id) {
      const name = farmName(open.farm_id);
      fail(`${name}에서 출근했습니다. ${name} 퇴근 QR을 찍어 주세요.`);
    }
    open.out = time;
    save('punches', open);
    return { msg: `${f.name} 퇴근 ${time} 기록되었습니다.` };
  },

  request_create(p) {
    const u = auth(p);
    if (u.role !== 'emp') fail('직원 계정으로 로그인해 주세요.');
    if (!KINDS.includes(p.kind)) fail('요청 종류가 올바르지 않습니다.');
    const reason = text(p.reason), r = { user_id: u.id, kind: p.kind, date: String(p.date), reason, status: '대기' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || isNaN(Date.parse(r.date)) || !reason) fail('날짜와 사유를 입력해 주세요.');
    if (WORK[p.kind]) {
      r.hours = Number(p.hours);
      if (!(r.hours > 0 && r.hours <= 24)) fail('시간을 입력해 주세요.');
    } else if (p.kind === 'fix') {
      const hm = /^([01]\d|2[0-3]):[0-5]\d$/;
      if (!hm.test(String(p.in)) || !hm.test(String(p.out)) || p.out <= p.in) fail('출퇴근 시각을 확인해 주세요.');
      const f = rows('farms').find(x => x.id == p.farm);
      if (!f) fail('농장을 선택해 주세요.');
      Object.assign(r, { farm_id: f.id, in: p.in, out: p.out });
    }
    insert('requests', r);
    return {};
  },

  my_requests(p) {
    const u = auth(p);
    return rows('requests').filter(r => r.user_id == u.id).slice(-50).reverse().map(reqJson);
  },

  // 월간 근태 상세. user를 주면 관리자만 다른 직원 조회 가능.
  month(p) {
    const u = auth(p), ym = checkYm(p.ym), uid = p.user == null ? u.id : p.user;
    if (uid != u.id && u.role !== 'admin') fail('관리자만 사용할 수 있습니다.');
    return {
      st: stats(uid, ym),
      days: rows('punches').filter(x => x.user_id == uid && x.date.startsWith(ym))
        .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
        .map(x => ({ date: x.date, farm: farmName(x.farm_id), in: x.in, out: x.out || null })),
    };
  },

  my_slips(p) {
    const u = auth(p);
    return rows('payroll').filter(r => r.user_id == u.id && r.sent)
      .sort((a, b) => b.ym.localeCompare(a.ym)).map(r => ({ ym: r.ym, viewed: r.viewed || null }));
  },

  // 명세서 열람(열람일 기록)
  my_slip(p) {
    const u = auth(p), r = payRow(String(p.ym), u.id);
    if (!r || !r.sent) fail('발송된 명세서가 없습니다.');
    if (!r.viewed) { r.viewed = kst().date; save('payroll', r); }
    return JSON.parse(r.snap);
  },

  /* ---------- 관리자 ---------- */

  dash(p) {
    auth(p, true);
    const today = kst().date, ps = rows('punches').filter(x => x.date === today);
    const names = list => list.map(x => userName(x.user_id));
    return {
      farms: rows('farms').map(f => ({ name: f.name,
        working: names(ps.filter(x => x.farm_id == f.id && !x.out)),
        left: names(ps.filter(x => x.farm_id == f.id && x.out)) })),
      absent: rows('users').filter(u => u.role === 'emp' && u.active === 'Y' && !ps.some(x => x.user_id == u.id)).map(u => u.name),
    };
  },

  requests(p) {
    auth(p, true);
    const all = rows('requests');
    return { pending: all.filter(r => r.status === '대기').map(reqJson),
      done: all.filter(r => r.status !== '대기').slice(-10).reverse().map(reqJson) };
  },

  decide(p) {
    auth(p, true);
    const r = rows('requests').find(x => x.id == p.id);
    if (!r || r.status !== '대기') fail('이미 처리된 요청입니다.');
    if (p.ok === true) approve(r);
    else { r.status = '반려'; r.reject = text(p.reject); save('requests', r); }
    return {};
  },

  approve_all(p) {
    auth(p, true);
    rows('requests').filter(r => r.status === '대기').forEach(approve);
    return {};
  },

  att(p) {
    auth(p, true);
    const ym = checkYm(p.ym);
    return rows('users').filter(u => u.role === 'emp' && u.active === 'Y').map(u => ({ id: +u.id, name: u.name, st: stats(u.id, ym) }));
  },

  // 급여 화면. 발송된 직원은 발송 시점에 고정된 금액(명세서)을 돌려줌.
  pay(p) {
    auth(p, true);
    const ym = checkYm(p.ym), out = [];
    rows('users').filter(u => u.role === 'emp').forEach(u => {
      const r = payRow(ym, u.id) || {};
      if (u.active !== 'Y' && !r.sent) return;
      out.push({ id: +u.id, name: u.name, type: u.type, inc: +r.inc || 0, ins: +r.ins || 0, tax: +r.tax || 0,
        mgmt: r.mgmt != null && r.mgmt !== '' ? +r.mgmt : +u.mgmt || 0,
        sent: r.sent || null, viewed: r.viewed || null, c: r.sent ? JSON.parse(r.snap) : calc(u, ym) });
    });
    return out;
  },

  pay_set(p) {
    auth(p, true);
    const ym = checkYm(p.ym);
    if (!['inc', 'ins', 'tax', 'mgmt'].includes(p.key) || !isInt(p.value)) fail('금액을 확인해 주세요.');
    const u = rows('users').find(x => x.id == p.user && x.role === 'emp');
    if (!u) fail('직원을 찾을 수 없습니다.');
    const r = ensurePayRow(ym, u.id);
    if (r.sent) fail('이미 발송된 명세서입니다. 발송 취소 후 수정해 주세요.');
    r[p.key] = String(p.value);
    save('payroll', r);
    return {};
  },

  // 명세서 발송. user가 없으면 아직 발송하지 않은 재직 직원 전체.
  pay_send(p) {
    auth(p, true);
    const ym = checkYm(p.ym), today = kst().date;
    let sent = 0;
    rows('users').filter(u => u.role === 'emp' && u.active === 'Y' && (p.user == null || u.id == p.user)).forEach(u => {
      const r = ensurePayRow(ym, u.id);
      if (r.sent) return;
      Object.assign(r, { snap: JSON.stringify(calc(u, ym)), sent: today, viewed: '' });
      save('payroll', r);
      sent++;
    });
    return { sent };
  },

  pay_unsend(p) {
    auth(p, true);
    const r = payRow(checkYm(p.ym), p.user);
    if (r) { Object.assign(r, { snap: '', sent: '', viewed: '' }); save('payroll', r); }
    return {};
  },

  config(p) {
    auth(p, true);
    return {
      pay_day: payDay(),
      farms: rows('farms').map(f => ({ id: +f.id, name: f.name, lat: f.lat === '' ? null : +f.lat, lng: f.lng === '' ? null : +f.lng, rad: +f.rad })),
      emps: rows('users').filter(u => u.role === 'emp').map(u => ({ id: +u.id, name: u.name, phone: u.phone, active: u.active === 'Y',
        type: u.type, base: +u.base || 0, rate_ot: +u.rate_ot || 0, rate_night: +u.rate_night || 0, rate_hol: +u.rate_hol || 0,
        allow: JSON.parse(u.allow || '[]'), mgmt: +u.mgmt || 0 })),
    };
  },

  // 농장 추가/수정. lat·lng가 없으면 위치 해제.
  farm_save(p) {
    auth(p, true);
    const name = text(p.name), hasLat = p.lat != null, hasLng = p.lng != null;
    if (!name) fail('농장 이름을 입력해 주세요.');
    if (hasLat !== hasLng || (hasLat && !(typeof p.lat === 'number' && typeof p.lng === 'number' && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180))) {
      fail('좌표를 "위도, 경도" 순서로 입력해 주세요. 예: 36.12345, 127.56789');
    }
    const data = { name, lat: hasLat ? p.lat : '', lng: hasLat ? p.lng : '', rad: Math.max(30, Math.round(+p.rad) || 200) };
    if (p.id == null) { insert('farms', data); return {}; }
    const f = rows('farms').find(x => x.id == p.id);
    if (!f) fail('농장을 찾을 수 없습니다.');
    Object.assign(f, data);
    save('farms', f);
    return {};
  },

  // 직원 추가/수정. pin은 새 직원이거나 비밀번호를 바꿀 때만 넣음.
  emp_save(p) {
    auth(p, true);
    const name = text(p.name), ph = phone(p.phone), pin = p.pin == null ? '' : String(p.pin), isNew = p.id == null;
    if (!name || ph.length < 9) fail('이름과 전화번호를 입력해 주세요.');
    if (!['월급', '일급', '시급'].includes(p.type)) fail('급여 형태를 선택해 주세요.');
    if (isNew && !pin) fail('새 직원의 비밀번호를 입력해 주세요.');
    const u = isNew ? null : rows('users').find(x => x.id == p.id && x.role === 'emp');
    if (!isNew && !u) fail('직원을 찾을 수 없습니다.');
    if (rows('users').some(x => x.phone === ph && x !== u)) fail('이미 등록된 전화번호입니다.');
    const amount = v => Math.max(0, Math.round(+v) || 0);
    const allow = (Array.isArray(p.allow) ? p.allow : []).slice(0, 3)
      .map(a => ({ n: text(a && a.n), a: amount(a && a.a) })).filter(a => a.n && a.a);
    const data = { name, phone: ph, role: 'emp', active: p.active === false ? 'N' : 'Y', type: p.type, base: amount(p.base),
      rate_ot: amount(p.rate_ot), rate_night: amount(p.rate_night), rate_hol: amount(p.rate_hol),
      allow: JSON.stringify(allow), mgmt: amount(p.mgmt) };
    if (pin) Object.assign(data, newPin(pin, 'emp'), { fails: 0, locked: '' });
    if (isNew) return { id: +insert('users', data).id };
    Object.assign(u, data);
    save('users', u);
    // 비밀번호를 바꾸거나 퇴사 처리하면 기존 로그인을 해제
    if (pin || data.active === 'N') remove('sessions', s => s.user_id == u.id);
    return { id: +u.id };
  },

  payday_set(p) {
    auth(p, true);
    const day = Math.min(28, Math.max(1, Math.round(+p.day) || 10));
    const s = rows('settings').find(x => x.key === 'pay_day');
    if (s) { s.value = day; save('settings', s); } else insert('settings', { key: 'pay_day', value: day });
    return {};
  },
};

// 서버 기능 시험: node dev/test.mjs
import assert from 'node:assert/strict';
import { loadGas } from './gas.mjs';

const gas = loadGas();
// 앱과 같은 방식으로 호출하고, 서버가 거부하면 오류로 던진다.
const call = async (fn, p = {}) => {
  const r = gas.post(JSON.stringify({ fn, p }));
  if (!r.ok) throw new Error(r.error);
  return r.data;
};
const fails = async (promise, re) => assert.rejects(promise, e => re.test(e.message) || assert.fail(`예상과 다른 오류: ${e.message}`));
const pw = () => crypto.randomUUID(); // 비밀번호는 코드에 적지 않고 실행할 때마다 새로 만든다
const ADMIN_PW = pw(), EMP_PW = pw(), NEW_PW = pw(), RESET_PW = pw();
const YM = '2026-10';

/* 최초 설정과 로그인 */
assert.equal((await call('status')).setup, true);
await fails(call('setup', { name: '대표', phone: '010-1000-0000', pin: 'short' }), /8자 이상/);
const admin = (await call('setup', { name: '대표', phone: '010-1000-0000', pin: ADMIN_PW })).token;
assert.equal((await call('status')).setup, false);
await fails(call('setup', { name: 'x', phone: '01099999999', pin: ADMIN_PW }), /이미 설정/);
await fails(call('login', { phone: '01010000000', pin: 'wrong' }), /맞지 않습니다/);
assert.ok((await call('login', { phone: '010 1000 0000', pin: ADMIN_PW })).token);
await fails(call('config', { token: 'nope' }), /^AUTH$/);
await fails(call('config', {}), /^AUTH$/);

/* 농장 */
await call('farm_save', { token: admin, name: '1농장', lat: 36.5, lng: 127.5, rad: 200 });
await call('farm_save', { token: admin, name: '2농장' });
await fails(call('farm_save', { token: admin, name: '3농장', lat: 36.5 }), /좌표/);
await fails(call('farm_save', { token: admin, name: '3농장', lat: 136.5, lng: 127 }), /좌표/);
let cfg = await call('config', { token: admin });
assert.deepEqual(cfg.farms.map(f => [f.name, f.lat, f.rad]), [['1농장', 36.5, 200], ['2농장', null, 200]]);
const [F1, F2] = cfg.farms.map(f => f.id);

/* 직원 */
const empBase = { token: admin, pin: EMP_PW, rate_ot: 15000, rate_night: 16500, rate_hol: 15000, allow: [{ n: '식대', a: 100000 }] };
const mon = (await call('emp_save', { ...empBase, name: '월급직원', phone: '010-2000-0001', type: '월급', base: 2600000 })).id;
const day = (await call('emp_save', { ...empBase, name: '일급직원', phone: '010-2000-0002', type: '일급', base: 110000, mgmt: 200000 })).id;
const hour = (await call('emp_save', { ...empBase, name: '시급직원', phone: '010-2000-0003', type: '시급', base: 11000 })).id;
await fails(call('emp_save', { ...empBase, name: '중복', phone: '01020000001', type: '월급' }), /이미 등록된 전화번호/);
await fails(call('emp_save', { ...empBase, pin: '123', name: '짧은비번', phone: '01020000009', type: '월급' }), /6자 이상/);
await fails(call('emp_save', { ...empBase, pin: '', name: '비번없음', phone: '01020000009', type: '월급' }), /비밀번호를 입력/);
const tDay = (await call('login', { phone: '01020000002', pin: EMP_PW })).token;
const tHour = (await call('login', { phone: '01020000003', pin: EMP_PW })).token;
await fails(call('config', { token: tDay }), /관리자만/);
await fails(call('pay', { token: tDay, ym: YM }), /관리자만/);
await fails(call('month', { token: tDay, ym: YM, user: mon }), /관리자만/);
await fails(call('scan', { token: admin, act: 'in', farm: F2 }), /직원 계정/);

/* QR 출퇴근 + 위치 확인 */
await fails(call('scan', { token: tDay, act: 'in', farm: 999 }), /등록되지 않은 QR/);
await fails(call('scan', { token: tDay, act: 'x', farm: F1 }), /등록되지 않은 QR/);
await fails(call('scan', { token: tDay, act: 'in', farm: F1 }), /위치를 확인할 수 없습니다/);
await fails(call('scan', { token: tDay, act: 'in', farm: F1, lat: 36.51, lng: 127.5 }), /1농장에서 약 1112m/);
await fails(call('scan', { token: tDay, act: 'out', farm: F1, lat: 36.5, lng: 127.5 }), /출근 기록이 없습니다/);
assert.match((await call('scan', { token: tDay, act: 'in', farm: F1, lat: 36.5, lng: 127.5015 })).msg, /1농장 출근 \d\d:\d\d 기록/);
await fails(call('scan', { token: tDay, act: 'in', farm: F2 }), /이미 1농장에 출근한 상태/);
await fails(call('scan', { token: tDay, act: 'out', farm: F2 }), /1농장에서 출근했습니다. 1농장 퇴근 QR/);
assert.match((await call('scan', { token: tDay, act: 'out', farm: F1, lat: 36.5, lng: 127.5 })).msg, /1농장 퇴근/);
assert.match((await call('scan', { token: tDay, act: 'in', farm: F2 })).msg, /2농장 출근/); // 위치 미등록 농장은 QR만으로
let me = await call('me', { token: tDay });
assert.equal(me.punches.length, 2);
assert.equal(me.punches[1].out, null);
let dash = await call('dash', { token: admin });
assert.deepEqual(dash.farms[1].working, ['일급직원']);
assert.deepEqual(dash.absent, ['월급직원', '시급직원']);

/* 근태 집계와 급여 계산 (지난 달 고정 데이터) */
for (const uid of [mon, day, hour]) {
  for (let d = 1; d <= 10; d++) gas.insert('punches', { user_id: uid, farm_id: F1, date: `${YM}-${String(d).padStart(2, '0')}`, in: '08:00', out: '17:00' });
  gas.insert('punches', { user_id: uid, farm_id: F1, date: `${YM}-11`, in: '08:00', out: '12:00' }); // 4시간: 휴게 제외 없음
  gas.insert('punches', { user_id: uid, farm_id: F1, date: `${YM}-12`, in: '08:00', out: '19:00' }); // 8시간 한도
  gas.insert('punches', { user_id: uid, farm_id: F1, date: `${YM}-13`, in: '08:00' }); // 퇴근 누락: 미집계
}
assert.deepEqual((await call('month', { token: tHour, ym: YM })).st, { days: 12, reg: 92, ot: 0, night: 0, hol: 0, leave: 0 });

const req = (kind, date, extra) => call('request_create', { token: tDay, kind, date: `${YM}-${date}`, reason: '시험', ...extra });
await fails(req('ot', '05', { hours: 0 }), /시간을 입력/);
await fails(req('ot', '05', { hours: 2, reason: ' ' }), /날짜와 사유/);
await fails(req('fix', '20', { farm: F1, in: '15:00', out: '09:00' }), /출퇴근 시각/);
await fails(req('bad', '05'), /요청 종류/);
await fails(call('request_create', { token: admin, kind: 'leave', date: `${YM}-05`, reason: 'x' }), /직원 계정/);
await req('ot', '05', { hours: 2.5, reason: '=1+1' }); // 수식처럼 보이는 글자도 그대로 저장
await req('night', '06', { hours: 2 });
await req('hol', '07', { hours: 3 });
await req('leave', '21');
await req('fix', '20', { farm: F1, in: '09:00', out: '15:00' }); // 새 근무일 5시간
await req('fix', '13', { farm: F2, in: '08:00', out: '17:00' }); // 퇴근 누락 정정 8시간
let inbox = await call('requests', { token: admin });
assert.equal(inbox.pending.length, 6);
assert.equal((await call('me', { token: admin })).pending, 6);
await fails(call('decide', { token: tDay, id: inbox.pending[0].id, ok: true }), /관리자만/);
await call('decide', { token: admin, id: inbox.pending[0].id, ok: true });
await call('decide', { token: admin, id: inbox.pending[1].id, ok: false, reject: '사전 협의 없음' });
await fails(call('decide', { token: admin, id: inbox.pending[1].id, ok: true }), /이미 처리된/);
await call('approve_all', { token: admin });
inbox = await call('requests', { token: admin });
assert.equal(inbox.pending.length, 0);
const mine = await call('my_requests', { token: tDay });
assert.deepEqual(mine.map(r => r.status), ['승인', '승인', '승인', '승인', '반려', '승인']);
assert.equal(mine[4].reject, '사전 협의 없음');
assert.equal(mine[5].reason, '=1+1');
await fails(call('nope', {}), /알 수 없는 요청/);
await fails(call('constructor', {}), /알 수 없는 요청/);
assert.equal(gas.post('not json').error, '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
assert.equal(gas.sheets['직원'].cells[1][2], '01010000000'); // 전화번호 앞자리 0 유지
assert.deepEqual((await call('month', { token: admin, ym: YM, user: day })).st, { days: 14, reg: 105, ot: 2.5, night: 0, hol: 3, leave: 1 });
assert.equal((await call('att', { token: admin, ym: YM })).length, 3);

await call('pay_set', { token: admin, ym: YM, user: day, key: 'ins', value: 50000 });
await call('pay_set', { token: admin, ym: YM, user: day, key: 'tax', value: 10000 });
await call('pay_set', { token: admin, ym: YM, user: mon, key: 'inc', value: 300000 });
await fails(call('pay_set', { token: admin, ym: YM, user: day, key: 'base', value: 1 }), /금액/);
await fails(call('pay_set', { token: admin, ym: YM, user: day, key: 'inc', value: -5 }), /금액/);
await fails(call('pay', { token: admin, ym: '2026-13' }), /대상 월/);
let pay = await call('pay', { token: admin, ym: YM });
const by = id => pay.find(r => r.id === id).c;
assert.deepEqual(by(day).items, [
  ['기본급', 1540000, '14일 × 110,000원'],
  ['연장근무수당', 37500, '2.5시간 × 15,000원'],
  ['휴일근무수당', 45000, '3시간 × 15,000원'],
  ['식대', 100000, '고정 수당']]);
assert.deepEqual(by(day).ded, [['4대보험', 50000], ['소득세', 10000], ['관리비', 200000]]);
assert.deepEqual([by(day).gross, by(day).dsum, by(day).net], [1722500, 260000, 1462500]);
assert.equal(by(day).pay_date, '2026-11-10');
assert.deepEqual(by(hour).items[0], ['기본급', 1012000, '92시간 × 11,000원']);
assert.deepEqual([by(mon).gross, by(mon).net], [3000000, 3000000]);

/* 명세서 발송과 열람 */
assert.equal((await call('pay_send', { token: admin, ym: YM, user: day })).sent, 1);
assert.equal((await call('pay_send', { token: admin, ym: YM })).sent, 2);
await fails(call('pay_set', { token: admin, ym: YM, user: day, key: 'inc', value: 1 }), /이미 발송/);
await call('emp_save', { ...empBase, pin: '', id: day, name: '일급직원', phone: '01020000002', type: '일급', base: 999999 });
pay = await call('pay', { token: admin, ym: YM });
assert.equal(by(day).net, 1462500); // 발송 후에는 금액 고정
assert.equal((await call('me', { token: tDay })).unviewed, 1);
assert.deepEqual(await call('my_slips', { token: tDay }), [{ ym: YM, viewed: null }]);
await fails(call('my_slip', { token: tDay, ym: '2026-09' }), /발송된 명세서가 없습니다/);
assert.equal((await call('my_slip', { token: tDay, ym: YM })).net, 1462500);
assert.equal((await call('me', { token: tDay })).unviewed, 0);
assert.ok(pay.find(r => r.id === day).sent);
await call('pay_unsend', { token: admin, ym: YM, user: day });
assert.deepEqual(await call('my_slips', { token: tDay }), []);
await call('payday_set', { token: admin, day: 25 });
pay = await call('pay', { token: admin, ym: YM });
assert.equal(by(day).pay_date, '2026-11-25');
assert.equal(by(hour).pay_date, '2026-11-10'); // 이미 발송된 명세서는 그대로

/* 비밀번호 변경, 잠금, 퇴사 처리, 로그아웃 */
await fails(call('change_pin', { token: tHour, old: 'wrong', new: NEW_PW }), /현재 비밀번호/);
await call('change_pin', { token: tHour, old: EMP_PW, new: NEW_PW });
assert.ok((await call('login', { phone: '01020000003', pin: NEW_PW })).token);
for (let i = 0; i < 5; i++) await fails(call('login', { phone: '01020000003', pin: 'wrong' }), /맞지 않습니다/);
await fails(call('login', { phone: '01020000003', pin: NEW_PW }), /잠겼습니다/);
await call('emp_save', { ...empBase, pin: RESET_PW, id: hour, name: '시급직원', phone: '01020000003', type: '시급', base: 11000 });
await fails(call('me', { token: tHour }), /^AUTH$/); // 비밀번호 재설정 시 기존 로그인 해제
assert.ok((await call('login', { phone: '01020000003', pin: RESET_PW })).token);
await call('emp_save', { ...empBase, pin: '', id: day, name: '일급직원', phone: '01020000002', type: '일급', base: 110000, active: false });
await fails(call('me', { token: tDay }), /^AUTH$/);
await fails(call('login', { phone: '01020000002', pin: EMP_PW }), /맞지 않습니다/);
await call('logout', { token: admin });
await fails(call('me', { token: admin }), /^AUTH$/);

/* 같은 요청 번호(rid)로 다시 보내면 두 번 처리하지 않고 처음 결과를 돌려준다 */
const again = JSON.stringify({ fn: 'login', rid: crypto.randomUUID(), p: { phone: '01020000003', pin: RESET_PW } });
assert.equal(gas.post(again).data.token, gas.post(again).data.token);
assert.notEqual((await call('login', { phone: '01020000003', pin: RESET_PW })).token, gas.post(again).data.token);

/* 여러 요청을 한 번에: 결과는 배열, 하나라도 거부되면 전체가 오류 */
const many = gas.post(JSON.stringify({ calls: [{ fn: 'status', p: {} }, { fn: 'status', p: {} }] }));
assert.deepEqual(many, { ok: true, data: [{ setup: false }, { setup: false }] });
assert.equal(gas.post(JSON.stringify({ calls: [{ fn: 'status', p: {} }, { fn: 'me', p: {} }] })).error, 'AUTH');

console.log('모든 시험 통과');

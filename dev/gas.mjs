// 로컬 시험용: 구글 시트/Apps Script 기능을 메모리에서 흉내 내어 gas/Code.gs를 그대로 실행한다.
// 실제 구글 서비스의 동작(속도, 권한, 셀 변환)까지 똑같지는 않으므로 실제 시트에서의 확인은 따로 필요하다.
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';

class Sheet {
  cells = [];
  getDataRange() {
    return { getDisplayValues: () => {
      const width = Math.max(1, ...this.cells.map(r => r.length));
      return this.cells.map(r => Array.from({ length: width }, (_, i) => r[i] ?? ''));
    } };
  }
  getRange(row, col) {
    const range = {
      setNumberFormat: () => range,
      setValues: values => {
        values.forEach((vals, i) => {
          const r = this.cells[row - 1 + i] ??= [];
          vals.forEach((v, j) => {
            if (typeof v !== 'string') throw new Error('글자가 아닌 값을 쓰려 함: ' + v);
            if (/^[=+]/.test(v)) throw new Error('수식으로 해석될 값: ' + v);
            r[col - 1 + j] = v.startsWith("'") ? v.slice(1) : v; // 시트는 맨 앞 작은따옴표를 글자 표시로 처리
          });
        });
        return range;
      },
    };
    return range;
  }
  deleteRow(n) { this.cells.splice(n - 1, 1); }
  setFrozenRows() {}
}

export function loadGas() {
  const sheets = {};
  const ss = { getSheetByName: n => sheets[n] ?? null, insertSheet: n => sheets[n] = new Sheet() };
  const ctx = vm.createContext({
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ text, setMimeType() { return this; } }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, s) => [...createHash(alg).update(s, 'utf8').digest()].map(b => b > 127 ? b - 256 : b),
      getUuid: () => randomUUID(),
      // Code.gs가 쓰는 형식("yyyy-MM-dd'T'HH:mm")만 지원
      formatDate: (date, timeZone) => new Intl.DateTimeFormat('sv-SE', { timeZone, dateStyle: 'short', timeStyle: 'short' }).format(date).replace(' ', 'T'),
    },
  });
  vm.runInContext(readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8'), ctx, { filename: 'Code.gs' });
  return {
    sheets,
    // 앱과 같은 경로(doPost)로 호출
    post: body => JSON.parse(ctx.doPost({ postData: { contents: body } }).text),
    insert: (table, row) => vm.runInContext('_cache={};insert', ctx)(table, row),
  };
}

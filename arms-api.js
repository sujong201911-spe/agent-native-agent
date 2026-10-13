'use strict';
// arms-api.js — 무기·탄약 관리(정보화장비계). 대시보드의 '무기·탄약' 영역이 쓰는 API.
//   GET  /api/arms          전체 상태 + 계산값(탄약 재고·무기 현황·경보)
//   GET  /api/arms/export   백업(JSON 파일)
//   POST /api/arms {action, ...}
//     save · remove           등록 정보(무기·탄약·무기고·부서·인원) 등록/수정/삭제
//     issue · return          무기 대여(불출)·반납(회수) — 탄약 지급·회수 수량을 함께 기록
//     ammoTx                  탄약 수불(입고·사용·폐기·조정)
//     inspect · repairDone    점검 기록, 수리 의뢰·완료
//     training                사격·훈련 기록 → 소모 탄약을 수불에 자동 반영
//     role                    인원의 시스템 권한
//
// 데이터는 워크스페이스마다 하나: 그 워크스페이스의 state.json 옆 arms.json(기본 워크스페이스는 data/arms.json).
// 이력(history)은 지우지 않고 쌓는다 — 감사·검열 때 누가 언제 무엇을 했는지 그대로 남는다.
// 권한: 인원(people)에 email과 role을 두면, 앞단 신원 헤더의 사용자가 그 역할로 동작한다.
//   단일 사용자 모드(신원 헤더 없음)이거나 아직 관리자가 한 명도 없으면 관리자로 본다(처음 설정용).

const crypto = require('node:crypto');

const ROLES = { admin: 3, officer: 2, duty: 1, staff: 0 };   // 관리자 · 담당자 · 당직자 · 일반
const WEAPON_STATUS = ['stored', 'loaned', 'repair', 'disposed'];
const TX_KINDS = { in: 1, issue: -1, return: 1, train: -1, use: -1, dispose: -1, adjust: 0 };   // 부호: 재고에 더하는지 빼는지(adjust는 입력 부호 그대로)

// 등록 정보 스키마 — 필드: [이름, 최대 길이, 필수 여부]
const SCHEMA = {
  weapons: [['type', 40, true], ['model', 60, false], ['serial', 60, true], ['armoryId', 40, true], ['deptId', 40, false], ['acquiredAt', 10, false], ['note', 300, false]],
  ammo: [['type', 40, true], ['caliber', 40, false], ['lot', 60, false], ['expires', 10, false], ['unit', 10, false], ['min', 10, false], ['armoryId', 40, false], ['note', 300, false]],
  armories: [['name', 60, true], ['kind', 20, false], ['location', 120, false], ['note', 300, false]],
  depts: [['name', 60, true], ['note', 300, false]],
  people: [['name', 40, true], ['rank', 20, false], ['deptId', 40, false], ['email', 120, false], ['carrier', 5, false], ['note', 300, false]],
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function createArmsApi({ fileOf, writeJsonAtomic, readJsonStrict, sendJson, actor, audit, idHeader }) {
  const empty = () => ({ version: 1, weapons: [], ammo: [], armories: [], depts: [], people: [], loans: [], tx: [], inspections: [], access: [], trainings: [], history: [] });
  function load() {
    const s = readJsonStrict(fileOf(), empty);
    const base = empty();
    if (!s || typeof s !== 'object' || Array.isArray(s)) return base;
    for (const k of Object.keys(base)) if (k !== 'version' && !Array.isArray(s[k])) s[k] = [];
    if (typeof s.version !== 'number') s.version = 1;
    return s;
  }
  const newId = (p) => p + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  const now = () => new Date().toISOString();
  const str = (v, max) => (v === null || v === undefined || typeof v === 'object' ? '' : String(v).trim().slice(0, max));
  const int = (v) => { const n = Number(v); return Number.isInteger(n) ? n : NaN; };

  function stockOf(s, ammoId) { return s.tx.filter((t) => t.ammoId === ammoId).reduce((a, t) => a + t.qty, 0); }
  function roleOf(s, req) {
    const me = actor(req);
    if (!idHeader || me === 'ana') return 'admin';
    if (!s.people.some((p) => p.role === 'admin')) return 'admin';
    const p = s.people.find((x) => x.email && x.email.toLowerCase() === me);
    return (p && p.role) || 'staff';
  }
  const nameOf = (list, id) => ((list.find((x) => x.id === id) || {}).name || '');

  // 화면에 바로 쓸 계산값 — 탄약 재고, 상태별 무기 수, 경보
  function summarize(s) {
    const today = now().slice(0, 10);
    const in30 = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    const stock = Object.fromEntries(s.ammo.map((a) => [a.id, stockOf(s, a.id)]));
    const weaponCount = Object.fromEntries(WEAPON_STATUS.map((st) => [st, s.weapons.filter((w) => w.status === st).length]));
    const alerts = [];
    for (const l of s.loans) if (l.status === 'open' && l.dueAt && l.dueAt < now()) {
      const w = s.weapons.find((x) => x.id === l.weaponId) || {};
      alerts.push({ level: 'risk', kind: 'overdue', text: `미반납: ${w.type || ''} ${w.serial || ''} — ${l.person} (반납 예정 ${l.dueAt.slice(0, 16).replace('T', ' ')})` });
    }
    for (const a of s.ammo) {
      const label = `${a.type}${a.caliber ? ' ' + a.caliber : ''}${a.lot ? ' (' + a.lot + ')' : ''}`;
      if (a.expires && a.expires < today && stock[a.id] > 0) alerts.push({ level: 'risk', kind: 'expired', text: `유효기간 지남: ${label} ${stock[a.id]}${a.unit || '발'}` });
      else if (a.expires && a.expires <= in30 && stock[a.id] > 0) alerts.push({ level: 'warn', kind: 'expiring', text: `유효기간 30일 이내: ${label} (${a.expires})` });
      if (a.min && stock[a.id] < Number(a.min)) alerts.push({ level: 'warn', kind: 'low', text: `재고 부족: ${label} ${stock[a.id]} / 최소 ${a.min}` });
    }
    for (const r of s.armories) {
      const last = s.inspections.filter((i) => i.armoryId === r.id && i.kind === 'daily').map((i) => i.at).sort().pop();
      if (!last || last.slice(0, 10) < today) alerts.push({ level: 'warn', kind: 'inspect', text: `오늘 일일 점검 안 함: ${r.name}` });
    }
    for (const w of s.weapons) if (w.status === 'repair') alerts.push({ level: 'info', kind: 'repair', text: `수리 중: ${w.type} ${w.serial}` });
    return { stock, weaponCount, alerts, openLoans: s.loans.filter((l) => l.status === 'open').length };
  }

  function log(s, req, action, text) {
    s.history.push({ at: now(), by: actor(req), action, text });
    if (s.history.length > 20000) s.history.splice(0, s.history.length - 20000);
    audit(actor(req), `arms.${action}`, text.slice(0, 80));
  }

  // 각 동작: 오류면 [status, 메시지], 성공이면 null. 성공한 동작만 저장한다.
  const ACTIONS = {
    save(s, b, req) {
      const fields = SCHEMA[b.col]; if (!fields) return [400, '알 수 없는 항목 종류'];
      if (ROLES[roleOf(s, req)] < ROLES.officer) return [403, '무기·탄약·무기고·부서·인원 등록은 담당자 이상만 할 수 있습니다'];
      const src = b.rec && typeof b.rec === 'object' ? b.rec : {};
      const rec = {};
      for (const [k, max, req2] of fields) {
        rec[k] = k === 'carrier' ? !!src[k] : str(src[k], max);
        if (req2 && !rec[k]) return [400, `${k} 값이 필요합니다`];
      }
      for (const k of ['acquiredAt', 'expires']) if (rec[k] && !DATE_RE.test(rec[k])) return [400, `${k}는 YYYY-MM-DD 형식이어야 합니다`];
      if (rec.min && !(int(rec.min) >= 0)) return [400, '최소 재고는 0 이상의 정수여야 합니다'];
      if (b.col === 'weapons' && !s.armories.some((r) => r.id === rec.armoryId)) return [400, '보관 무기고를 고르세요'];
      const list = s[b.col];
      const cur = b.rec && b.rec.id ? list.find((x) => x.id === b.rec.id) : null;
      if (b.col === 'weapons' && list.some((w) => w.serial === rec.serial && (!cur || w.id !== cur.id))) return [409, `무기번호 ${rec.serial}이(가) 이미 있습니다`];
      if (cur) Object.assign(cur, rec, { updatedAt: now() });
      else list.push({ id: newId(b.col[0]), ...rec, ...(b.col === 'weapons' ? { status: 'stored' } : {}), ...(b.col === 'people' ? { role: 'staff' } : {}), at: now() });
      // 무기 불용 처리는 save로: 보관 중일 때만
      if (b.col === 'weapons' && cur && src.status === 'disposed') {
        if (cur.status !== 'stored') return [409, '보관 중인 무기만 불용 처리할 수 있습니다'];
        cur.status = 'disposed';
      }
      log(s, req, `${b.col}.${cur ? 'update' : 'add'}`, `${rec.name || rec.type || ''} ${rec.serial || rec.lot || ''}`.trim());
      return null;
    },
    remove(s, b, req) {
      if (!SCHEMA[b.col]) return [400, '알 수 없는 항목 종류'];
      if (ROLES[roleOf(s, req)] < ROLES.admin) return [403, '삭제는 관리자만 할 수 있습니다'];
      const rec = s[b.col].find((x) => x.id === b.id); if (!rec) return [404, '찾을 수 없습니다'];
      const used = { weapons: () => s.loans.some((l) => l.weaponId === rec.id), ammo: () => s.tx.some((t) => t.ammoId === rec.id),
        armories: () => s.weapons.some((w) => w.armoryId === rec.id) || s.access.some((a) => a.armoryId === rec.id),
        depts: () => s.weapons.some((w) => w.deptId === rec.id) || s.people.some((p) => p.deptId === rec.id), people: () => false }[b.col]();
      if (used) return [409, '기록이 남아 있어 삭제할 수 없습니다 — 무기는 불용 처리하세요'];
      s[b.col] = s[b.col].filter((x) => x.id !== b.id);
      log(s, req, `${b.col}.remove`, `${rec.name || rec.type || ''} ${rec.serial || rec.lot || ''}`.trim());
      return null;
    },
    issue(s, b, req) {
      if (ROLES[roleOf(s, req)] < ROLES.duty) return [403, '대여는 당직자 이상만 처리할 수 있습니다'];
      const w = s.weapons.find((x) => x.id === b.weaponId); if (!w) return [404, '무기를 찾을 수 없습니다'];
      if (w.status !== 'stored') return [409, `보관 중인 무기가 아닙니다 (${w.serial})`];
      const person = str(b.person, 40); if (!person) return [400, '수령자를 입력하세요'];
      const p = s.people.find((x) => x.name === person);
      if (p && !p.carrier) return [409, `${person}은(는) 무기 휴대 허가 대상이 아닙니다`];
      const dueAt = str(b.dueAt, 25);
      if (dueAt && Number.isNaN(Date.parse(dueAt))) return [400, '반납 예정 시각이 올바르지 않습니다'];
      const qty = b.ammoId ? int(b.ammoQty) : 0;
      if (b.ammoId) {
        if (!s.ammo.some((a) => a.id === b.ammoId)) return [404, '탄약을 찾을 수 없습니다'];
        if (!(qty > 0)) return [400, '지급 탄약 수량은 1 이상이어야 합니다'];
        if (qty > stockOf(s, b.ammoId)) return [409, `탄약 재고가 부족합니다 (재고 ${stockOf(s, b.ammoId)})`];
      }
      const loan = { id: newId('l'), weaponId: w.id, person, purpose: str(b.purpose, 120), ammoId: b.ammoId || '', ammoQty: qty, issuedBy: actor(req),
        witness: str(b.witness, 40), outAt: now(), dueAt: dueAt ? new Date(dueAt).toISOString() : '', status: 'open' };
      s.loans.push(loan); w.status = 'loaned';
      if (qty) s.tx.push({ id: newId('t'), ammoId: b.ammoId, kind: 'issue', qty: -qty, ref: loan.id, note: `${w.serial} ${person}`, by: actor(req), at: now() });
      log(s, req, 'issue', `${w.type} ${w.serial} → ${person}${qty ? ` · 탄약 ${qty}` : ''}`);
      return null;
    },
    return(s, b, req) {
      if (ROLES[roleOf(s, req)] < ROLES.duty) return [403, '반납은 당직자 이상만 처리할 수 있습니다'];
      const l = s.loans.find((x) => x.id === b.loanId); if (!l || l.status !== 'open') return [404, '대여 중인 기록이 아닙니다'];
      const back = l.ammoQty ? int(b.ammoReturned) : 0;
      if (l.ammoQty && !(back >= 0 && back <= l.ammoQty)) return [400, `회수 탄약은 0~${l.ammoQty} 사이여야 합니다`];
      const usedNote = str(b.usedNote, 300);
      if (back < l.ammoQty && !usedNote) return [400, `탄약 ${l.ammoQty - back}발이 모자랍니다 — 사용 사유를 적어 주세요`];
      const w = s.weapons.find((x) => x.id === l.weaponId);
      Object.assign(l, { status: 'returned', returnedAt: now(), ammoReturned: back, usedNote, receivedBy: actor(req), condition: str(b.condition, 120) });
      if (w) w.status = b.repair ? 'repair' : 'stored';
      if (back) s.tx.push({ id: newId('t'), ammoId: l.ammoId, kind: 'return', qty: back, ref: l.id, note: `${(w || {}).serial || ''} ${l.person}`, by: actor(req), at: now() });
      if (l.ammoQty - back > 0) l.usedQty = l.ammoQty - back;   // 지급할 때 이미 재고에서 뺐으므로 수불은 그대로, 사용 수량·사유만 남긴다
      log(s, req, 'return', `${(w || {}).type || ''} ${(w || {}).serial || ''} ← ${l.person}${l.usedQty ? ` · 사용 ${l.usedQty}발(${usedNote})` : ''}`);
      return null;
    },
    ammoTx(s, b, req) {
      if (ROLES[roleOf(s, req)] < ROLES.officer) return [403, '탄약 수불은 담당자 이상만 기록할 수 있습니다'];
      const a = s.ammo.find((x) => x.id === b.ammoId); if (!a) return [404, '탄약을 찾을 수 없습니다'];
      if (!['in', 'use', 'dispose', 'adjust'].includes(b.kind)) return [400, '구분은 입고·사용·폐기·조정 중 하나여야 합니다'];
      const n = int(b.qty); if (!Number.isInteger(n) || n === 0 || (b.kind !== 'adjust' && n < 0)) return [400, '수량이 올바르지 않습니다'];
      const qty = b.kind === 'adjust' ? n : n * TX_KINDS[b.kind];
      if (stockOf(s, a.id) + qty < 0) return [409, `재고보다 많이 뺄 수 없습니다 (재고 ${stockOf(s, a.id)})`];
      const note = str(b.note, 300);
      if (b.kind !== 'in' && !note) return [400, '사유를 적어 주세요'];
      s.tx.push({ id: newId('t'), ammoId: a.id, kind: b.kind, qty, shells: b.shells === undefined || b.shells === '' ? null : int(b.shells), note, by: actor(req), at: now() });
      log(s, req, `ammo.${b.kind}`, `${a.type} ${a.lot || ''} ${qty > 0 ? '+' : ''}${qty}`);
      return null;
    },
    inspect(s, b, req) {
      if (ROLES[roleOf(s, req)] < ROLES.duty) return [403, '점검은 당직자 이상만 기록할 수 있습니다'];
      if (!['daily', 'weekly', 'regular', 'special'].includes(b.kind)) return [400, '점검 구분이 올바르지 않습니다'];
      if (!s.armories.some((r) => r.id === b.armoryId)) return [400, '무기고를 고르세요'];
      const w = b.weaponId ? s.weapons.find((x) => x.id === b.weaponId) : null;
      if (b.weaponId && !w) return [404, '무기를 찾을 수 없습니다'];
      const result = b.result === 'issue' ? 'issue' : 'ok';
      const checks = (Array.isArray(b.checks) ? b.checks : []).map((c) => str(c, 40)).filter(Boolean).slice(0, 20);
      const note = str(b.note, 500);
      if (result === 'issue' && !note) return [400, '이상 내용을 적어 주세요'];
      if (b.repair && (!w || w.status !== 'stored')) return [409, '보관 중인 무기만 수리 의뢰할 수 있습니다'];
      s.inspections.push({ id: newId('i'), kind: b.kind, armoryId: b.armoryId, weaponId: w ? w.id : '', result, checks, note, repair: !!b.repair, by: actor(req), at: now() });
      if (b.repair) w.status = 'repair';
      log(s, req, `inspect.${b.kind}`, `${nameOf(s.armories, b.armoryId)} ${result === 'ok' ? '이상 없음' : '이상: ' + note}${b.repair ? ` · 수리 의뢰 ${w.serial}` : ''}`);
      return null;
    },
    repairDone(s, b, req) {
      if (ROLES[roleOf(s, req)] < ROLES.officer) return [403, '수리 완료는 담당자 이상만 처리할 수 있습니다'];
      const w = s.weapons.find((x) => x.id === b.weaponId); if (!w || w.status !== 'repair') return [409, '수리 중인 무기가 아닙니다'];
      w.status = 'stored';
      s.inspections.push({ id: newId('i'), kind: 'repair', armoryId: w.armoryId, weaponId: w.id, result: 'ok', checks: [], note: str(b.note, 500) || '수리 완료', repair: false, by: actor(req), at: now() });
      log(s, req, 'repair.done', `${w.type} ${w.serial}`);
      return null;
    },
    training(s, b, req) {
      if (ROLES[roleOf(s, req)] < ROLES.officer) return [403, '훈련 기록은 담당자 이상만 남길 수 있습니다'];
      const title = str(b.title, 100), date = str(b.date, 10);
      if (!title || !DATE_RE.test(date)) return [400, '훈련명과 날짜(YYYY-MM-DD)를 입력하세요'];
      const parts = (Array.isArray(b.participants) ? b.participants : []).map((x) => ({ person: str(x && x.person, 40), score: str(x && x.score, 10), shots: int(x && x.shots) || 0 }))
        .filter((x) => x.person).slice(0, 200);
      if (!parts.length) return [400, '참가자를 한 명 이상 입력하세요'];
      if (parts.some((x) => x.shots < 0)) return [400, '사용 탄약 수는 0 이상이어야 합니다'];
      const total = parts.reduce((a, x) => a + x.shots, 0);
      const a = b.ammoId ? s.ammo.find((x) => x.id === b.ammoId) : null;
      if (total && !a) return [400, '사용한 탄약 종류를 고르세요'];
      if (total > (a ? stockOf(s, a.id) : 0)) return [409, `탄약 재고가 부족합니다 (재고 ${a ? stockOf(s, a.id) : 0})`];
      const shells = b.shells === undefined || b.shells === '' ? null : int(b.shells);
      const t = { id: newId('r'), title, date, place: str(b.place, 60), ammoId: a ? a.id : '', total, shells, participants: parts, by: actor(req), at: now() };
      s.trainings.push(t);
      if (total) s.tx.push({ id: newId('t'), ammoId: a.id, kind: 'train', qty: -total, shells, ref: t.id, note: `${date} ${title}`, by: actor(req), at: now() });
      log(s, req, 'training', `${date} ${title} · ${parts.length}명 · 탄약 ${total}`);
      return null;
    },
    role(s, b, req) {
      if (roleOf(s, req) !== 'admin') return [403, '권한은 관리자만 바꿀 수 있습니다'];
      const p = s.people.find((x) => x.id === b.personId); if (!p) return [404, '인원을 찾을 수 없습니다'];
      if (!Object.hasOwn(ROLES, b.role)) return [400, '권한은 admin·officer·duty·staff 중 하나여야 합니다'];
      if (p.role === 'admin' && b.role !== 'admin' && s.people.filter((x) => x.role === 'admin').length === 1 && idHeader) return [409, '마지막 관리자는 바꿀 수 없습니다'];
      p.role = b.role;
      log(s, req, 'role', `${p.name} → ${b.role}`);
      return null;
    },
  };

  return async function armsRoutes(req, res, url, ctx) {
    const p = url.pathname;
    if (p === '/api/arms' && req.method === 'GET') {
      const s = load();
      return sendJson(res, 200, { ...s, history: s.history.slice(-300).reverse(), summary: summarize(s), myRole: roleOf(s, req) }), true;
    }
    if (p === '/api/arms/export' && req.method === 'GET') {
      if (ROLES[roleOf(load(), req)] < ROLES.admin) return sendJson(res, 403, { error: '백업은 관리자만 받을 수 있습니다' }), true;
      const stamp = now().slice(0, 10);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="arms-backup-${stamp}.json"`, 'cache-control': 'no-store' });
      return res.end(JSON.stringify(load(), null, 2)), true;
    }
    if (p === '/api/arms' && req.method === 'POST') {
      if (!ctx.csrfOk(req)) return sendJson(res, 403, { error: 'forbidden (origin/content-type)' }), true;
      const b = await ctx.jsonBody(req, res); if (!b) return true;
      const fn = Object.hasOwn(ACTIONS, b.action) ? ACTIONS[b.action] : null;
      if (!fn) return sendJson(res, 400, { error: `action은 ${Object.keys(ACTIONS).join('|')} 중 하나여야 합니다` }), true;
      const s = load();
      const err = fn(s, b, req);
      if (err) return sendJson(res, err[0], { error: err[1] }), true;
      s.version++; writeJsonAtomic(fileOf(), s);
      ctx.broadcast({ kind: 'arms', version: s.version });
      return sendJson(res, 200, { ok: true, version: s.version }), true;
    }
    return false;
  };
}

module.exports = { createArmsApi, ROLES, SCHEMA };

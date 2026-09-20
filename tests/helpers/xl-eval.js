// 同僚用テンプレートxlsxの式を評価する、ごく小さな計算機(テスト用)。
//   テンプレートが使う関数だけに対応: IF・OR・UPPER・TRIM・SUBSTITUTE・ROUND・MIN と、比較(=・>=)・四則・セル参照($B$3・C11・C$9)・文字列・数値。
//   本物の Excel ではないので、Excel との細かな違い(空白セルの扱いなど)は、この範囲の式でだけ合わせている。
//   使い方: const ev = makeEvaluator(ws); ev('C11') → そのセルの値(式なら計算した値)。ws は { 'C11': { v, f, t }, ... }
function makeEvaluator(ws) {
    const memo = {};
    function cell(addr) {
        addr = addr.replace(/\$/g, '');
        if (addr in memo) return memo[addr];
        const c = ws[addr];
        let v;
        if (!c) v = '';
        else if (c.f) v = evalFormula(c.f);
        else v = (c.v === undefined || c.v === null) ? '' : c.v;
        memo[addr] = v;
        return v;
    }
    function evalFormula(src) {
        let i = 0;
        const peek = () => src[i];
        function ws_() { while (i < src.length && src[i] === ' ') i++; }
        function num(v) { if (typeof v === 'number') return v; if (v === '' || v === undefined) return 0; const n = Number(v); if (isNaN(n)) throw new Error('#VALUE! ' + JSON.stringify(v)); return n; }
        function parseComparison() {
            let l = parseAdditive(); ws_();
            const two = src.substr(i, 2);
            if (two === '>=' || two === '<=' || two === '<>') { i += 2; const r = parseAdditive(); return two === '>=' ? cmp(l, r) >= 0 : two === '<=' ? cmp(l, r) <= 0 : !eq(l, r); }
            if (peek() === '=') { i++; const r = parseAdditive(); return eq(l, r); }
            if (peek() === '>') { i++; const r = parseAdditive(); return cmp(l, r) > 0; }
            if (peek() === '<') { i++; const r = parseAdditive(); return cmp(l, r) < 0; }
            return l;
        }
        function eq(a, b) { if (typeof a === 'string' && typeof b === 'string') return a.toUpperCase() === b.toUpperCase(); return a === b; }
        function cmp(a, b) { if (typeof a === 'number' && typeof b === 'number') return a - b; if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0; return typeof a === 'string' ? 1 : -1; } // Excel: 文字列は数値より大きい
        function parseAdditive() {
            let l = parseTerm();
            for (;;) { ws_(); const c = peek(); if (c === '+') { i++; l = num(l) + num(parseTerm()); } else if (c === '-') { i++; l = num(l) - num(parseTerm()); } else return l; }
        }
        function parseTerm() {
            let l = parseUnary();
            for (;;) { ws_(); const c = peek(); if (c === '*') { i++; l = num(l) * num(parseUnary()); } else if (c === '/') { i++; const d = num(parseUnary()); if (d === 0) throw new Error('#DIV/0!'); l = num(l) / d; } else return l; }
        }
        function parseUnary() { ws_(); if (peek() === '-') { i++; return -num(parsePrimary()); } return parsePrimary(); }
        function parsePrimary() {
            ws_();
            const c = peek();
            if (c === '(') { i++; const v = parseComparison(); ws_(); i++; return v; }
            if (c === '"') { let s = ''; i++; for (;;) { if (src[i] === '"') { if (src[i + 1] === '"') { s += '"'; i += 2; continue; } i++; break; } s += src[i++]; } return s; }
            let m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i));
            if (m) { i += m[0].length; return Number(m[0]); }
            m = /^([A-Z][A-Z0-9]*)\(/.exec(src.slice(i));
            if (m) {
                const name = m[1]; i += m[0].length;
                const args = [];
                ws_();
                if (peek() === ')') i++;
                else { for (;;) { args.push(parseLazy(name, args.length)); ws_(); if (peek() === ',') { i++; continue; } i++; break; } }
                return callFn(name, args);
            }
            m = /^\$?[A-Z]{1,3}\$?[0-9]+/.exec(src.slice(i));
            if (m) { i += m[0].length; return cell(m[0]); }
            throw new Error('parse error at ' + i + ': ' + src.slice(i, i + 20));
        }
        // IF は選ばれない側を評価しない(空白セルの計算エラーを避ける。Excel と同じ)
        function parseLazy(name, idx) {
            if (name !== 'IF' || idx === 0) return parseComparison();
            const start = i; skip(); return { lazyFrom: start, lazyTo: i };
        }
        function skip() { let depth = 0; for (; i < src.length; i++) { const c = src[i]; if (c === '"') { i++; while (i < src.length && !(src[i] === '"' && src[i + 1] !== '"')) { if (src[i] === '"') i++; i++; } continue; } if (c === '(') depth++; else if (c === ')') { if (depth === 0) return; depth--; } else if (c === ',' && depth === 0) return; } }
        function evalRange(r) { const saved = i; i = r.lazyFrom; const v = parseComparison(); i = saved; return v; }
        function callFn(name, a) {
            switch (name) {
                case 'IF': { const cond = a[0]; const pick = cond ? a[1] : a[2]; return (pick && typeof pick === 'object' && 'lazyFrom' in pick) ? evalRange(pick) : (pick === undefined ? false : pick); }
                case 'OR': return a.some(x => x === true || (typeof x === 'number' && x !== 0));
                case 'UPPER': return String(a[0]).toUpperCase();
                case 'TRIM': return String(a[0]).replace(/^ +| +$/g, '').replace(/ +/g, ' ');
                case 'SUBSTITUTE': return String(a[0]).split(String(a[1])).join(String(a[2]));
                case 'ROUND': { const n = num(a[0]), d = num(a[1]), f = Math.pow(10, d); return (n < 0 ? -1 : 1) * Math.round(Math.abs(n) * f + 1e-9) / f; }
                case 'MIN': return Math.min.apply(null, a.map(num));
                default: throw new Error('未対応の関数: ' + name);
            }
        }
        const v = parseComparison();
        return v;
    }
    return cell;
}
module.exports = { makeEvaluator };

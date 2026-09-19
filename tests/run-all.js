#!/usr/bin/env node
// tests/ 直下のテストをすべて順番に実行し、ファイルごとの結果と合計を表示する(全体実行の標準手順)。
//
// 対象: tests/ 直下の *.js をすべて(名前規則に頼らない)。helpers/ と node_modules/ は対象外。run-all.js 自身は除く。
//       → *.test.js 以外(test_grades.js・attendance-snapshot.js)も漏れなく実行される。
// 前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと。
// 実行: cd tests && node run-all.js [--only=名前の一部,…] [--list] [--write-readme] [--no-readme-check]
//   --only          ファイル名にその文字列を含むものだけ実行(READMEとの照合は行わない)
//   --list          実行せず、対象ファイルの一覧だけ表示する
//   --write-readme  結果の表を README.md の目印(run-all:table)の間へ書き込む
//   --no-readme-check  READMEの表との照合を省く
// 終了コード: 0=全ファイルが成功(終了コード0・失敗0)かつREADMEの表と一致 / 1=それ以外
//
// 各ファイルの検査数は、出力の集計行から読み取る(形式は複数ある。読み取れないファイルは「?」と警告し、失敗として扱う)。
// テストは並列に走らせない(一時ファイル名の衝突・負荷による不安定さを避けるため)。

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const DIR = __dirname;
const README = path.join(DIR, 'README.md');
const MARK_START = '<!-- run-all:table:start -->';
const MARK_END = '<!-- run-all:table:end -->';
const args = process.argv.slice(2);
const opt = (name) => { const a = args.find(x => x === name || x.indexOf(name + '=') === 0); return a === undefined ? null : (a.indexOf('=') === -1 ? true : a.slice(a.indexOf('=') + 1)); };

function discover() {
    return fs.readdirSync(DIR, { withFileTypes: true })
        .filter(d => d.isFile() && /\.js$/.test(d.name) && d.name !== 'run-all.js')
        .map(d => d.name).sort();
}

// 出力から { pass, fail, how } を読み取る。読み取れなければ null。
function parseCounts(out) {
    let m;
    const last = (re) => { const all = out.match(new RegExp(re.source, 'g')); return all ? all[all.length - 1].match(re) : null; };
    if ((m = last(/=== [^\n:]+: (\d+) passed \/ (\d+) failed ===/))) return { pass: +m[1], fail: +m[2], how: 'passed/failed' };
    if ((m = last(/結果: PASS (\d+) \/ FAIL (\d+)/))) return { pass: +m[1], fail: +m[2], how: '結果: PASS/FAIL' };
    if ((m = last(/合計: (\d+)件 \/ 成功: (\d+)件 \/ 失敗: (\d+)件/))) return { pass: +m[2], fail: +m[3], how: '合計/成功/失敗' };
    if ((m = last(/=== 結果: (\d+)\/(\d+) PASS ===/))) return { pass: +m[1], fail: +m[2] - +m[1], how: '結果: n/m PASS' };
    if ((m = last(/pass: (\d+) \/ fail: (\d+)/))) return { pass: +m[1], fail: +m[2], how: 'pass:/fail:' };
    // 集計行が無いもの: PASS/FAIL・ok/NG で始まる行を数える
    const lines = out.split('\n');
    const p = lines.filter(l => /^\s*(PASS|ok)\b/.test(l)).length, f = lines.filter(l => /^\s*(FAIL|NG)\b/.test(l)).length;
    if (p + f > 0) return { pass: p, fail: f, how: '行を数える' };
    return null;
}

function checkServer() {
    return new Promise((resolve) => {
        const req = http.get('http://localhost:8123/index.html', (res) => { res.resume(); resolve(res.statusCode === 200); });
        req.on('error', () => resolve(false));
        req.setTimeout(3000, () => { req.destroy(); resolve(false); });
    });
}

function readmeRows() {
    const txt = fs.readFileSync(README, 'utf8');
    const a = txt.indexOf(MARK_START), b = txt.indexOf(MARK_END);
    if (a === -1 || b === -1) return null;
    const rows = {};
    txt.slice(a, b).split('\n').forEach(l => { const m = l.match(/^\| `([^`]+)` \| (\d+) \| (\d+) \|/); if (m) rows[m[1]] = { pass: +m[2], fail: +m[3] }; });
    return rows;
}

function tableText(results) {
    const lines = ['| ファイル | 検査数(PASS) | FAIL |', '|---|---|---|'];
    let p = 0, f = 0;
    results.forEach(r => { lines.push('| `' + r.file + '` | ' + r.pass + ' | ' + r.fail + ' |'); p += r.pass; f += r.fail; });
    lines.push('| **合計（' + results.length + 'ファイル）** | **' + p + '** | **' + f + '** |');
    return lines.join('\n');
}

(async () => {
    const all = discover();
    const only = opt('--only');
    const files = only ? all.filter(f => String(only).split(',').some(s => f.indexOf(s) !== -1)) : all;
    const odd = all.filter(f => !/\.test\.js$/.test(f));
    if (opt('--list')) {
        files.forEach(f => console.log(f));
        console.log('\n' + files.length + 'ファイル（*.test.js 以外: ' + (odd.join(', ') || 'なし') + '）');
        return;
    }
    if (!(await checkServer())) { console.error('http://localhost:8123/index.html に接続できません。リポジトリのルートで `python3 -m http.server 8123` を起動してください。'); process.exit(1); }
    console.log('対象 ' + files.length + ' ファイル（*.test.js 以外も含む: ' + (odd.join(', ') || 'なし') + '）\n');
    const results = [];
    for (const file of files) {
        const t0 = Date.now();
        const r = spawnSync('node', [file], { cwd: DIR, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 15 * 60 * 1000 });
        const out = (r.stdout || '') + (r.stderr || '');
        const c = parseCounts(out);
        const exit = r.status === null ? (r.signal || 'timeout') : r.status;
        const ok = exit === 0 && !!c && c.fail === 0 && c.pass > 0;
        const rec = { file, exit, pass: c ? c.pass : 0, fail: c ? c.fail : 0, parsed: !!c, how: c ? c.how : '-', ok, sec: Math.round((Date.now() - t0) / 1000) };
        results.push(rec);
        console.log((ok ? 'ok   ' : 'NG   ') + file.padEnd(46) + ' PASS ' + String(c ? c.pass : '?').padStart(4) + ' / FAIL ' + String(c ? c.fail : '?').padStart(3) + '  exit=' + exit + '  ' + rec.sec + 's' + (c ? '' : '  ← 検査数を読み取れません') + (exit !== 0 || (c && c.fail) ? '' : ''));
        if (!ok) {
            const bad = out.split('\n').filter(l => /^\s*(FAIL|NG)\b/.test(l)).slice(0, 6);
            bad.forEach(l => console.log('       ' + l.slice(0, 200)));
            if (!bad.length) console.log('       ' + out.trim().split('\n').slice(-3).join('\n       ').slice(0, 400));
        }
    }
    const pass = results.reduce((a, r) => a + r.pass, 0), fail = results.reduce((a, r) => a + r.fail, 0), ng = results.filter(r => !r.ok);
    console.log('\n合計: ' + results.length + 'ファイル / PASS ' + pass + ' / FAIL ' + fail + ' / 失敗したファイル ' + ng.length);
    let readmeOk = true;
    if (opt('--write-readme') && !only) {
        const txt = fs.readFileSync(README, 'utf8');
        const a = txt.indexOf(MARK_START), b = txt.indexOf(MARK_END);
        if (a === -1 || b === -1) { console.error('README.md に ' + MARK_START + ' と ' + MARK_END + ' がありません。'); process.exit(1); }
        fs.writeFileSync(README, txt.slice(0, a + MARK_START.length) + '\n' + tableText(results) + '\n' + txt.slice(b));
        console.log('README.md の表を更新しました。');
    } else if (!only && !opt('--no-readme-check')) {
        const rows = readmeRows();
        if (!rows) { console.log('README.md に表の目印(' + MARK_START + ')がありません。`--write-readme` で作成してください。'); readmeOk = false; }
        else {
            const miss = results.filter(r => !rows[r.file]).map(r => r.file);
            const extra = Object.keys(rows).filter(f => !results.some(r => r.file === f));
            const diff = results.filter(r => rows[r.file] && (rows[r.file].pass !== r.pass || rows[r.file].fail !== r.fail)).map(r => r.file + ' (README ' + rows[r.file].pass + '/' + rows[r.file].fail + ' → 実測 ' + r.pass + '/' + r.fail + ')');
            if (miss.length || extra.length || diff.length) {
                readmeOk = false;
                console.log('README.md の表と一致しません（`node run-all.js --write-readme` で更新）:');
                if (miss.length) console.log('  表に無いファイル: ' + miss.join(', '));
                if (extra.length) console.log('  表にあるが存在しない: ' + extra.join(', '));
                diff.forEach(d => console.log('  件数の違い: ' + d));
            } else console.log('README.md の表と一致しています。');
        }
    }
    process.exit(ng.length === 0 && readmeOk ? 0 : 1);
})();

// person.test.js — 対応バージョン: v1.14.0 ／ 全34項目 ／ 提出ボタン統合版
// 対応バージョン: v1.14.0 ／ 全34項目 ／ 提出ボタン統合版（○提出と⏰遅れて提出は1ボタンに統合済み）
//
// 実行手順（リポジトリのルールに準拠）
//   1) リポジトリ直下で: python3 -m http.server 8123
//   2) cd tests
//   3) node person.test.js
//
// 確認すること
//   ① サブナビに「入力（個人）」が出て、タブが切り替わる
//   ② バッジ＝未提出＋お直し＋未届（「まだ集計していない課題」は数えない）
//   ③ 児童を選ぶとセクションが出る
//   ④ 欠席日の課題に「その日欠席」タグが出る（出席簿を都度参照）
//   ⑤ 誰も記録がない課題は「まだ集計していない課題」に隔離される
//   ⑥ 並べ替え（日付 新しい順／古い順／教科順）が効く
//   ⑦ 提出ボタンが1つで、その日の出欠から遅れ扱いを自動判定する
//   ⑧ 提出済みの行から遅れフラグを付け外しできる
//   ⑨ 届出ボタンで spa_attendance_notice が更新される（他児童の届出を壊さない）
//   ⑩ 入力タブへ往復してもデータが壊れない（自動保存との競合がない）

const puppeteer = require('puppeteer-core');

const URL = 'http://localhost:8123/index.html';
const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '\n       ' + detail : '')); }
}

// --- テストデータ ---------------------------------------------------------
// 課題 104 はわざと「誰も記録がない」状態にして、未集計の隔離を確かめる。
// あおい(0) は 7/10 に病欠。課題 101 は 7/10 なので「欠席由来の未提出」になる。
const SEED = {
  spa_master: JSON.stringify({
    classInfo: { grade: 5, className: '1', termSystem: 3 },
    students: [{ name: 'あおい' }, { name: 'かえで' }, { name: 'さくら' }]
  }),
  spa_submissions_assignments: JSON.stringify([
    { id: 101, subject: '国語', name: '漢字ドリル⑤', date: '2026-07-10', createdAt: '2026-07-10T00:00:00.000Z' },
    { id: 102, subject: '算数', name: '計算プリント', date: '2026-07-08', createdAt: '2026-07-08T00:00:00.000Z' },
    { id: 103, subject: '社会', name: '新聞づくり',   date: '2026-07-05', createdAt: '2026-07-05T00:00:00.000Z' },
    { id: 104, subject: '理科', name: '観察カード',   date: '2026-07-29', createdAt: '2026-07-29T00:00:00.000Z' }
  ]),
  spa_submissions_data: JSON.stringify([
    { id: 1, studentIndex: 0, assignmentId: 102, status: 'submitted', correctionDone: true,  lateOnDue: false, createdAt: '2026-07-08T01:00:00.000Z' },
    { id: 2, studentIndex: 1, assignmentId: 103, status: 'resubmit',  correctionDone: false, lateOnDue: false, createdAt: '2026-07-05T01:00:00.000Z' },
    { id: 3, studentIndex: 2, assignmentId: 101, status: 'submitted', correctionDone: true,  lateOnDue: false, createdAt: '2026-07-10T01:00:00.000Z' },
    { id: 4, studentIndex: 2, assignmentId: 103, status: 'submitted', correctionDone: true,  lateOnDue: false, createdAt: '2026-07-05T02:00:00.000Z' }
  ]),
  spa_attendance: JSON.stringify({
    '2026-07-10': { '0': '×', '1': '○', '2': '○' },  // あおい病欠 → 未届1件 + 課題101が欠席由来
    '2026-07-03': { '1': 'チ' }                        // かえで遅刻（届出あり）
  }),
  spa_attendance_notice: JSON.stringify({ '2026-07-03': { '1': true } })
};

// 期待するバッジ（＝未提出＋お直し＋未届。104は未集計なので含めない）
//   あおい(0): 未提出 101,103 = 2 / 未届 7/10 = 1        → 3
//   かえで(1): 未提出 101,102 = 2 / お直し 103 = 1 / 未届0 → 3
//   さくら(2): 未提出 102 = 1                             → 1

// --- ページ内ヘルパー -----------------------------------------------------
const H = {
  badges: () => Array.from(document.querySelectorAll('#subPsnGrid .sub-psn-stu'))
    .map(b => (b.querySelector('.sub-psn-badge') || {}).textContent),
  sectionTitles: () => Array.from(document.querySelectorAll('#subPsnDetail .sub-psn-sec'))
    .map(s => s.querySelector('.sub-psn-sec-hd').textContent.replace(/\s+/g, ' ').trim()),
  missingCount: () => {
    const sec = document.querySelector('#subPsnDetail .sub-psn-sec');
    return sec ? sec.querySelector('.sub-psn-sec-cnt').textContent : '';
  },
  missingNames: () => {
    const sec = document.querySelector('#subPsnDetail .sub-psn-sec');
    if (!sec) return [];
    return Array.from(sec.querySelectorAll('.sub-psn-name')).map(e => e.textContent);
  },
  // 未提出セクションで「その日欠席」タグが付いている課題名
  absentTagged: () => {
    const sec = document.querySelector('#subPsnDetail .sub-psn-sec');
    if (!sec) return [];
    return Array.from(sec.querySelectorAll('.sub-psn-row'))
      .filter(r => r.querySelector('.sub-psn-tag.absent'))
      .map(r => r.querySelector('.sub-psn-name').textContent);
  },
  // 未集計セクションの課題名
  untouchedNames: () => {
    const sec = Array.from(document.querySelectorAll('#subPsnDetail .sub-psn-sec'))
      .find(s => s.querySelector('.sub-psn-sec-hd').textContent.indexOf('まだ集計していない') >= 0);
    if (!sec) return null;
    return Array.from(sec.querySelectorAll('.sub-psn-name')).map(e => e.textContent);
  }
};

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1180, height: 900 }); // iPad Air 横向き相当
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });

  try {
    await page.goto(URL, { waitUntil: 'networkidle2' });
    await page.evaluate(seed => {
      localStorage.clear();
      Object.keys(seed).forEach(k => localStorage.setItem(k, seed[k]));
    }, SEED);
    await page.goto(URL, { waitUntil: 'networkidle2' });
    await page.waitForSelector('#nav-submissions');

    // ── ① タブ ──────────────────────────────────────────
    console.log('\n① タブの存在と切り替え');
    await page.click('#nav-submissions');
    await page.waitForSelector('#view-submissions', { visible: true });
    check('サブナビに「入力（個人）」がある',
      !!(await page.$('#view-submissions .sub-subnav-btn[data-sub="person"]')));

    // サブナビが横スクロールできる（ボタンが潰れない）
    const navScroll = await page.evaluate(() =>
      getComputedStyle(document.querySelector('#view-submissions .sub-subnav')).overflowX);
    check('サブナビが overflow-x:auto', navScroll === 'auto' || navScroll === 'scroll', 'got ' + navScroll);

    await page.click('#view-submissions .sub-subnav-btn[data-sub="person"]');
    await page.waitForSelector('#sub-sub-person.active');
    await page.waitForSelector('#subPsnGrid .sub-psn-stu');
    check('タブが切り替わり児童グリッドが描画される', true);

    // ── ② バッジ ────────────────────────────────────────
    console.log('\n② バッジ（未集計を数えない）');
    const badges = await page.evaluate(H.badges);
    check('あおい = 3', badges[0] === '3', 'got ' + badges[0]);
    check('かえで = 3', badges[1] === '3', 'got ' + badges[1]);
    check('さくら = 1（104は未集計なので加算しない）', badges[2] === '1', 'got ' + badges[2]);

    // ── ③ セクション ────────────────────────────────────
    console.log('\n③ 児童選択とセクション表示');
    await page.click('#subPsnGrid .sub-psn-stu[data-idx="0"]');
    await page.waitForSelector('#subPsnDetail .sub-psn-sec');
    check('未提出セクションが2件', /2件/.test(await page.evaluate(H.missingCount)));
    const titles = await page.evaluate(H.sectionTitles);
    check('未届セクションがある', titles.some(t => t.indexOf('未提出の届出') >= 0), JSON.stringify(titles));
    const names = await page.evaluate(H.missingNames);
    check('未提出は漢字ドリル⑤と新聞づくり（日付降順）',
      names.join(',') === '漢字ドリル⑤,新聞づくり', 'got ' + names.join(','));

    // ── ④ 欠席由来の未提出 ──────────────────────────────
    console.log('\n④「その日欠席」タグ（出席簿を都度参照）');
    const tagged = await page.evaluate(H.absentTagged);
    check('7/10病欠の漢字ドリル⑤にタグが付く',
      tagged.join(',') === '漢字ドリル⑤', 'got ' + tagged.join(','));
    const savedAbsent = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('spa_submissions_data') || '[]')
        .some(r => r.studentIndex === 0 && r.assignmentId === 101));
    check('表示のためにデータを書き足していない（レコードは作らない）', savedAbsent === false);

    // ── ⑤ 未集計の隔離 ──────────────────────────────────
    console.log('\n⑤「まだ集計していない課題」の隔離');
    const untouched = await page.evaluate(H.untouchedNames);
    check('104が未集計セクションに入る',
      untouched && untouched.join(',') === '観察カード', 'got ' + JSON.stringify(untouched));
    check('未提出セクションには入らない',
      !(await page.evaluate(H.missingNames)).includes('観察カード'));

    // ── ⑥ 並べ替え ──────────────────────────────────────
    console.log('\n⑥ 並べ替え');
    // あおいの未提出: 101 国語 7/10 ／ 103 社会 7/5
    await page.select('#subPsnSortSel', 'date_asc');
    await page.waitForFunction(() => {
      const s = document.querySelector('#subPsnDetail .sub-psn-sec');
      const n = s && s.querySelectorAll('.sub-psn-name');
      return n && n.length === 2 && n[0].textContent === '新聞づくり';
    });
    check('日付（古い順）で並びが反転する',
      (await page.evaluate(H.missingNames)).join(',') === '新聞づくり,漢字ドリル⑤');

    await page.select('#subPsnSortSel', 'subject');
    await page.waitForFunction(() => {
      const s = document.querySelector('#subPsnDetail .sub-psn-sec');
      const n = s && s.querySelectorAll('.sub-psn-name');
      return n && n.length === 2 && n[0].textContent === '漢字ドリル⑤';
    });
    check('教科順（国語→社会）で並ぶ',
      (await page.evaluate(H.missingNames)).join(',') === '漢字ドリル⑤,新聞づくり');

    await page.select('#subPsnSortSel', 'date_desc');
    await page.waitForFunction(() => {
      const s = document.querySelector('#subPsnDetail .sub-psn-sec');
      const n = s && s.querySelectorAll('.sub-psn-name');
      return n && n.length === 2 && n[0].textContent === '漢字ドリル⑤';
    });
    check('日付（新しい順）に戻せる',
      (await page.evaluate(H.missingNames)).join(',') === '漢字ドリル⑤,新聞づくり');
    check('並べ替えでデータは書き換わらない',
      (await page.evaluate(() =>
        JSON.parse(localStorage.getItem('spa_submissions_data') || '[]').length)) === 4);

    // ── ⑦ 提出ボタンの自動判定 ──────────────────────────
    console.log('\n⑦ 提出ボタン（遅れ扱いの自動判定）');
    const btnLabels = await page.evaluate(() => {
      const g = id => {
        const b = document.querySelector('#subPsnDetail .sub-psn-btn[data-psnact="ok"][data-aid="' + id + '"]');
        return b ? { text: b.textContent, late: b.dataset.late } : null;
      };
      return { a101: g(101), a103: g(103) };
    });
    check('提出ボタンは1課題につき1つ',
      btnLabels.a101 !== null && btnLabels.a103 !== null);
    check('7/10欠席の101は「○ 提出」（遅れ扱いにしない）',
      btnLabels.a101.text.indexOf('○ 提出') >= 0 && btnLabels.a101.late === '0',
      JSON.stringify(btnLabels.a101));
    check('出席していた103は「⏰ 提出（遅れ）」',
      btnLabels.a103.text.indexOf('遅れ') >= 0 && btnLabels.a103.late === '1',
      JSON.stringify(btnLabels.a103));
    check('「⏰ 遅れて提出」の別ボタンは無くなっている',
      (await page.$('#subPsnDetail .sub-psn-btn[data-psnact="late"]')) === null);

    await page.click('#subPsnDetail .sub-psn-btn[data-psnact="ok"][data-aid="101"]');
    await page.waitForFunction(() =>
      document.querySelectorAll('#subPsnDetail .sub-psn-sec')[0]
        .querySelectorAll('.sub-psn-name').length === 1);
    check('未提出リストから消える',
      (await page.evaluate(H.missingNames)).join(',') === '新聞づくり');
    check('バッジが 3 → 2 に減る', (await page.evaluate(H.badges))[0] === '2');

    const rec101 = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('spa_submissions_data') || '[]')
        .find(r => r.studentIndex === 0 && r.assignmentId === 101));
    check('status=submitted', rec101 && rec101.status === 'submitted', JSON.stringify(rec101));
    check('lateOnDue=false',  rec101 && rec101.lateOnDue === false,    JSON.stringify(rec101));
    check('correctionDone=true', rec101 && rec101.correctionDone === true, JSON.stringify(rec101));

    // ── ⑧ 遅れフラグの自動付与と訂正 ────────────────────
    console.log('\n⑧ 遅れフラグの自動付与と訂正');
    await page.click('#subPsnDetail .sub-psn-btn[data-psnact="ok"][data-aid="103"]');
    await page.waitForFunction(() =>
      document.querySelectorAll('#subPsnDetail .sub-psn-sec')[0]
        .querySelectorAll('.sub-psn-name').length === 0);
    const rd = () => page.evaluate(() =>
      JSON.parse(localStorage.getItem('spa_submissions_data') || '[]')
        .find(r => r.studentIndex === 0 && r.assignmentId === 103));
    let rec103 = await rd();
    check('出席日の提出は lateOnDue=true が自動で付く',
      rec103 && rec103.lateOnDue === true, JSON.stringify(rec103));

    // 提出済みセクションを開いて遅れを取り消す
    await page.click('#subPsnDoneChk');
    await page.waitForFunction(() =>
      !!document.querySelector('#subPsnDetail .sub-psn-btn[data-psnact="tgllate"][data-aid="103"]'));
    await page.click('#subPsnDetail .sub-psn-btn[data-psnact="tgllate"][data-aid="103"]');
    await page.waitForFunction(() => {
      const b = document.querySelector('#subPsnDetail .sub-psn-btn[data-psnact="tgllate"][data-aid="103"]');
      return b && b.textContent.indexOf('遅れにする') >= 0;
    });
    rec103 = await rd();
    check('遅れを取り消せる（自動判定の訂正）',
      rec103 && rec103.lateOnDue === false, JSON.stringify(rec103));
    await page.click('#subPsnDetail .sub-psn-btn[data-psnact="tgllate"][data-aid="103"]');
    await page.waitForFunction(() => {
      const b = document.querySelector('#subPsnDetail .sub-psn-btn[data-psnact="tgllate"][data-aid="103"]');
      return b && b.textContent.indexOf('遅れを取り消す') >= 0;
    });
    rec103 = await rd();
    check('もう一度押すと遅れに戻る', rec103 && rec103.lateOnDue === true);
    await page.click('#subPsnDoneChk');
    await page.waitForFunction(() =>
      !document.querySelector('#subPsnDetail .sub-psn-btn[data-psnact="tgllate"]'));

    // ── ⑨ 届出トグル ───────────────────────────────────
    console.log('\n⑨ 届出の切り替え');
    await page.click('#subPsnDetail .sub-psn-nt-btn[data-psnact="notice"]');
    await page.waitForFunction(() => !document.querySelector('#subPsnDetail .sub-psn-nt-btn.off'));
    const nt = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('spa_attendance_notice') || '{}'));
    check('7/10 のあおいに届出が立つ',
      nt['2026-07-10'] && nt['2026-07-10']['0'] === true, JSON.stringify(nt));
    check('かえでの既存届出(7/3)は消えていない',
      nt['2026-07-03'] && nt['2026-07-03']['1'] === true, JSON.stringify(nt));
    check('あおいのバッジが ✓ になる', (await page.evaluate(H.badges))[0] === '✓');

    // ── ⑩ 入力タブとの往復 ─────────────────────────────
    console.log('\n⑩ 入力タブとの往復');
    await page.click('#view-submissions .sub-subnav-btn[data-sub="input"]');
    await page.waitForSelector('#sub-sub-input.active');
    await page.select('#subInputAssignSel', '101');
    await new Promise(r => setTimeout(r, 400));
    await page.click('#view-submissions .sub-subnav-btn[data-sub="person"]');
    await page.waitForSelector('#sub-sub-person.active');
    await new Promise(r => setTimeout(r, 400));
    const after = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('spa_submissions_data') || '[]')
        .filter(r => r.studentIndex === 0).length);
    check('あおいの記録3件が保持される（101/102/103）', after === 3, 'got ' + after);
    check('バッジが維持される', (await page.evaluate(H.badges))[0] === '✓');

  } catch (e) {
    fail++;
    console.log('\n  FAIL 例外: ' + e.message);
  } finally {
    await browser.close();
    console.log('\n===================================');
    console.log(`  pass: ${pass} / fail: ${fail}`);
    console.log('===================================');
    process.exit(fail ? 1 : 0);
  }
})();

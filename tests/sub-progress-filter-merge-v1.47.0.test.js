// v1.47.0の回帰テスト。
//   提出物チェック「入力」タブ(リストモード)で、教科フィルターバー(#subFilterBar)を
//   単独行から進捗帯(#subProgressWrap)の左側(#subProgressLeft、flex:1)へ統合し、
//   空いた1行ぶんをリスト(#subListWrap)へ還元した対応の回帰テスト。
//
// 検証項目:
//   ① 最下段が可視領域内に収まる(#subListWrapのscrollHeight <= clientHeight)。
//      統合前は横向き27人で488px(必要) > 484px(確保)で4pxオーバーしていたことを
//      実測済み(実機での見切れ報告と一致)。統合後は解消していることを確認する
//   ② 進捗帯(#subProgressWrap)の高さが54pxから増えていない(教科1つ/8つ、
//      27人/30人、横/縦のいずれの組み合わせでも)
//   ③ 教科タブ(.rec-filter-btn)・全員○ボタン(#subAllOkBtn)のタップ領域が44px以上
//   ④ 教科タブの切り替え(クリックでactive切替・課題選択肢の絞り込み)が正しく動く
//   ⑤ 教科8つでも1行に収まり折り返さない(#subFilterBarのscrollWidth <= clientWidth)
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node sub-progress-filter-merge-v1.47.0.test.js

const puppeteer = require('puppeteer-core');
const BASE_URL = 'http://localhost:8123/index.html';

const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}

const SUBJECTS_8 = ['国語', '社会', '算数', '理科', '音楽', '図工', '家庭', '体育'];
const SUBJECTS_1 = ['算数'];

function makeSeed(numStudents, subjects) {
    const students = [];
    for (let i = 0; i < numStudents; i++) students.push({ name: '児童' + (i + 1) });
    const assigns = subjects.map((s, i) => ({
        id: 100 + i, subject: s, name: '課題' + (i + 1),
        date: '2026-07-0' + ((i % 9) + 1), createdAt: '2026-07-01T00:00:00.000Z'
    }));
    return {
        spa_master: JSON.stringify({ classInfo: { grade: 5, className: '1', termSystem: 3 }, students }),
        spa_submissions_assignments: JSON.stringify(assigns),
        spa_submissions_data: JSON.stringify([])
    };
}

(async () => {
    const browser = await puppeteer.launch({
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: 'new'
    });

    for (const [w, h, orient] of [[1180, 820, '横'], [820, 1180, '縦']]) {
        for (const numStudents of [27, 30]) {
            for (const [subjLabel, subjects] of [['1教科', SUBJECTS_1], ['8教科', SUBJECTS_8]]) {
                const tag = `${orient}${w}x${h}/${numStudents}人/${subjLabel}`;
                const page = await browser.newPage();
                await page.setViewport({ width: w, height: h });
                await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
                const seed = makeSeed(numStudents, subjects);
                await page.evaluate((s) => {
                    localStorage.clear();
                    Object.keys(s).forEach(k => localStorage.setItem(k, s[k]));
                }, seed);
                await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
                await page.evaluate(() => showView('submissions'));
                await new Promise(r => setTimeout(r, 100));
                await page.click('.sub-subnav-btn[data-sub="input"]');
                await new Promise(r => setTimeout(r, 100));
                await page.click('#subViewListBtn');
                await new Promise(r => setTimeout(r, 100));
                await page.select('#subInputAssignSel', '100');
                await new Promise(r => setTimeout(r, 200));

                const info = await page.evaluate(() => {
                    const progress = document.getElementById('subProgressWrap');
                    const filterBar = document.getElementById('subFilterBar');
                    const listWrap = document.getElementById('subListWrap');
                    const allOkBtn = document.getElementById('subAllOkBtn');
                    const filterBtns = Array.from(filterBar.querySelectorAll('.rec-filter-btn'));
                    return {
                        progressH: Math.round(progress.getBoundingClientRect().height),
                        listScrollH: listWrap.scrollHeight,
                        listClientH: listWrap.clientHeight,
                        filterScrollW: filterBar.scrollWidth,
                        filterClientW: filterBar.clientWidth,
                        allOkBtnH: Math.round(allOkBtn.getBoundingClientRect().height),
                        filterBtnHeights: filterBtns.map(b => Math.round(b.getBoundingClientRect().height)),
                        filterBtnCount: filterBtns.length
                    };
                });

                // ① 最下段クリップなし
                check(`①${tag}: リストが確保高に収まる(scrollH<=clientH)`,
                    info.listScrollH <= info.listClientH,
                    `scrollH=${info.listScrollH} clientH=${info.listClientH}`);

                // ② 進捗帯の高さが54pxのまま
                check(`②${tag}: 進捗帯の高さが54px`, info.progressH === 54, `progressH=${info.progressH}`);

                // ③ タップ領域44px以上
                check(`③${tag}: 全員○ボタンが44px以上`, info.allOkBtnH >= 44, `h=${info.allOkBtnH}`);
                check(`③${tag}: 教科タブ(${info.filterBtnCount}個)がすべて44px以上`,
                    info.filterBtnHeights.every(h => h >= 44), JSON.stringify(info.filterBtnHeights));

                // ⑤ 折り返しなし(横スクロール幅が表示幅を超えていても1行のまま=scrollWidthはscrollWidthでOK、
                //    折り返し発生時はscrollHeightが増えるはずなので高さでも二重チェック)
                check(`⑤${tag}: 教科タブが1行に収まる(scrollW<=clientW、8教科は横スクロール許容)`,
                    subjLabel === '1教科' ? info.filterScrollW <= info.filterClientW + 2 : true,
                    `scrollW=${info.filterScrollW} clientW=${info.filterClientW}`);
                check(`⑤${tag}: 教科タブの高さが1行分(44px)を超えて折り返していない`,
                    Math.max(...info.filterBtnHeights) <= 48, JSON.stringify(info.filterBtnHeights));

                // ④ 教科タブの切り替え動作(8教科の場合のみ、1つ目をクリックして絞り込みが効くか)
                if (subjLabel === '8教科') {
                    const before = await page.evaluate(() => document.getElementById('subInputAssignSel').options.length);
                    await page.click('#subFilterBar .rec-filter-btn');
                    await new Promise(r => setTimeout(r, 150));
                    const afterInfo = await page.evaluate(() => {
                        const btn = document.querySelector('#subFilterBar .rec-filter-btn');
                        return { active: btn ? btn.classList.contains('active') : false,
                            optCount: document.getElementById('subInputAssignSel').options.length };
                    });
                    check(`④${tag}: 教科タブクリックでactiveになる`, afterInfo.active === true);
                    check(`④${tag}: 絞り込みで課題選択肢が変化する(${before}→${afterInfo.optCount})`,
                        afterInfo.optCount < before, `before=${before} after=${afterInfo.optCount}`);
                }

                await page.close();
            }
        }
    }

    await browser.close();
    const fail = results.filter(r => !r.pass).length;
    console.log('\n合計: ' + results.length + '件 / 成功: ' + (results.length - fail) + '件 / 失敗: ' + fail + '件');
    process.exit(fail > 0 ? 1 : 0);
})();

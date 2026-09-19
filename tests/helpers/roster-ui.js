// 名簿のリスト編集UI(設定画面)を、実際のタップ・入力で操作するヘルパー(H4 段階3のE2Eテスト用)。
// DOM の data-act / data-i 属性で要素を特定する。i は下書きの行番号(削除予定の行も数える。0始まり)。
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function openSettings(page) {
    await page.evaluate(() => { showView('settings'); });
    await page.waitForSelector('#rosterEditor .rl-row, #rosterEditor .ui-empty', { timeout: 5000 });
    await sleep(150);
}
// 入力欄をタップして全選択し、消してから入力する(3回クリックは日本語だと単語選択になり全選択されないため select() を使う)
async function setInput(page, sel, text) {
    await page.click(sel);
    await page.evaluate((s) => { document.querySelector(s).select(); }, sel);
    await page.keyboard.press('Backspace');
    if (text) await page.keyboard.type(text);
}
async function setName(page, i, text) { await setInput(page, '#rosterEditor input[data-act="name"][data-i="' + i + '"]', text); }
async function setGender(page, i, value) {
    await page.select('#rosterEditor select[data-act="gender"][data-i="' + i + '"]', value);
}
async function act(page, action, i) {
    const sel = (i === undefined) ? '#rosterEditorCard button[data-act="' + action + '"]' : '#rosterEditor button[data-act="' + action + '"][data-i="' + i + '"]';
    await page.click(sel);
    await sleep(80);
}
async function clickSave(page) { await page.click('#rosterSaveBtn'); await sleep(80); }
// 名簿の保存・取り消し・復元のあとに自動で再読み込みされる。再読み込みの完了を待つ。
async function waitReload(page) {
    await sleep(1500);
    await page.waitForFunction(() => typeof StorageManager !== 'undefined' && !!document.getElementById('rosterEditor'));
    await sleep(900);
}
const rowNames = (page) => page.evaluate(() => Array.from(document.querySelectorAll('#rosterEditor .rl-row')).map(r => r.querySelector('input[data-act="name"]').value));
const rowCount = (page) => page.evaluate(() => document.querySelectorAll('#rosterEditor .rl-row').length);
// トーストの表示を確認する(#toast が表示中で #toastMsg に文言がある)。body.textContent は <script> のソースを含むため使わない。
const toastHas = (page, t, ms) => page.waitForFunction((t) => { const box = document.getElementById('toast'), el = document.getElementById('toastMsg') || box; return !!el && !!box && box.classList.contains('show') && el.textContent.indexOf(t) !== -1; }, { timeout: ms || 1500, polling: 50 }, t).then(() => true).catch(() => false);

module.exports = { openSettings, setInput, setName, setGender, act, clickSave, waitReload, rowNames, rowCount, toastHas, sleep };

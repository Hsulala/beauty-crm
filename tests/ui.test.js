const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const admin = (file) => fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', file), 'utf8');

test('左側導覽：固定三組、項目齊全、沒有表情符號', () => {
  const html = admin('index.html');
  const nav = html.slice(html.indexOf('<aside class="sidebar"'), html.indexOf('</aside>'));
  for (const title of ['主要', '營運', '設定']) assert.ok(nav.includes(`>${title}</div>`), `缺少群組：${title}`);
  for (const item of ['月曆總覽', '本週時段表', '客戶管理', '營收明細', '預約開放範圍', '時段範本設定', '品項管理', '皮膚紀錄欄位設定', '子帳號管理', '帳號設定', '功能模組', '登出']) {
    assert.ok(nav.includes(`>${item}</button>`), `缺少項目：${item}`);
  }
  // 只檢查這次新增的部分（側邊欄、功能模組視窗、新增的 JS 區塊）；既有畫面裡原本的符號不在此範圍。
  const modal = html.slice(html.indexOf('id="modulesScrim"'), html.indexOf('<script src="./app.js">'));
  const js = admin('app.js');
  const added = nav + modal + js.slice(js.indexOf('店家設定：功能模組'));
  assert.equal(/\p{Extended_Pictographic}/u.test(added), false, '新增的後台內容不應含表情符號');
});

test('導覽項目：代理點擊的目標按鈕都存在；模組項目對應的模組都有定義', () => {
  const html = admin('index.html');
  const { MODULE_KEYS } = require('../src/storeConfig');
  for (const [, id] of html.matchAll(/data-proxy="([\w-]+)"/g)) assert.ok(html.includes(`id="${id}"`), `找不到代理目標 #${id}`);
  for (const [, key] of html.matchAll(/<button[^>]*data-module="(\w+)"/g)) assert.ok(MODULE_KEYS.includes(key), `未定義的模組：${key}`);
});

test('導覽項目：只有管理者能用的項目都標了 owner-only（操作人員看不到）', () => {
  const html = admin('index.html');
  for (const id of ['bookingWindowBtn', 'availSettingsBtn', 'serviceMgmtBtn', 'intakeSettingsBtn', 'subAcctBtn', 'modulesBtn']) {
    const row = html.match(new RegExp(`<button[^>]*data-proxy="${id}"[^>]*>`));
    assert.ok(row && row[0].includes('owner-only'), `${id} 的側邊欄項目應標 owner-only`);
  }
});

test('模組未開通：側邊欄淡灰標示、手機版不受影響、前端判斷模組', () => {
  const html = admin('index.html'), js = admin('app.js');
  assert.match(html, /\.side-item\.is-off::after\{ content:"未開通"/);
  assert.match(html, /@media \(min-width:721px\)/);
  assert.ok(js.includes('isModuleOn') && js.includes('此功能尚未開通'));
  assert.ok(html.includes('id="mobileNav"'), '手機版底部導覽列仍在');
});

test('新增的前端程式用到的元素 id 都存在於 HTML', () => {
  const html = admin('index.html'), full = admin('app.js');
  const js = full.slice(full.indexOf('店家設定：功能模組')); // 既有區塊有些元素是動態產生的，只檢查新增的部分
  const missing = new Set();
  for (const [, id] of js.matchAll(/getElementById\('([\w-]+)'\)/g)) if (!html.includes(`id="${id}"`)) missing.add(id);
  assert.deepEqual([...missing], []);
});

// 「查看我的預約」頁：用同一個 LIFF 身份驗證，只拉這位客人自己未來的預約，不會看到其他客人資料。

function formatPrice(price) {
  if (price === null || price === undefined) return '';
  return `$${Number(price).toLocaleString('zh-Hant-TW')}`;
}

async function init() {
  const configRes = await fetch('/api/liff-config');
  const { liffId } = await configRes.json();
  await liff.init({ liffId });
  if (!liff.isLoggedIn()) {
    liff.login();
    return;
  }

  const idToken = liff.getIDToken();
  const res = await fetch('/api/my-bookings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  const data = await res.json();

  if (!res.ok) {
    document.getElementById('list').innerHTML = `<div class="empty">${data.error || '讀取失敗，請稍後再試'}</div>`;
    return;
  }

  renderList(data.bookings || []);
}

function renderList(bookings) {
  const list = document.getElementById('list');
  if (!bookings.length) {
    list.innerHTML = '<div class="empty">目前沒有即將到來的預約</div>';
    return;
  }

  list.innerHTML = bookings
    .map((b) => {
      const addonLine = b.addons && b.addons.length
        ? `升級體驗：${b.addons.map((a) => a.name).join('、')}<br>`
        : '';
      const price = Number(b.price || 0) + (b.addons || []).reduce((sum, a) => sum + Number(a.price || 0), 0);
      const noteBlock = b.note ? `<div class="b-note">您的備註：${b.note}</div>` : '';
      return `
        <div class="card">
          <div class="b-date">${b.date}　${b.startTime.slice(0, 5)}</div>
          <div class="b-service">${b.serviceName}</div>
          <div class="b-meta">${addonLine}約 ${b.durationMinutes} 分鐘・${formatPrice(price)}</div>
          ${noteBlock}
        </div>
      `;
    })
    .join('');
}

init().catch((err) => {
  document.getElementById('list').innerHTML = `<div class="empty">頁面初始化失敗：${err.message}</div>`;
});

const form = document.getElementById('login-form');
const errorBox = document.getElementById('login-error');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  const response = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: form.password.value }),
  });
  if (response.ok) { location.href = '/'; return; }
  const body = await response.json().catch(() => ({}));
  errorBox.textContent = body.error ?? '登入失敗，請再試一次';
  errorBox.hidden = false;
  form.password.select();
});

import { getMiniAppConfig } from "../env";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderMiniAppHtml(): string {
  const config = getMiniAppConfig();
  const appTitle = "NexaMeet";
  const onboardingEnabled = config.onboardingEnabled ? "true" : "false";

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>${escapeHtml(appTitle)}</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    :root {
      --bg: #05070a;
      --card: #0b1220;
      --line: #173049;
      --text: #e6f3ff;
      --muted: #89a7bf;
      --cyan: #00e5ff;
      --lime: #a3ff12;
      --danger: #ff4d5e;
      --ok: #1dd38f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: radial-gradient(1200px 600px at 20% -10%, #0f2d47, transparent), var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      min-height: 100vh;
      padding: max(16px, env(safe-area-inset-top)) 14px max(18px, env(safe-area-inset-bottom));
    }
    .wrap { max-width: 680px; margin: 0 auto; }
    .card {
      background: linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.01));
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 14px;
      margin-bottom: 12px;
      box-shadow: 0 0 0 1px rgba(0,229,255,.06), 0 12px 34px rgba(0,0,0,.35);
    }
    h1 { font-size: 18px; margin: 0 0 8px; letter-spacing: .2px; }
    h2 { font-size: 15px; margin: 0 0 8px; color: var(--cyan); }
    .muted { color: var(--muted); font-size: 13px; }
    .row { display: grid; gap: 8px; margin: 8px 0; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    input, select, textarea, button {
      width: 100%;
      border-radius: 12px;
      border: 1px solid #204463;
      background: #0b1627;
      color: var(--text);
      padding: 11px 12px;
      font-size: 14px;
    }
    textarea { min-height: 90px; resize: vertical; }
    button {
      cursor: pointer;
      border-color: #1f6075;
      transition: .15s ease;
    }
    button.primary {
      background: linear-gradient(90deg, var(--cyan), #61f2ff);
      border: 0;
      color: #022433;
      font-weight: 700;
    }
    button.lime {
      background: linear-gradient(90deg, #7be500, var(--lime));
      border: 0;
      color: #172100;
      font-weight: 700;
    }
    button.danger {
      border-color: #7f3341;
      color: #ffacb3;
    }
    .tabs { display: flex; gap: 6px; margin-bottom: 10px; }
    .tabs button { font-size: 13px; padding: 9px; }
    .tabs button.active { border-color: var(--cyan); box-shadow: 0 0 0 1px rgba(0,229,255,.35) inset; }
    .hidden { display: none !important; }
    .pill {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 999px;
      border: 1px solid #1f4f6f;
      font-size: 12px;
      color: #9fd8ff;
      margin-right: 6px;
    }
    .request { border: 1px solid #1b344a; border-radius: 12px; padding: 10px; margin: 8px 0; }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
    .small { font-size: 12px; }
    .ok { color: var(--ok); }
    .err { color: #ff8f9a; }
    .slot-list {
      max-height: 240px;
      overflow: auto;
      border: 1px solid #1b344a;
      border-radius: 12px;
      padding: 6px;
      background: rgba(5, 12, 20, .7);
    }
    .slot-item {
      width: 100%;
      text-align: left;
      border-radius: 10px;
      border: 1px solid #1f3f5c;
      background: #0a1626;
      margin: 5px 0;
      padding: 10px 10px;
      font-size: 13px;
      line-height: 1.3;
    }
    .slot-item.active {
      border-color: var(--cyan);
      box-shadow: 0 0 0 1px rgba(0,229,255,.25) inset;
      background: #10253b;
    }
    .slot-date { color: #cce8ff; }
    .slot-time { color: #7af4ff; font-weight: 700; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>${escapeHtml(appTitle)}</h1>
      <div id="status" class="muted">Подключение...</div>
    </div>

    <div id="onboarding" class="card hidden">
      <h2>Быстрый старт</h2>
      <div class="muted">Создавайте и управляйте заявками в 2-3 нажатия.</div>
      <div class="row">
        <button id="btnAddHome" class="lime">Добавить на главный экран</button>
        <button id="btnCloseOnboarding">Понятно</button>
      </div>
    </div>

    <div id="appRoot" class="hidden">
      <div class="tabs card">
        <button data-tab="home" class="active">Главная</button>
        <button data-tab="new">Новая заявка</button>
        <button data-tab="my">Мои заявки</button>
        <button id="tabAdmin" data-tab="admin" class="hidden">Админ</button>
      </div>

      <section id="tab-home" class="card">
        <h2>Главная</h2>
        <div id="profileBlock" class="muted"></div>
      </section>

      <section id="tab-new" class="card hidden">
        <h2>Новая заявка</h2>
        <div class="grid2">
          <label>Длительность
            <select id="fDuration">
              <option value="15">15 мин</option>
              <option value="30" selected>30 мин</option>
              <option value="45">45 мин</option>
              <option value="60">60 мин</option>
              <option value="90">90 мин</option>
            </select>
          </label>
          <label>Формат
            <select id="fFormat">
              <option value="ONLINE">Онлайн</option>
              <option value="OFFLINE">Оффлайн</option>
            </select>
          </label>
        </div>
        <div class="row">
          <button id="btnLoadSlots">Показать доступные слоты</button>
          <div id="fSlot" class="slot-list muted">Слоты пока не загружены.</div>
        </div>
        <div class="grid2">
          <label>Имя <input id="fFirstName" /></label>
          <label>Фамилия <input id="fLastName" /></label>
        </div>
        <div class="row">
          <label>Email <input id="fEmail" type="email" /></label>
          <label>Тема <input id="fTopic" /></label>
          <label>Описание <textarea id="fDescription"></textarea></label>
          <label id="locationWrap" class="hidden">Место/адрес <input id="fLocation" /></label>
          <button id="btnSubmitRequest" class="primary">Отправить заявку</button>
        </div>
      </section>

      <section id="tab-my" class="card hidden">
        <h2>Мои заявки</h2>
        <button id="btnReloadMy">Обновить</button>
        <div id="myRequests" class="row"></div>
      </section>

      <section id="tab-admin" class="card hidden">
        <h2>Админ — заявки</h2>
        <button id="btnReloadAdmin">Обновить</button>
        <div id="adminRequests" class="row"></div>
        <hr style="border-color:#173049; opacity:.5; margin:12px 0" />
        <h2>Админ — настройки</h2>
        <div class="grid2">
          <label>Начало дня <input id="sStart" type="number" /></label>
          <label>Конец дня <input id="sEnd" type="number" /></label>
          <label>Буфер, мин <input id="sBuffer" type="number" /></label>
          <label>Лимит слотов <input id="sLimit" type="number" /></label>
          <label>Горизонт, дней <input id="sHorizon" type="number" /></label>
          <label>Опережение, ч <input id="sLead" type="number" /></label>
        </div>
        <div class="row">
          <button id="btnSaveSettings" class="lime">Сохранить настройки</button>
        </div>
      </section>
    </div>
  </div>

  <script>
    (() => {
      const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
      if (tg) { tg.ready(); tg.expand(); }

      const els = {
        status: document.getElementById('status'),
        appRoot: document.getElementById('appRoot'),
        onboarding: document.getElementById('onboarding'),
        btnAddHome: document.getElementById('btnAddHome'),
        btnCloseOnboarding: document.getElementById('btnCloseOnboarding'),
        tabAdmin: document.getElementById('tabAdmin'),
        profileBlock: document.getElementById('profileBlock'),
        myRequests: document.getElementById('myRequests'),
        adminRequests: document.getElementById('adminRequests'),
        fDuration: document.getElementById('fDuration'),
        fFormat: document.getElementById('fFormat'),
        fSlot: document.getElementById('fSlot'),
        fFirstName: document.getElementById('fFirstName'),
        fLastName: document.getElementById('fLastName'),
        fEmail: document.getElementById('fEmail'),
        fTopic: document.getElementById('fTopic'),
        fDescription: document.getElementById('fDescription'),
        fLocation: document.getElementById('fLocation'),
        locationWrap: document.getElementById('locationWrap'),
        sStart: document.getElementById('sStart'),
        sEnd: document.getElementById('sEnd'),
        sBuffer: document.getElementById('sBuffer'),
        sLimit: document.getElementById('sLimit'),
        sHorizon: document.getElementById('sHorizon'),
        sLead: document.getElementById('sLead')
      };

      let token = null;
      let role = 'user';
      let slotsCache = [];
      let selectedSlotIndex = null;

      const statusLabels = {
        NEW: 'Новая',
        PENDING_APPROVAL: 'На согласовании',
        APPROVED: 'Подтверждена',
        REJECTED: 'Отклонена',
        CANCELLED: 'Отменена',
        RESCHEDULE_REQUESTED: 'Перенос запрошен',
        RESCHEDULED: 'Перенесена',
        EXPIRED: 'Истекла'
      };

      function formatDateParts(iso) {
        const d = new Date(iso);
        return {
          date: new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', weekday: 'short', day: '2-digit', month: '2-digit' }).format(d),
          time: new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }).format(d)
        };
      }

      function formatDateRange(startIso, endIso) {
        const s = formatDateParts(startIso);
        const e = formatDateParts(endIso);
        return s.date + ' • ' + s.time + '–' + e.time + ' (МСК)';
      }

      function setStatus(text, type = 'muted') {
        els.status.className = type;
        els.status.textContent = text;
      }

      async function api(url, options = {}) {
        const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
        if (token) headers['Authorization'] = 'Bearer ' + token;
        const response = await fetch(url, Object.assign({}, options, { headers }));
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok === false) {
          throw new Error(data.error || ('HTTP ' + response.status));
        }
        return data;
      }

      function switchTab(tab) {
        document.querySelectorAll('.tabs button[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
        ['home','new','my','admin'].forEach((t) => {
          const el = document.getElementById('tab-' + t);
          if (!el) return;
          el.classList.toggle('hidden', t !== tab);
        });
      }

      function renderRequests(container, requests, mode) {
        container.innerHTML = '';
        if (!requests.length) {
          container.innerHTML = '<div class="muted">Пусто</div>';
          return;
        }
        requests.forEach((r) => {
          const node = document.createElement('div');
          node.className = 'request';
          const statusLabel = statusLabels[r.status] || r.status;
          node.innerHTML = [
            '<div><span class="pill">' + statusLabel + '</span> <strong>' + (r.topic || '-') + '</strong></div>',
            '<div class="small muted">' + formatDateRange(r.start_at, r.end_at) + '</div>',
            '<div class="actions"></div>'
          ].join('');
          const actions = node.querySelector('.actions');

          if (mode === 'my') {
            if (r.can_cancel) {
              const cancelBtn = document.createElement('button');
              cancelBtn.textContent = 'Отменить';
              cancelBtn.className = 'danger';
              cancelBtn.onclick = async () => {
                await api('/api/webapp/requests/' + r.id + '/cancel', { method: 'POST' });
                await loadMyRequests();
              };
              actions.appendChild(cancelBtn);
            }
            if (r.can_reschedule) {
              const rsBtn = document.createElement('button');
              rsBtn.textContent = 'Перенести';
              rsBtn.onclick = async () => {
                const start = prompt('Новый start_at ISO', r.start_at);
                const end = prompt('Новый end_at ISO', r.end_at);
                if (!start || !end) return;
                await api('/api/webapp/requests/' + r.id + '/reschedule', {
                  method: 'POST',
                  body: JSON.stringify({ start_at: start, end_at: end })
                });
                await loadMyRequests();
              };
              actions.appendChild(rsBtn);
            }
          }

          if (mode === 'admin') {
            const approve = document.createElement('button');
            approve.textContent = 'Подтвердить';
            approve.className = 'lime';
            approve.onclick = async () => {
              await api('/api/webapp/admin/requests/' + r.id + '/approve', { method: 'POST' });
              await loadAdminRequests();
            };
            actions.appendChild(approve);

            const reject = document.createElement('button');
            reject.textContent = 'Отклонить';
            reject.className = 'danger';
            reject.onclick = async () => {
              const comment = prompt('Комментарий (опционально):', '') || null;
              await api('/api/webapp/admin/requests/' + r.id + '/reject', {
                method: 'POST',
                body: JSON.stringify({ comment })
              });
              await loadAdminRequests();
            };
            actions.appendChild(reject);

            const cancel = document.createElement('button');
            cancel.textContent = 'Отменить';
            cancel.onclick = async () => {
              await api('/api/webapp/admin/requests/' + r.id + '/cancel', { method: 'POST' });
              await loadAdminRequests();
            };
            actions.appendChild(cancel);

            const reschedule = document.createElement('button');
            reschedule.textContent = 'Перенести';
            reschedule.onclick = async () => {
              const start = prompt('Новый start_at ISO', r.start_at);
              const end = prompt('Новый end_at ISO', r.end_at);
              if (!start || !end) return;
              await api('/api/webapp/admin/requests/' + r.id + '/reschedule', {
                method: 'POST',
                body: JSON.stringify({ start_at: start, end_at: end })
              });
              await loadAdminRequests();
            };
            actions.appendChild(reschedule);
          }

          container.appendChild(node);
        });
      }

      async function loadMyRequests() {
        const data = await api('/api/webapp/requests/my');
        renderRequests(els.myRequests, data.requests || [], 'my');
      }

      async function loadAdminRequests() {
        if (role !== 'admin') return;
        const data = await api('/api/webapp/admin/requests?limit=30');
        renderRequests(els.adminRequests, data.requests || [], 'admin');
      }

      async function loadAdminSettings() {
        if (role !== 'admin') return;
        const data = await api('/api/webapp/admin/settings');
        const s = data.settings;
        els.sStart.value = s.workday_start_hour;
        els.sEnd.value = s.workday_end_hour;
        els.sBuffer.value = s.slot_buffer_minutes;
        els.sLimit.value = s.slot_limit;
        els.sHorizon.value = s.slot_horizon_days;
        els.sLead.value = s.slot_min_lead_hours;
      }

      async function bootstrap() {
        const initData = tg && tg.initData ? tg.initData : '';
        let auth = null;
        let browserDevMode = false;

        if (initData) {
          auth = await api('/api/webapp/auth', {
            method: 'POST',
            body: JSON.stringify({ initData })
          });
        } else {
          browserDevMode = true;
          setStatus('Локальный режим теста (без Telegram)...');
          auth = await api('/api/webapp/auth/dev', {
            method: 'POST',
            body: JSON.stringify({})
          });
        }

        token = auth.token;
        const data = await api('/api/webapp/bootstrap');
        role = data.role;

        const user = data.user || {};
        els.profileBlock.innerHTML = [
          '<div><strong>' + (user.first_name || '-') + ' ' + (user.last_name || '') + '</strong></div>',
          '<div class="muted">@' + (user.username || '-') + ' / роль: ' + (role === 'admin' ? 'админ' : 'пользователь') + '</div>'
        ].join('');

        if (role === 'admin') {
          els.tabAdmin.classList.remove('hidden');
        }

        if (${onboardingEnabled} && localStorage.getItem('miniapp_onboarding_done') !== '1') {
          els.onboarding.classList.remove('hidden');
        }

        els.fFirstName.value = user.first_name || '';
        els.fLastName.value = user.last_name || '';
        els.fEmail.value = '';
        els.fTopic.value = '';

        await loadMyRequests();
        await loadAdminRequests();
        await loadAdminSettings();

        els.appRoot.classList.remove('hidden');
        setStatus(browserDevMode ? 'Подключено (локальный режим)' : 'Подключено', 'ok');
      }

      document.querySelectorAll('.tabs button[data-tab]').forEach((btn) => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
      });

      els.fFormat.addEventListener('change', () => {
        els.locationWrap.classList.toggle('hidden', els.fFormat.value !== 'OFFLINE');
      });

      document.getElementById('btnLoadSlots').addEventListener('click', async () => {
        const duration = Number(els.fDuration.value || 30);
        const data = await api('/api/webapp/slots?duration=' + duration);
        slotsCache = data.slots || [];
        selectedSlotIndex = null;
        els.fSlot.innerHTML = '';

        if (!slotsCache.length) {
          els.fSlot.innerHTML = '<div class="muted">Свободных слотов нет.</div>';
          return;
        }

        slotsCache.forEach((slot, index) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'slot-item';
          const start = formatDateParts(slot.start_at);
          const end = formatDateParts(slot.end_at);
          btn.innerHTML = '<div class="slot-date">' + start.date + '</div><div class="slot-time">' + start.time + '–' + end.time + ' (МСК)</div>';
          btn.onclick = () => {
            selectedSlotIndex = index;
            els.fSlot.querySelectorAll('.slot-item').forEach((n) => n.classList.remove('active'));
            btn.classList.add('active');
          };
          els.fSlot.appendChild(btn);
        });
      });

      document.getElementById('btnSubmitRequest').addEventListener('click', async () => {
        const slot = selectedSlotIndex === null ? null : slotsCache[selectedSlotIndex];
        if (!slot) {
          alert('Сначала выбери слот');
          return;
        }
        await api('/api/webapp/requests', {
          method: 'POST',
          body: JSON.stringify({
            duration_minutes: Number(els.fDuration.value || 30),
            format: els.fFormat.value,
            start_at: slot.start_at,
            end_at: slot.end_at,
            topic: els.fTopic.value,
            description: els.fDescription.value || null,
            email: els.fEmail.value,
            first_name: els.fFirstName.value,
            last_name: els.fLastName.value,
            location: els.fFormat.value === 'OFFLINE' ? (els.fLocation.value || null) : null
          })
        });
        alert('Заявка отправлена');
        switchTab('my');
        await loadMyRequests();
      });

      document.getElementById('btnReloadMy').addEventListener('click', () => loadMyRequests());
      document.getElementById('btnReloadAdmin').addEventListener('click', () => loadAdminRequests());

      document.getElementById('btnSaveSettings').addEventListener('click', async () => {
        await api('/api/webapp/admin/settings', {
          method: 'PATCH',
          body: JSON.stringify({
            workday_start_hour: Number(els.sStart.value),
            workday_end_hour: Number(els.sEnd.value),
            slot_buffer_minutes: Number(els.sBuffer.value),
            slot_limit: Number(els.sLimit.value),
            slot_horizon_days: Number(els.sHorizon.value),
            slot_min_lead_hours: Number(els.sLead.value)
          })
        });
        alert('Настройки сохранены');
      });

      els.btnCloseOnboarding.addEventListener('click', () => {
        els.onboarding.classList.add('hidden');
        localStorage.setItem('miniapp_onboarding_done', '1');
      });

      els.btnAddHome.addEventListener('click', () => {
        if (tg && typeof tg.addToHomeScreen === 'function') {
          try { tg.addToHomeScreen(); } catch {}
        }
      });

      bootstrap().catch((error) => {
        const message = error && error.message ? error.message : 'unknown';
        if (message === 'MINI_APP_BROWSER_AUTH_DISABLED') {
          setStatus('Локальный доступ выключен: включи MINI_APP_BROWSER_AUTH_ENABLED=true', 'err');
          return;
        }
        setStatus('Ошибка: ' + message, 'err');
      });
    })();
  </script>
</body>
</html>`;
}

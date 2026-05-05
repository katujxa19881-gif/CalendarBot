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
    .request { border: 1px solid #1b344a; border-radius: 12px; padding: 10px; margin: 8px 0; display: grid; gap: 8px; }
    .request-head { min-height: 46px; display: grid; align-content: start; gap: 4px; }
    .request-title { line-height: 1.3; }
    .request-select { margin-right: 8px; transform: translateY(1px); width: 16px; height: 16px; accent-color: var(--cyan); }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 2px; }
    .actions button { min-height: 44px; }
    .actions button.ghost {
      opacity: .38;
      cursor: default;
      pointer-events: none;
    }
    .small { font-size: 12px; }
    .small-link {
      font-size: 12px;
      color: #9ee8ff;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid #1f4f6f;
      border-radius: 999px;
      padding: 4px 10px;
      width: fit-content;
      background: rgba(7, 24, 38, .6);
    }
    .small-link:hover { border-color: var(--cyan); }
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
    details.group {
      border: 1px solid #1b344a;
      border-radius: 12px;
      padding: 8px 10px;
      margin: 8px 0;
      background: rgba(9, 19, 32, .6);
    }
    details.group > summary {
      cursor: pointer;
      list-style: none;
      font-weight: 700;
      color: #b9dbf3;
      outline: none;
    }
    details.group > summary::-webkit-details-marker { display: none; }
    .group-count { color: var(--muted); font-weight: 500; margin-left: 6px; }
    .slot-day-group {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid rgba(31, 63, 92, .7);
    }
    .slot-day-title {
      font-size: 12px;
      color: #9ec3dd;
      margin-bottom: 6px;
    }
    .slot-time-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(88px, 1fr));
      gap: 6px;
    }
    .slot-time-grid .slot-item {
      margin: 0;
      text-align: center;
      padding: 9px 6px;
    }
    .hero {
      border: 1px solid #19486a;
      border-radius: 14px;
      padding: 12px;
      background: linear-gradient(135deg, rgba(0,229,255,.10), rgba(163,255,18,.08));
      margin-top: 10px;
    }
    .hero-intro {
      display: grid;
      grid-template-columns: 92px 1fr;
      gap: 12px;
      align-items: start;
      margin-bottom: 8px;
    }
    .hero-photo {
      width: 92px;
      height: 92px;
      border-radius: 12px;
      object-fit: cover;
      object-position: center top;
      border: 1px solid #1f4f6f;
      box-shadow: 0 8px 20px rgba(0, 0, 0, .35);
    }
    .hero-list {
      margin: 0;
      padding-left: 18px;
      color: #b9d2e6;
      font-size: 13px;
      line-height: 1.45;
      display: grid;
      gap: 4px;
    }
    .hero-quick {
      margin-top: 12px;
      display: grid;
      gap: 8px;
    }
    .hero-quick button {
      background: rgba(255, 255, 255, .04);
      border-color: #2a4b68;
      text-align: left;
      padding: 10px 12px;
    }
    .hero-quick strong { display: block; margin-bottom: 2px; }
    .hero-quick span { color: var(--muted); font-size: 12px; }
    .weekday-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      margin-top: 6px;
    }
    .weekday-grid label {
      border: 1px solid #214661;
      border-radius: 10px;
      padding: 7px 8px;
      background: #0b1627;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .weekday-grid input { width: auto; margin: 0; accent-color: var(--cyan); }
    .oauth-status {
      border: 1px solid #214661;
      border-radius: 12px;
      padding: 10px;
      background: rgba(8, 18, 30, .6);
      display: grid;
      gap: 5px;
      font-size: 13px;
    }
    .oauth-badge {
      display: inline-block;
      border-radius: 999px;
      padding: 4px 8px;
      border: 1px solid #1f4f6f;
      width: fit-content;
    }
    .oauth-badge.ok { color: #7effbc; border-color: #2f8d61; }
    .oauth-badge.err { color: #ffacb3; border-color: #8a4651; }
    .chip-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .chip {
      width: auto;
      padding: 7px 10px;
      border-radius: 999px;
      font-size: 12px;
      border: 1px solid #255173;
      background: rgba(12, 25, 39, .7);
      color: #b8d6eb;
    }
    .chip.active {
      border-color: var(--cyan);
      color: #dfffff;
      box-shadow: 0 0 0 1px rgba(0,229,255,.25) inset;
    }
    @media (max-width: 540px) {
      .hero-intro { grid-template-columns: 84px 1fr; }
      .hero-photo { width: 84px; height: 84px; }
      .weekday-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(4, 10, 17, .72);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      z-index: 50;
    }
    .modal {
      width: min(680px, 100%);
      max-height: 90vh;
      overflow: auto;
      background: #0a1424;
      border: 1px solid #1d4767;
      border-radius: 14px;
      padding: 12px;
      box-shadow: 0 16px 40px rgba(0,0,0,.45);
    }
    .modal h3 {
      margin: 0 0 10px;
      color: #9ee8ff;
      font-size: 16px;
    }
    .template-grid {
      display: grid;
      gap: 8px;
      margin-bottom: 8px;
    }
    .template-btn {
      text-align: left;
      white-space: normal;
      line-height: 1.3;
      font-size: 13px;
      padding: 10px;
      border-color: #255173;
    }
    .template-btn.active {
      border-color: var(--cyan);
      box-shadow: 0 0 0 1px rgba(0,229,255,.3) inset;
      background: #11253a;
    }
    .modal-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-top: 10px;
    }
    .slot-date { color: #cce8ff; }
    .slot-time { color: #7af4ff; font-weight: 700; }
  </style>
</head>
<body>
  <!-- miniapp-build: modal-v2 -->
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
        <div class="chip-row" id="newRequestProgress">
          <button type="button" class="chip active" data-new-step="1">1. Формат</button>
          <button type="button" class="chip" data-new-step="2">2. Слот</button>
          <button type="button" class="chip" data-new-step="3">3. Контакты</button>
          <button type="button" class="chip" data-new-step="4">4. Отправка</button>
        </div>
        <div id="newStep1" class="row">
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
        </div>
        <div id="newStep2" class="row">
          <button id="btnLoadSlots">Показать доступные слоты</button>
          <div id="fSlot" class="slot-list muted">Слоты пока не загружены.</div>
        </div>
        <div id="newStep3" class="row">
        <div class="grid2">
          <label>Имя <input id="fFirstName" /></label>
          <label>Фамилия <input id="fLastName" /></label>
        </div>
        <div class="row">
          <label>Email <input id="fEmail" type="email" /></label>
          <label>Тема <input id="fTopic" /></label>
          <label>Описание <textarea id="fDescription"></textarea></label>
          <label id="locationWrap" class="hidden">Место/адрес <input id="fLocation" /></label>
        </div>
        </div>
        <div id="newStep4" class="row">
          <button id="btnSubmitRequest" class="primary">Отправить заявку</button>
          <div id="newRequestHint" class="muted">Заполните шаги 1–4 для отправки заявки.</div>
        </div>
      </section>

      <section id="tab-my" class="card hidden">
        <h2>Мои заявки</h2>
        <button id="btnReloadMy">Обновить</button>
        <div class="chip-row" id="myStatusFilters">
          <button type="button" class="chip active" data-my-filter="ALL">Все</button>
          <button type="button" class="chip" data-my-filter="PENDING_APPROVAL">На согласовании</button>
          <button type="button" class="chip" data-my-filter="APPROVED">Подтвержденные</button>
          <button type="button" class="chip" data-my-filter="RESCHEDULED">Перенесенные</button>
          <button type="button" class="chip" data-my-filter="CLOSED">Закрытые</button>
        </div>
        <div id="myRequests" class="row"></div>
      </section>

      <section id="tab-admin" class="card hidden">
        <h2>Админ — настройки</h2>
        <div class="grid2">
          <label>Начало дня <input id="sStart" type="number" /></label>
          <label>Конец дня <input id="sEnd" type="number" /></label>
          <label>Буфер, мин <input id="sBuffer" type="number" /></label>
          <label>Лимит слотов <input id="sLimit" type="number" /></label>
          <label>Горизонт, дней <input id="sHorizon" type="number" /></label>
          <label>Опережение, ч <input id="sLead" type="number" /></label>
        </div>
        <label>Рабочие дни недели</label>
        <div class="weekday-grid" id="workdaysWrap">
          <label><input type="checkbox" data-workday="1" />Пн</label>
          <label><input type="checkbox" data-workday="2" />Вт</label>
          <label><input type="checkbox" data-workday="3" />Ср</label>
          <label><input type="checkbox" data-workday="4" />Чт</label>
          <label><input type="checkbox" data-workday="5" />Пт</label>
          <label><input type="checkbox" data-workday="6" />Сб</label>
          <label><input type="checkbox" data-workday="7" />Вс</label>
        </div>
        <div class="row">
          <button id="btnSaveSettings" class="lime">Сохранить настройки</button>
        </div>
        <h2>Google / OAuth</h2>
        <div class="oauth-status" id="oauthStatusBox">Загрузка статуса...</div>
        <button id="btnReloadOAuthStatus">Обновить статус</button>
        <hr style="border-color:#173049; opacity:.5; margin:12px 0" />
        <h2>Заявки</h2>
        <div class="chip-row" id="adminStatusFilters">
          <button type="button" class="chip active" data-admin-filter="">Все</button>
          <button type="button" class="chip" data-admin-filter="PENDING_APPROVAL">На согласовании</button>
          <button type="button" class="chip" data-admin-filter="APPROVED">Подтвержденные</button>
          <button type="button" class="chip" data-admin-filter="RESCHEDULED">Перенесенные</button>
          <button type="button" class="chip" data-admin-filter="REJECTED">Отклоненные</button>
          <button type="button" class="chip" data-admin-filter="CANCELLED">Отмененные</button>
          <button type="button" class="chip" data-admin-filter="EXPIRED">Истекшие</button>
        </div>
        <div class="grid2">
          <label>Статус
            <select id="aStatus">
              <option value="">Все</option>
              <option value="PENDING_APPROVAL">На согласовании</option>
              <option value="APPROVED">Подтвержденные</option>
              <option value="RESCHEDULED">Перенесенные</option>
              <option value="REJECTED">Отклоненные</option>
              <option value="CANCELLED">Отмененные</option>
              <option value="EXPIRED">Истекшие</option>
            </select>
          </label>
          <label>С даты
            <input id="aFrom" type="date" />
          </label>
          <label>По дату
            <input id="aTo" type="date" />
          </label>
          <label>Лимит
            <input id="aLimit" type="number" min="1" max="100" value="30" />
          </label>
          <label>Автоочистка, дней
            <input id="aAutoDays" type="number" min="1" max="365" value="7" />
          </label>
        </div>
        <div class="grid2">
          <label><input id="aAutoEnabled" type="checkbox" checked /> Автоочистка закрытых при открытии админки</label>
        </div>
        <div class="grid2">
          <button id="btnSelectClosed">Выбрать закрытые</button>
          <button id="btnClearSelected" class="danger">Очистить выбранные</button>
          <button id="btnClearClosed">Очистить закрытые по сроку</button>
          <button id="btnClearAllClosed" class="danger">Очистить все закрытые</button>
        </div>
        <button id="btnReloadAdmin">Обновить</button>
        <div id="adminRequests" class="row"></div>
      </section>
    </div>
  </div>

  <div id="replyModalBackdrop" class="modal-backdrop hidden">
    <div class="modal">
      <h3 id="replyModalTitle">Шаблон ответа</h3>
      <div id="replyTemplateList" class="template-grid"></div>
      <label>Текст ответа
        <textarea id="replyModalText"></textarea>
      </label>
      <div class="modal-actions">
        <button id="replyModalCancel">Отмена</button>
        <button id="replyModalSubmit" class="lime">Отправить</button>
      </div>
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
        newRequestProgress: document.getElementById('newRequestProgress'),
        newStep1: document.getElementById('newStep1'),
        newStep2: document.getElementById('newStep2'),
        newStep3: document.getElementById('newStep3'),
        newStep4: document.getElementById('newStep4'),
        myRequests: document.getElementById('myRequests'),
        myStatusFilters: document.getElementById('myStatusFilters'),
        adminStatusFilters: document.getElementById('adminStatusFilters'),
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
        btnSubmitRequest: document.getElementById('btnSubmitRequest'),
        newRequestHint: document.getElementById('newRequestHint'),
        locationWrap: document.getElementById('locationWrap'),
        sStart: document.getElementById('sStart'),
        sEnd: document.getElementById('sEnd'),
        sBuffer: document.getElementById('sBuffer'),
        sLimit: document.getElementById('sLimit'),
        sHorizon: document.getElementById('sHorizon'),
        sLead: document.getElementById('sLead'),
        workdaysWrap: document.getElementById('workdaysWrap'),
        oauthStatusBox: document.getElementById('oauthStatusBox'),
        aStatus: document.getElementById('aStatus'),
        aFrom: document.getElementById('aFrom'),
        aTo: document.getElementById('aTo'),
        aLimit: document.getElementById('aLimit'),
        aAutoDays: document.getElementById('aAutoDays'),
        aAutoEnabled: document.getElementById('aAutoEnabled')
      };
      const modalEls = {
        backdrop: document.getElementById('replyModalBackdrop'),
        title: document.getElementById('replyModalTitle'),
        templateList: document.getElementById('replyTemplateList'),
        text: document.getElementById('replyModalText'),
        cancel: document.getElementById('replyModalCancel'),
        submit: document.getElementById('replyModalSubmit')
      };

      let token = null;
      let role = 'user';
      let slotsCache = [];
      let selectedSlotIndex = null;
      let replyModalResolver = null;
      let adminSelectedRequestIds = new Set();
      let myStatusFilter = localStorage.getItem('miniapp_my_status_filter') || 'ALL';
      let adminStatusFilter = localStorage.getItem('miniapp_admin_status_filter') || '';

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

      const adminActionRules = {
        canApprove: (status) => status === 'PENDING_APPROVAL',
        canReject: (status) => status === 'PENDING_APPROVAL',
        canCancel: (status) => ['PENDING_APPROVAL', 'APPROVED', 'RESCHEDULE_REQUESTED', 'RESCHEDULED'].includes(status),
        canReschedule: (status) => ['APPROVED', 'RESCHEDULED'].includes(status)
      };
      const adminReplyTemplates = {
        approve: [
          'Здравствуйте! Подтверждаю вашу заявку «{topic}». Встреча состоится {date}. Буду рада встрече!',
          'Отлично, заявка «{topic}» подтверждена. Жду вас {date}. Если планы изменятся, напишите заранее.'
        ],
        reject: [
          'Здравствуйте! К сожалению, по заявке «{topic}» на {date} сейчас подтвердить встречу не могу. Предлагаю выбрать другой слот.',
          'Спасибо за заявку «{topic}». На {date} слот уже недоступен. Подберите, пожалуйста, другое время.'
        ],
        cancel: [
          'Здравствуйте! Вынуждена отменить заявку «{topic}» на {date}. Давайте подберем новое удобное время.',
          'По организационным причинам отменяю встречу «{topic}» ({date}). Напишите, и предложу новые варианты.'
        ],
        reschedule: [
          'Здравствуйте! Встречу по заявке «{topic}» перенесла. Новое время: {date}.',
          'Обновила время встречи по заявке «{topic}». Актуальный слот: {date}.'
        ]
      };

      function normalizeTopic(topic) {
        const t = (topic || '').trim();
        if (!t) return 'Без темы';
        const low = t.toLowerCase();
        if (low.includes('stage') || low.includes('stage9') || low.includes('stage10')) {
          return 'Тестовая заявка';
        }
        return t;
      }

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
        const headers = Object.assign({}, options.headers || {});
        if (options.body !== undefined && !headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
        if (token) headers['Authorization'] = 'Bearer ' + token;
        const response = await fetch(url, Object.assign({}, options, { headers }));
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok === false) {
          throw new Error(data.error || ('HTTP ' + response.status));
        }
        return data;
      }

      function showActionError(error) {
        const message = error && error.message ? error.message : 'Неизвестная ошибка';
        alert('Операция не выполнена: ' + message);
      }

      function applyTemplateVars(template, request) {
        return template
          .replaceAll('{topic}', normalizeTopic(request.topic))
          .replaceAll('{date}', formatDateRange(request.start_at, request.end_at));
      }

      function chooseAdminReply(action, request) {
        const options = adminReplyTemplates[action] || [];
        const actionTitles = {
          approve: 'Ответ при подтверждении',
          reject: 'Ответ при отклонении',
          cancel: 'Ответ при отмене',
          reschedule: 'Ответ при переносе'
        };

        if (!modalEls.backdrop || !modalEls.templateList || !modalEls.title || !modalEls.text) {
          const fallbackText = prompt((actionTitles[action] || 'Комментарий') + '\\n(Можно оставить пустым)', '');
          if (fallbackText === null) {
            return Promise.resolve({ cancelled: true, comment: null });
          }
          const trimmed = fallbackText.trim();
          return Promise.resolve({ cancelled: false, comment: trimmed ? trimmed : null });
        }

        return new Promise((resolve) => {
          replyModalResolver = resolve;
          modalEls.title.textContent = actionTitles[action] || 'Шаблон ответа';
          modalEls.templateList.innerHTML = '';
          modalEls.text.value = '';

          const noneBtn = document.createElement('button');
          noneBtn.type = 'button';
          noneBtn.className = 'template-btn active';
          noneBtn.textContent = 'Без шаблона';
          noneBtn.onclick = () => {
            modalEls.templateList.querySelectorAll('.template-btn').forEach((el) => el.classList.remove('active'));
            noneBtn.classList.add('active');
            modalEls.text.value = '';
          };
          modalEls.templateList.appendChild(noneBtn);

          options.forEach((template) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'template-btn';
            const rendered = applyTemplateVars(template, request);
            btn.textContent = rendered;
            btn.onclick = () => {
              modalEls.templateList.querySelectorAll('.template-btn').forEach((el) => el.classList.remove('active'));
              btn.classList.add('active');
              modalEls.text.value = rendered;
            };
            modalEls.templateList.appendChild(btn);
          });

          modalEls.backdrop.classList.remove('hidden');
          modalEls.text.focus();
        });
      }

      function switchTab(tab) {
        document.querySelectorAll('.tabs button[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
        ['home','new','my','admin'].forEach((t) => {
          const el = document.getElementById('tab-' + t);
          if (!el) return;
          el.classList.toggle('hidden', t !== tab);
        });
      }

      function updateNewRequestProgress() {
        const hasFormat = Boolean((els.fDuration.value || '').trim() && (els.fFormat.value || '').trim());
        const hasSlot = selectedSlotIndex !== null;
        const hasContacts = Boolean(
          (els.fFirstName.value || '').trim() &&
          (els.fLastName.value || '').trim() &&
          (els.fEmail.value || '').trim() &&
          (els.fTopic.value || '').trim()
        );

        let step = 1;
        if (hasFormat) step = 2;
        if (hasFormat && hasSlot) step = 3;
        if (hasFormat && hasSlot && hasContacts) step = 4;

        els.newRequestProgress.querySelectorAll('button[data-new-step]').forEach((node) => {
          const nodeStep = Number(node.getAttribute('data-new-step') || '1');
          node.classList.toggle('active', nodeStep === step);
        });

        const missing = [];
        if (!hasFormat) missing.push('выберите формат и длительность');
        if (!hasSlot) missing.push('выберите слот');
        if (!hasContacts) missing.push('заполните имя, фамилию, email и тему');
        if (els.fFormat.value === 'OFFLINE' && !(els.fLocation.value || '').trim()) {
          missing.push('укажите место встречи');
        }
        const isReady = missing.length === 0;
        els.btnSubmitRequest.disabled = !isReady;
        els.newRequestHint.textContent = isReady
          ? 'Готово к отправке.'
          : 'До отправки: ' + missing[0] + '.';
      }

      async function ensureAdminUnlocked() {
        return role === 'admin';
      }

      const AUTO_CLEAN_DAYS = 21;
      const AUTO_CLEAN_STATUSES = new Set(['REJECTED', 'CANCELLED', 'EXPIRED']);
      const MANUAL_CLEAN_STATUSES = new Set(['REJECTED', 'CANCELLED', 'EXPIRED']);

      function shouldAutoHideRequest(r, mode) {
        if (mode !== 'admin' && mode !== 'my') return false;
        if (!AUTO_CLEAN_STATUSES.has(String(r.status || ''))) return false;

        const endAt = new Date(r.end_at);
        if (Number.isNaN(endAt.getTime())) return false;
        const threshold = Date.now() - AUTO_CLEAN_DAYS * 24 * 60 * 60 * 1000;
        return endAt.getTime() < threshold;
      }

      function renderRequests(container, requests, mode) {
        container.innerHTML = '';
        const visibleRequests = (requests || []).filter((r) => !shouldAutoHideRequest(r, mode));
        if (!visibleRequests.length) {
          container.innerHTML = '<div class="muted">Пусто</div>';
          return;
        }

        const groups = mode === 'admin' || mode === 'my'
          ? [
              { key: 'PENDING_APPROVAL', title: 'На согласовании' },
              { key: 'APPROVED', title: 'Подтвержденные' },
              { key: 'RESCHEDULED', title: 'Перенесенные' },
              { key: 'REJECTED', title: 'Отклоненные' },
              { key: 'CANCELLED', title: 'Отмененные' },
              { key: 'EXPIRED', title: 'Истекшие' }
            ]
          : [];

        const renderCard = (r) => {
          const node = document.createElement('div');
          node.className = 'request';
          const statusLabel = statusLabels[r.status] || r.status;
          const canManualClean = mode === 'admin' && MANUAL_CLEAN_STATUSES.has(String(r.status || ''));
          const isSelected = canManualClean && adminSelectedRequestIds.has(r.id);
          const selectionHtml = canManualClean
            ? '<label><input class="request-select" type="checkbox" data-request-select="' + r.id + '"' + (isSelected ? ' checked' : '') + ' />в очистку</label>'
            : '';
          const meetLinkHtml = typeof r.google_meet_link === 'string' && r.google_meet_link.trim()
            ? '<a class="small-link" href="' + r.google_meet_link + '" target="_blank" rel="noopener noreferrer">Ссылка на встречу</a>'
            : '';
          node.innerHTML = [
            '<div class="request-head"><div class="request-title">' + selectionHtml + '<span class="pill">' + statusLabel + '</span> <strong>' + normalizeTopic(r.topic) + '</strong></div></div>',
            '<div class="small muted">' + formatDateRange(r.start_at, r.end_at) + '</div>',
            meetLinkHtml ? ('<div class="small">' + meetLinkHtml + '</div>') : '',
            '<div class="actions"></div>'
          ].join('');
          const actions = node.querySelector('.actions');
          if (canManualClean) {
            const cb = node.querySelector('input[data-request-select]');
            if (cb) {
              cb.addEventListener('change', (event) => {
                if (event.target.checked) {
                  adminSelectedRequestIds.add(r.id);
                } else {
                  adminSelectedRequestIds.delete(r.id);
                }
              });
            }
          }

          if (mode === 'my') {
            if (r.can_cancel) {
              const cancelBtn = document.createElement('button');
              cancelBtn.textContent = 'Отменить';
              cancelBtn.className = 'danger';
              cancelBtn.onclick = async () => {
                try {
                  await api('/api/webapp/requests/' + r.id + '/cancel', { method: 'POST', body: '{}' });
                  await loadMyRequests();
                } catch (error) {
                  showActionError(error);
                  await loadMyRequests();
                }
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
                try {
                  await api('/api/webapp/requests/' + r.id + '/reschedule', {
                    method: 'POST',
                    body: JSON.stringify({ start_at: start, end_at: end })
                  });
                  await loadMyRequests();
                } catch (error) {
                  showActionError(error);
                  await loadMyRequests();
                }
              };
              actions.appendChild(rsBtn);
            }
          }

          if (mode === 'admin') {
            const adminButtons = [
              {
                text: 'Подтвердить',
                className: 'lime',
                enabled: adminActionRules.canApprove(r.status),
                run: async () => {
                  const reply = await chooseAdminReply('approve', r);
                  if (reply.cancelled) return;
                  await api('/api/webapp/admin/requests/' + r.id + '/approve', {
                    method: 'POST',
                    body: JSON.stringify({ comment: reply.comment })
                  });
                }
              },
              {
                text: 'Отклонить',
                className: 'danger',
                enabled: adminActionRules.canReject(r.status),
                run: async () => {
                  const reply = await chooseAdminReply('reject', r);
                  if (reply.cancelled) return;
                  await api('/api/webapp/admin/requests/' + r.id + '/reject', {
                    method: 'POST',
                    body: JSON.stringify({ comment: reply.comment })
                  });
                }
              },
              {
                text: 'Отменить',
                className: '',
                enabled: adminActionRules.canCancel(r.status),
                run: async () => {
                  const reply = await chooseAdminReply('cancel', r);
                  if (reply.cancelled) return;
                  await api('/api/webapp/admin/requests/' + r.id + '/cancel', {
                    method: 'POST',
                    body: JSON.stringify({ comment: reply.comment })
                  });
                }
              },
              {
                text: 'Перенести',
                className: '',
                enabled: adminActionRules.canReschedule(r.status),
                run: async () => {
                  const start = prompt('Новый start_at ISO', r.start_at);
                  const end = prompt('Новый end_at ISO', r.end_at);
                  if (!start || !end) return;
                  const reply = await chooseAdminReply('reschedule', r);
                  if (reply.cancelled) return;
                  await api('/api/webapp/admin/requests/' + r.id + '/reschedule', {
                    method: 'POST',
                    body: JSON.stringify({ start_at: start, end_at: end, comment: reply.comment })
                  });
                }
              }
            ];

            adminButtons.forEach((cfg) => {
              const btn = document.createElement('button');
              btn.textContent = cfg.text;
              btn.className = (cfg.className + (cfg.enabled ? '' : ' ghost')).trim();
              btn.disabled = !cfg.enabled;
              if (!cfg.enabled) {
                actions.appendChild(btn);
                return;
              }
              btn.onclick = async () => {
                try {
                  await cfg.run();
                  await loadAdminRequests();
                } catch (error) {
                  showActionError(error);
                  await loadAdminRequests();
                }
              };
              actions.appendChild(btn);
            });
          }
          return node;
        };

        if (mode !== 'admin' && mode !== 'my') {
          visibleRequests.forEach((r) => container.appendChild(renderCard(r)));
          return;
        }

        groups.forEach((group, index) => {
          const subset = visibleRequests.filter((r) => r.status === group.key);
          if (!subset.length) return;
          const details = document.createElement('details');
          details.className = 'group';
          if (index === 0) details.open = true;
          details.innerHTML = '<summary>' + group.title + '<span class="group-count">(' + subset.length + ')</span></summary>';
          subset.forEach((r) => details.appendChild(renderCard(r)));
          container.appendChild(details);
        });
      }

      async function loadMyRequests() {
        const data = await api('/api/webapp/requests/my');
        const all = data.requests || [];
        const filtered = all.filter((r) => {
          if (myStatusFilter === 'ALL') return true;
          if (myStatusFilter === 'CLOSED') {
            return ['REJECTED', 'CANCELLED', 'EXPIRED'].includes(String(r.status || ''));
          }
          return r.status === myStatusFilter;
        });
        renderRequests(els.myRequests, filtered, 'my');
      }

      async function loadAdminRequests() {
        if (role !== 'admin') return;
        const params = new URLSearchParams();
        const status = (adminStatusFilter || els.aStatus.value || '').trim();
        const from = (els.aFrom.value || '').trim();
        const to = (els.aTo.value || '').trim();
        const limitRaw = Number(els.aLimit.value || 30);
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.floor(limitRaw))) : 30;

        params.set('limit', String(limit));
        if (status) params.set('status', status);
        if (from) params.set('from', new Date(from + 'T00:00:00.000Z').toISOString());
        if (to) params.set('to', new Date(to + 'T23:59:59.999Z').toISOString());

        const data = await api('/api/webapp/admin/requests?' + params.toString());
        renderRequests(els.adminRequests, data.requests || [], 'admin');
      }

      async function cleanupRequests(mode, olderThanDays) {
        const payload = { mode };
        if (mode === 'selected') {
          payload.ids = [...adminSelectedRequestIds];
        } else if (typeof olderThanDays === 'number') {
          payload.older_than_days = olderThanDays;
        }

        return api('/api/webapp/admin/requests/cleanup', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
      }

      async function runAutoCleanupIfEnabled() {
        if (role !== 'admin') return;
        if (!els.aAutoEnabled.checked) return;

        const daysRaw = Number(els.aAutoDays.value || 7);
        const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(365, Math.floor(daysRaw))) : 7;
        const markerKey = 'miniapp_auto_cleanup_last_run';
        const lastRun = Number(localStorage.getItem(markerKey) || 0);
        const now = Date.now();
        if (now - lastRun < 12 * 60 * 60 * 1000) return;

        await cleanupRequests('closed', days);
        localStorage.setItem(markerKey, String(now));
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
        const selectedWorkdays = new Set(Array.isArray(s.workdays) ? s.workdays : [1, 2, 3, 4, 5]);
        els.workdaysWrap.querySelectorAll('input[data-workday]').forEach((node) => {
          const checkbox = node;
          const day = Number(checkbox.getAttribute('data-workday'));
          checkbox.checked = selectedWorkdays.has(day);
        });
      }

      async function loadGoogleOAuthStatus() {
        if (role !== 'admin') return;
        try {
          const data = await api('/api/webapp/admin/google/status');
          const status = data.status || {};
          const connected = Boolean(status.connected);
          const badge = connected
            ? '<span class="oauth-badge ok">Подключено</span>'
            : '<span class="oauth-badge err">Ошибка подключения</span>';
          const lines = [
            badge,
            '<div><strong>Calendar ID:</strong> ' + (status.calendar_id || '-') + '</div>'
          ];
          if (!connected && status.error_message) {
            lines.push('<div class="err"><strong>Ошибка:</strong> ' + status.error_message + '</div>');
          }
          els.oauthStatusBox.innerHTML = lines.join('');
        } catch (error) {
          els.oauthStatusBox.innerHTML =
            '<span class="oauth-badge err">Ошибка подключения</span><div class="err">Не удалось получить статус OAuth</div>';
        }
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
          '<div class="muted">@' + (user.username || '-') + ' / роль: ' + (role === 'admin' ? 'админ' : 'пользователь') + '</div>',
          '<div class="hero">' +
            '<div class="hero-intro">' +
              '<img class="hero-photo" src="/miniapp/assets/home-photo.jpeg" alt="Фото консультанта" />' +
              '<div>' +
                '<strong>Запись на консультацию к Екатерине</strong>' +
                '<div class="small muted">Онлайн-запись на консультации и разборы.</div>' +
              '</div>' +
            '</div>' +
            '<ul class="hero-list">' +
              '<li>Быстро выбирайте удобный слот без переписки.</li>' +
              '<li>Отслеживайте статус заявки в одном месте.</li>' +
              '<li>Консультации: AI-вайбкодинг и финансовое планирование с ИИ.</li>' +
            '</ul>' +
            '<div class="hero-quick">' +
              '<button id="homeGoNew" type="button"><strong>Новая заявка</strong><span>Записаться на консультацию</span></button>' +
              '<button id="homeGoMy" type="button"><strong>Мои заявки</strong><span>Проверить статусы и действия</span></button>' +
            '</div>' +
          '</div>'
        ].join('');

        const homeGoNew = document.getElementById('homeGoNew');
        if (homeGoNew) homeGoNew.addEventListener('click', () => switchTab('new'));
        const homeGoMy = document.getElementById('homeGoMy');
        if (homeGoMy) homeGoMy.addEventListener('click', async () => {
          switchTab('my');
          await loadMyRequests();
        });

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
        updateNewRequestProgress();
        els.myStatusFilters.querySelectorAll('button[data-my-filter]').forEach((node) => {
          const value = node.getAttribute('data-my-filter') || 'ALL';
          node.classList.toggle('active', value === myStatusFilter);
        });
        els.adminStatusFilters.querySelectorAll('button[data-admin-filter]').forEach((node) => {
          const value = node.getAttribute('data-admin-filter') || '';
          node.classList.toggle('active', value === adminStatusFilter);
        });
        els.aStatus.value = adminStatusFilter;

        await loadMyRequests();

        els.appRoot.classList.remove('hidden');
        setStatus(browserDevMode ? 'Подключено (локальный режим)' : 'Подключено', 'ok');
      }

      document.querySelectorAll('.tabs button[data-tab]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (btn.dataset.tab === 'admin') {
            const unlocked = await ensureAdminUnlocked();
            if (!unlocked) return;
            await runAutoCleanupIfEnabled();
            await loadAdminRequests();
            await loadAdminSettings();
            await loadGoogleOAuthStatus();
          }
          switchTab(btn.dataset.tab);
        });
      });

      els.fFormat.addEventListener('change', () => {
        els.locationWrap.classList.toggle('hidden', els.fFormat.value !== 'OFFLINE');
        updateNewRequestProgress();
      });
      els.newRequestProgress.querySelectorAll('button[data-new-step]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const step = btn.getAttribute('data-new-step') || '1';
          const target = document.getElementById('newStep' + step);
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });
      els.fDuration.addEventListener('change', updateNewRequestProgress);
      ['fFirstName', 'fLastName', 'fEmail', 'fTopic', 'fLocation'].forEach((id) => {
        const input = document.getElementById(id);
        input.addEventListener('input', updateNewRequestProgress);
      });

      document.getElementById('btnLoadSlots').addEventListener('click', async () => {
        const toMoscowDate = (iso) => new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000);
        const fmtDay = (date) => new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' }).format(date);
        const weekKey = (iso) => {
          const d = toMoscowDate(iso);
          const day = d.getUTCDay() || 7;
          const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (day - 1)));
          const sunday = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + 6));
          return {
            id: monday.toISOString().slice(0, 10),
            label: 'Неделя ' + fmtDay(monday) + ' - ' + fmtDay(sunday)
          };
        };

        const duration = Number(els.fDuration.value || 30);
        const data = await api('/api/webapp/slots?duration=' + duration);
        slotsCache = data.slots || [];
        selectedSlotIndex = null;
        updateNewRequestProgress();
        els.fSlot.innerHTML = '';

        if (!slotsCache.length) {
          els.fSlot.innerHTML = '<div class="muted">Свободных слотов нет.</div>';
          return;
        }

        const grouped = new Map();
        slotsCache.forEach((slot, index) => {
          const wk = weekKey(slot.start_at);
          if (!grouped.has(wk.id)) grouped.set(wk.id, { label: wk.label, items: [] });
          grouped.get(wk.id).items.push({ slot, index });
        });

        [...grouped.values()].forEach((week, weekIndex) => {
          const details = document.createElement('details');
          details.className = 'group';
          if (weekIndex === 0) details.open = true;
          details.innerHTML = '<summary>' + week.label + '<span class="group-count">(' + week.items.length + ')</span></summary>';
          const days = new Map();
          week.items.forEach((item) => {
            const parts = formatDateParts(item.slot.start_at);
            const key = parts.date;
            if (!days.has(key)) days.set(key, []);
            days.get(key).push(item);
          });

          [...days.entries()].forEach(([dayLabel, dayItems]) => {
            const dayWrap = document.createElement('div');
            dayWrap.className = 'slot-day-group';
            dayWrap.innerHTML = '<div class="slot-day-title">' + dayLabel + '</div>';

            const grid = document.createElement('div');
            grid.className = 'slot-time-grid';
            dayItems.forEach(({ slot, index }) => {
              const btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'slot-item';
              const start = formatDateParts(slot.start_at);
              const end = formatDateParts(slot.end_at);
              btn.innerHTML = '<div class="slot-time">' + start.time + '–' + end.time + '</div>';
              btn.onclick = () => {
                selectedSlotIndex = index;
                els.fSlot.querySelectorAll('.slot-item').forEach((n) => n.classList.remove('active'));
                btn.classList.add('active');
                updateNewRequestProgress();
              };
              grid.appendChild(btn);
            });
            dayWrap.appendChild(grid);
            details.appendChild(dayWrap);
          });
          els.fSlot.appendChild(details);
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
        selectedSlotIndex = null;
        slotsCache = [];
        els.fSlot.innerHTML = '<div class="muted">Слоты пока не загружены.</div>';
        els.fTopic.value = '';
        els.fDescription.value = '';
        els.fLocation.value = '';
        updateNewRequestProgress();
        alert('Заявка отправлена');
        switchTab('my');
        await loadMyRequests();
      });

      document.getElementById('btnReloadMy').addEventListener('click', () => loadMyRequests());
      els.myStatusFilters.querySelectorAll('button[data-my-filter]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          myStatusFilter = btn.getAttribute('data-my-filter') || 'ALL';
          localStorage.setItem('miniapp_my_status_filter', myStatusFilter);
          els.myStatusFilters.querySelectorAll('button[data-my-filter]').forEach((node) => {
            node.classList.toggle('active', node === btn);
          });
          await loadMyRequests();
        });
      });
      els.adminStatusFilters.querySelectorAll('button[data-admin-filter]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          adminStatusFilter = btn.getAttribute('data-admin-filter') || '';
          localStorage.setItem('miniapp_admin_status_filter', adminStatusFilter);
          els.aStatus.value = adminStatusFilter;
          els.adminStatusFilters.querySelectorAll('button[data-admin-filter]').forEach((node) => {
            node.classList.toggle('active', node === btn);
          });
          await loadAdminRequests();
        });
      });
      els.aStatus.addEventListener('change', async () => {
        adminStatusFilter = (els.aStatus.value || '').trim();
        localStorage.setItem('miniapp_admin_status_filter', adminStatusFilter);
        els.adminStatusFilters.querySelectorAll('button[data-admin-filter]').forEach((node) => {
          const value = node.getAttribute('data-admin-filter') || '';
          node.classList.toggle('active', value === adminStatusFilter);
        });
        await loadAdminRequests();
      });
      document.getElementById('btnReloadAdmin').addEventListener('click', () => loadAdminRequests());
      document.getElementById('btnSelectClosed').addEventListener('click', async () => {
        const data = await api('/api/webapp/admin/requests?limit=100');
        const requests = data.requests || [];
        adminSelectedRequestIds = new Set(
          requests.filter((r) => MANUAL_CLEAN_STATUSES.has(String(r.status || ''))).map((r) => r.id)
        );
        await loadAdminRequests();
      });
      document.getElementById('btnClearSelected').addEventListener('click', async () => {
        if (!adminSelectedRequestIds.size) {
          alert('Нет выбранных заявок для очистки');
          return;
        }
        if (!confirm('Удалить выбранные закрытые заявки без возможности восстановления?')) return;
        const data = await cleanupRequests('selected');
        adminSelectedRequestIds.clear();
        alert('Удалено: ' + (data.deleted_count || 0));
        await loadAdminRequests();
      });
      document.getElementById('btnClearClosed').addEventListener('click', async () => {
        const daysRaw = Number(els.aAutoDays.value || 7);
        const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(365, Math.floor(daysRaw))) : 7;
        if (!confirm('Удалить закрытые заявки старше ' + days + ' дней?')) return;
        const data = await cleanupRequests('closed', days);
        adminSelectedRequestIds.clear();
        alert('Удалено: ' + (data.deleted_count || 0));
        await loadAdminRequests();
      });
      document.getElementById('btnClearAllClosed').addEventListener('click', async () => {
        if (!confirm('Удалить все закрытые заявки? Действие необратимо.')) return;
        const data = await cleanupRequests('closed', 0);
        adminSelectedRequestIds.clear();
        alert('Удалено: ' + (data.deleted_count || 0));
        await loadAdminRequests();
      });

      document.getElementById('btnSaveSettings').addEventListener('click', async () => {
        const workdays = [];
        els.workdaysWrap.querySelectorAll('input[data-workday]').forEach((node) => {
          if (node.checked) {
            workdays.push(Number(node.getAttribute('data-workday')));
          }
        });
        if (!workdays.length) {
          alert('Выберите хотя бы один рабочий день');
          return;
        }
        await api('/api/webapp/admin/settings', {
          method: 'PATCH',
          body: JSON.stringify({
            workday_start_hour: Number(els.sStart.value),
            workday_end_hour: Number(els.sEnd.value),
            workdays,
            slot_buffer_minutes: Number(els.sBuffer.value),
            slot_limit: Number(els.sLimit.value),
            slot_horizon_days: Number(els.sHorizon.value),
            slot_min_lead_hours: Number(els.sLead.value)
          })
        });
        alert('Настройки сохранены');
      });
      document.getElementById('btnReloadOAuthStatus').addEventListener('click', async () => {
        await loadGoogleOAuthStatus();
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

      function closeReplyModal(payload) {
        modalEls.backdrop.classList.add('hidden');
        const resolver = replyModalResolver;
        replyModalResolver = null;
        if (resolver) resolver(payload);
      }

      modalEls.cancel.addEventListener('click', () => closeReplyModal({ cancelled: true, comment: null }));
      modalEls.submit.addEventListener('click', () => {
        const text = modalEls.text.value.trim();
        closeReplyModal({ cancelled: false, comment: text ? text : null });
      });
      modalEls.backdrop.addEventListener('click', (event) => {
        if (event.target === modalEls.backdrop) {
          closeReplyModal({ cancelled: true, comment: null });
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

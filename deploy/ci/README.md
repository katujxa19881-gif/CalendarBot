# Автодеплой через GitHub Actions

## Что уже автоматизировано
1. На каждый push в `main` запускается workflow `.github/workflows/deploy.yml`.
2. Workflow проверяет сборку (`npm ci` + `npm run build`).
3. Workflow проверяет, что `dist` актуален и закоммичен.
4. После успешной проверки идет SSH-подключение на сервер и деплой:
   - `git fetch`
   - `git checkout main`
   - `git reset --hard origin/main`
   - `docker compose up -d --build`

## Что нужно сделать вручную один раз
1. В GitHub репозитории откройте:
   - `Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`
2. Добавьте секреты:
   - `DEPLOY_HOST` = `45.134.15.201`
   - `DEPLOY_USER` = `root`
   - `DEPLOY_SSH_KEY` = приватный SSH-ключ, который имеет доступ к серверу

## Как получить DEPLOY_SSH_KEY
1. На вашем Mac (локально) создайте отдельный ключ для GitHub Actions:
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/calendarbot_actions -C "calendarbot-actions"
   ```
2. Добавьте **публичный** ключ на сервер в `~/.ssh/authorized_keys` пользователя `root`:
   ```bash
   cat ~/.ssh/calendarbot_actions.pub | ssh root@45.134.15.201 'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys'
   ```
3. Откройте файл `~/.ssh/calendarbot_actions` и скопируйте весь приватный ключ.
4. Вставьте его как значение секрета `DEPLOY_SSH_KEY` в GitHub.

## Проверка
1. Сделайте коммит в `main`.
2. Откройте `Actions` в GitHub и проверьте workflow `Deploy CalendarBot`.
3. После статуса `success` на сервере должна быть новая версия контейнера.

## Важно
1. Пока деплой собирается из `dist`, перед пушем всегда выполняйте:
   ```bash
   npm run build
   git add -f dist
   git commit -m "update dist"
   ```
2. Если `dist` не обновлен, workflow остановится на шаге `Ensure dist is committed`.

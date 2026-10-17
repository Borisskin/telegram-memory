# Разработка

Код — TypeScript на Node.js 24 без сборки: файлы запускаются с `--experimental-strip-types`. Зависимостей во время работы нет, кроме Obsidian Web Clipper внутри образа; `typescript` и `@types/node` нужны только для проверки типов.

```bash
npm install
npm run typecheck   # tsc --noEmit по src/ и test/
npm test            # node --test test/*.test.ts
```

Тесты не ходят в сеть и не требуют Docker: Telegram, OpenViking, NotebookLM, Bot API и модель заменены подделками. Реальные данные и живые службы в быстрых проверках не используются.

## Устройство кода

| Модуль | Ответственность |
|---|---|
| `src/archive.ts` | Архив: пути, YAML, редакции, история, атомарная запись, журнал операций, очередь проекции |
| `src/access.ts` | Принципалы, таблица «роль → средства», области поиска, токены чтения |
| `src/coordinator.ts` | MCP-средства координатора, задания сбора, доступ групп, оповещения, расписание сводок |
| `src/inbox.ts` | Разбор входящего сообщения Приёмщика: заметка, пересылка, ссылка, предложения подключения |
| `src/digest.ts`, `src/notebook.ts` | Сводки и шов NotebookLM |
| `src/integrations.ts`, `src/clipper.ts` | Проекция в OpenViking, поиск и чтение, приём веб-страниц |
| `src/server/` | HTTP-сервер MCP и адаптеры внешних служб: OpenViking, telegram-mcp, загрузка страниц |
| `src/bots/` | Процесс ботов: long polling Bot API, Приёмщик, Собеседник, сводки |

Внешние службы подключаются через швы с боевым адаптером и подделкой: `TelegramGateway`, клиент OpenViking, `NotebookGateway`, Bot API, клиент модели, клиент координатора. Подделки живут только на этих швах.

## Правила

- Проверяется внешнее поведение: ответ MCP-средства, файлы архива, вызовы подделок. Основной стык тестов — MCP-обработчик координатора с токенами принципалов.
- Формы ответов поставщиков берутся из их исходников закреплённой версии ([перечень](vendors.md)), подделки повторяют реальную форму. Прошлая ошибка этого рода: подделка `get_messages` отдавала JSON, а настоящий telegram-mcp — текст, и живой сбор был бы пустым.
- Новый модуль, который импортирует сервер, должен попасть в образ: тест `coordinator-docker-imports` проверяет, что все импорты `src/server/coordinator-server.mjs` копируются Dockerfile.
- Контракт MCP версии `1`: средства только добавляются, форма существующих ответов не меняется.
- Формат архива версии `1`: новые поля только необязательные; изменение смысла поля или правила пути требует новой версии и явного преобразования на копии.
- Секреты не пишутся в журналы, ответы и Markdown; журнал ботов не содержит текста сообщений.

## Проверка образа

После изменения `src/server/` или Dockerfile полезно собрать образ и убедиться, что сервер доходит до чтения секретов, а не падает на импорте. Параметры сборки берутся из `config/vendors.json`; вручную (Git Bash, из корня репозитория):

```bash
v() { node -p "require('./config/vendors.json')['$1']['$2']"; }
docker build -t telegram-memory/coordinator:dev -f docker/coordinator.Dockerfile \
  --build-arg NODE_IMAGE="$(v node image)" \
  --build-arg OBSIDIAN_CLIPPER_REPO="$(v obsidian-clipper repo)" \
  --build-arg OBSIDIAN_CLIPPER_COMMIT="$(v obsidian-clipper commit)" .
docker run --rm --network none telegram-memory/coordinator:dev
# ожидается: ENOENT … /run/secrets/coordinator_mcp_token
```

Скрипты развёртывания проверяются в тестовой среде в локальном Docker ([развёртывание](deployment.md#тестовая-среда-в-локальном-docker)); `npm test` их не вызывает.

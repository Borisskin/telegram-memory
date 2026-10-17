# Поставщики и контракты

Готовые продукты используются без изменений. Исходники берутся из форков `github.com/Borisskin/*` — зеркал без правок — по закреплённым коммитам релизов. Коммиты и дайджесты записаны только в `config/vendors.json`: `update.sh` передаёт их в Dockerfile параметрами сборки и ставит в метки образов `com.telegram-memory.vendor.<поставщик>.commit`, а `check-deploy.sh` сверяет метки с перечнем. Значений по умолчанию в Dockerfile нет, поэтому собрать образ в обход перечня нельзя.

| Поставщик | Версия | Форк | Как используется |
|---|---|---|---|
| [telegram-mcp](https://github.com/chigwell/telegram-mcp) | `v3.2.62` | `Borisskin/telegram-mcp` | Базовый образ контейнера `telegram-mcp`; собирается из форка по Dockerfile поставщика |
| [notebooklm-mcp-cli](https://github.com/jacob-bd/gemini-notebook-mcp-cli) | `0.15.5` | `Borisskin/gemini-notebook-mcp-cli` | Второй MCP-сервер в образе `telegram-mcp`, ставится из форка, не из PyPI |
| [Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper) | коммит `6d56d61` | `Borisskin/obsidian-clipper` | Библиотека внутри образа координатора: HTML → Markdown |
| [OpenViking](https://github.com/volcengine/OpenViking) | `v0.4.23` | — | Официальный образ `ghcr.io/volcengine/openviking` по дайджесту |
| `node` | `24.17.0-bookworm-slim` | — | Базовый образ координатора, по дайджесту |

`python` в базовом образе telegram-mcp закреплён тегом из Dockerfile форка: закрепить его по дайджесту можно только правкой форка ([планы](roadmap.md)).

## Переход на новые коммиты

1. Синхронизировать форк с поставщиком и выбрать коммит релиза.
2. Сверить по исходникам нового коммита средства, которыми пользуется координатор (таблицы ниже): для telegram-mcp — сигнатуры и поля ответа `list_messages` (`id`, `sender`, `date`, `text`), для notebooklm-mcp-cli — шесть средств, для OpenViking — средства MCP. Сверка по подделкам в тестах не считается.
3. Поменять коммит (или дайджест) и версию в `config/vendors.json`, закоммитить.
4. `sudo scripts/update.sh` соберёт новые образы: метка коммита проекта изменилась.

Дайджест образа: `docker buildx imagetools inspect <образ>:<тег>` — строка `Digest`.

## telegram-mcp

Streamable HTTP `http://telegram-mcp:8765/mcp`, порт наружу не публикуется. Включены `TELEGRAM_EXPOSED_TOOLS=read-only+download_media` (без добавки поставщик скрывает `download_media`, у него нет пометки «только чтение») и `TELEGRAM_TRANSCRIBE=off`. Координатор вызывает:

| Средство | Для чего |
|---|---|
| `resolve_username(username)`, `get_chat(chat_id)` | Разрешить ссылку в источник: `chat_id`, вид, название |
| `list_messages(chat_id, limit?, search_query?, from_date?, to_date?)` | Сбор сообщений и текст сводок. Ответ — JSON `{"results": […]}`; пустая выборка — текст «No messages found matching the criteria.» |
| `list_chats(chat_type, limit)` | 10 последних групп для `/digest` |
| `download_media(chat_id, message_id, file_path?)` | Фото источников с включённой настройкой, только под `/exchange`. Ответ — текст «Media downloaded to <путь>.»; расширение поставщик подставляет сам, поэтому путь берётся из ответа |

Поле `media` ответа `list_messages` (`photo`, `document: <имя>`, `video`, `voice`, `sticker …` и др.) становится пометкой о вложении или поводом скачать фото. `get_messages` возвращает форматированный текст, а не JSON, поэтому для сбора не используется. `mark_as_read` в режиме `read-only` не публикуется — сообщения не отмечаются прочитанными.

Точка входа контейнера `docker/telegram-entrypoint.sh` (копируется в образ при сборке) читает Docker secrets и передаёт их процессам переменными окружения; оба MCP-сервера запускаются вместе, выход любого завершает контейнер, перезапуск делает политика `restart`.

## notebooklm-mcp

Streamable HTTP `http://telegram-mcp:8766/mcp`, проверка `GET /health`. Состояние `nlm` (обновляемые куки, CSRF) — в `/app/data/nlm` на томе `telegram_data`.

| Средство | Входы | Успешный ответ |
|---|---|---|
| `notebook_create` | `title?` | `{status: "success", notebook_id, …}` |
| `source_add` | `notebook_id`, `source_type: "text"`, `text`, `title?`, `wait?` | `{status: "success", source_id, ready, …}` |
| `notebook_query` | `notebook_id`, `query`, `timeout?` | `{status: "success", answer, …}` |
| `notebook_delete` | `notebook_id`, `confirm: true` | `{status: "success"}`; без `confirm` удаления нет |
| `refresh_auth` | — | `success`, либо `status: "expired"` — куки устарели |
| `usage_get` | — | `windows: [{percent_remaining, resets_at}]` — лимиты и время сброса |

Ошибки — `{status: "error", error, hint?}`. Координатор различает устаревший вход и исчерпанный лимит по `refresh_auth` и `usage_get`.

## OpenViking

HTTP MCP `http://openviking:1933/mcp`, ключ — `X-API-Key` или `Authorization: Bearer`. Конфигурация `ov.conf` приходит секретом целиком.

- Запись текста — `write(uri, content, mode: "replace", wait: true)`; ответ с `isError: true` считается неуспехом.
- Вложение — только форматы из `config/openviking-formats.json` (расширения зарегистрированных парсеров v0.4.23, при обновлении OpenViking сверить заново) — `add_resource(path, to: uri)`, затем загрузка файла `multipart/form-data` на выданный адрес `/api/v1/resources/temp_upload` того же узла.
- Удаление из индекса — `forget(uri)`.
- Поиск — `find` или `search(mode: "list")` с ограничением `target_uri`; `search(mode: "context")` не используется. Ответ `search` — текст, координатор разбирает его в список URI.
- Чтение — `read(uris)` только для адреса, выданного координатором.

Импорт асинхронный, отдельного средства проверки задания поставщик не обещает: координатор ждёт штатный результат `wait: true`.

## Obsidian Web Clipper

Программный интерфейс `dist/api.mjs` с разборщиком linkedom и Defuddle собирается нашим сценарием `docker/build-clipper-api.mjs` при сборке образа координатора. Сборка поставщика оставляет Defuddle внешним модулем, а Node не может взять именованный экспорт из его CommonJS-модуля, поэтому наша сборка кладёт Defuddle внутрь. `update.sh` после сборки проверяет, что Clipper превращает тестовую страницу в Markdown. Браузерное расширение и настольный Obsidian не нужны.

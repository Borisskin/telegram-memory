# Развёртывание

Система ставится на сервер Ubuntu 24 из репозитория и обновляется одной командой. Состав — четыре контейнера из `compose.yaml`: `coordinator`, `bots`, `telegram-mcp`, `openviking` ([архитектура](architecture.md)). Образы проекта собираются на сервере из закреплённых коммитов поставщиков ([поставщики](vendors.md)); готовыми из реестров берутся только базовые `node` и `python` и образ OpenViking.

Управление — четыре скрипта bash в `scripts/`. Их же будет вызывать будущая админка.

| Скрипт | Что делает |
|---|---|
| `config-setup.sh` | Настройки ботов: адрес прокси модели и модель Собеседника «общий» |
| `secrets-setup.sh [--cookies <файл>]` | Секреты: внешние спрашивает, внутренние вычисляет |
| `update.sh [--force]` | Первая установка и обновление: Docker, сборка, проверка, запуск |
| `check-deploy.sh` | Проверка состава без запуска контейнеров |

## Требования

- Ubuntu 24, 2 ядра, 4 ГБ памяти, `sudo`. Если Docker не установлен, его поставит `update.sh`.
- Сеть при сборке: GitHub (форки поставщиков), Docker Hub (`node`, `python`), GHCR (OpenViking), npm и PyPI (зависимости сборки). Если Docker Hub недоступен, `update.sh` сам настраивает зеркало реестра; у GHCR и GitHub зеркал нет.
- Пределы памяти контейнеров в сумме — 3,3 ГиБ. Это предохранители, а не подтверждённая вместимость.

## Раскладка на сервере

```
/etc/telegram-memory/            корень (TM_ROOT)
  config/bots.json               настройки ботов, 0444
  secrets/<сервис>/<секрет>      секреты: каталог 0700 root, файлы 0444
  secrets.prev/                  предыдущий набор секретов для ручного отката
  state/applied                  «<версия> <коммит>» последнего успешного запуска
/var/log/telegram-memory/        журналы: <скрипт>-<ГГГГММДД-ччммсс>.log, 30 на скрипт
```

Каждый контейнер получает только свои секреты (`/run/secrets/<имя>`). Файлы доступны на чтение всем, потому что Compose без Swarm монтирует их с правами хоста, а процессы контейнеров работают не от root; закрытость обеспечивает каталог `0700`.

## Первая установка

На сервере:

```bash
git clone https://github.com/Borisskin/telegram-memory && cd telegram-memory
sudo scripts/config-setup.sh
sudo scripts/secrets-setup.sh --cookies /tmp/cookies.json
sudo scripts/secrets-setup.sh
sudo scripts/update.sh
```

1. `config-setup.sh` спрашивает адрес прокси модели (OpenAI-совместимый, `https://…/v1`) и модель Собеседника «общий».
2. Куки NotebookLM обязательны: без них проверка состава не проходит. Как получить их на Windows — в [инструкции NotebookLM](notebooklm.md); на сервер файл передаётся так: `scp cookies.json сервер:/tmp/`. Скрипт проверяет JSON, записывает куки и удаляет переданный файл.
3. `secrets-setup.sh` спрашивает внешние значения — каждое отдельным скрытым вводом одной строкой. Остальное вычисляет сам.
4. `update.sh` ставит Docker, если его нет, собирает образы, проверяет их и состав, запускает и ждёт готовности.

Из Windows — те же команды через `ssh -t`, например `ssh -t сервер 'cd telegram-memory && sudo scripts/secrets-setup.sh'`.

Если сборка на сервере не укладывается в ресурсы, образы можно собрать на другой машине тем же `update.sh` и перенести через `docker save … | ssh сервер docker load`.

### Секреты

| Секрет | Сервисы | Откуда |
|---|---|---|
| `owner_user_id` | coordinator, bots | спрашивается: числовой id владельца в Telegram |
| `telegram_api_id`, `telegram_api_hash` | telegram-mcp | спрашиваются: приложение на my.telegram.org |
| `telegram_session_string` | telegram-mcp | спрашивается: строка сессии Telethon (сценарий поставщика `session_string_generator.py`) |
| `receiver_bot_token`, `talker_shared_bot_token` | bots | спрашиваются: токены ботов от BotFather |
| `model_api_key` | bots | спрашивается: ключ прокси модели |
| `coordinator_mcp_token` | coordinator | генерируется: токен принципала `system` |
| `receiver_coord_token`, `talker_shared_coord_token` | bots | генерируются: токены ботов к координатору |
| `bot_principals` | coordinator | вычисляется: SHA-256 токенов ботов и их роли ([формат](coordinator-api.md#принципалы)) |
| `ov.conf` | openviking | собирается из `config/openviking.conf.json`: генерируется корневой ключ, спрашиваются ключи `embedding` и `vlm` |
| `openviking_api_key` | coordinator | тот же корневой ключ OpenViking |
| `notebooklm_cookies` | telegram-mcp | файл, только через `--cookies` |

Перечень — `config/secrets.json`, единственное место в git: тест сверяет его с `compose.yaml`. Значения секретов не попадают в git, образы, вывод скриптов и журналы.

Строка сессии Telegram даёт полный доступ к учётной записи: режим `read-only` telegram-mcp ограничивает средства MCP, но не саму сессию. Одну сессию нельзя использовать одновременно в двух клиентах (`AUTH_KEY_DUPLICATED`).

## Обновление и релизы

```bash
cd telegram-memory && sudo scripts/update.sh
```

- На сервер попадает каждый новый коммит ветки `main`. Если коммит `origin/main` уже применён, ответ — `RESULT=up-to-date`, ничего не собирается и не перезапускается.
- Номер релиза — файл `VERSION` (три числа, например `0.1.0`); его меняет владелец вручную. Релиз — тег `v<версия>` на коммите с тем же номером.
- `update.sh` отказывает (`RESULT=failed version …`, рабочая копия не меняется), если в `VERSION` не три числа, версия меньше применённой (сравнение по числам: `0.10.0` > `0.9.0`) или тег `v*` на коммите не равен `v<VERSION>`.
- Локальные изменения в рабочей копии останавливают обновление: их нужно закоммитить или отменить.
- Сборка пропускается, если образы текущей версии с меткой текущего коммита уже есть. `--force` собирает всегда.
- Изменившиеся скрипты вступают в силу в том же запуске: после `git pull` `update.sh` перезапускается новой версией.
- При любом сбое `state/applied` не меняется, поэтому повторный запуск без `--force` доделывает начатое и не собирает образы заново.

Порядок внутри: Docker → `git fetch` → проверка версии и тега → `git pull --ff-only` → сборка трёх образов (база telegram-mcp из форка, производный telegram-mcp, координатор) → проверка образов (Clipper превращает тестовую страницу в Markdown, в telegram-mcp нужная версия notebooklm-mcp-cli) → проверка состава → `docker compose up -d --wait` → готовность → запись `state/applied`.

**Готовность.** Координатор и OpenViking должны стать `healthy` (их `healthcheck` ходит на `/health` изнутри контейнера), telegram-mcp и bots — `running`. Через 30 секунд — повторная проверка: все четыре работают, координатор и OpenViking `healthy`, число перезапусков не выросло. Живые запросы к Telegram и NotebookLM не выполняются.

## Замена секретов и настроек

- Модель или адрес прокси — `sudo scripts/config-setup.sh`.
- Любой секрет — `sudo scripts/secrets-setup.sh`: для существующего секрета Enter оставляет значение, `з` заменяет. «Заменить» у внутреннего токена генерирует новый, `bot_principals` пересчитывается сам.
- Устаревшие куки NotebookLM — `scp` нового файла и `sudo scripts/secrets-setup.sh --cookies /tmp/cookies.json`.

Как применяется изменение:

1. Все ответы собираются до записи. Если ничего не изменилось, файлы не переписываются и никто не пересоздаётся.
2. Новый полный набор готовится в `secrets.new/` и проверяется целиком: `bot_principals` совпадает с хешами токенов, корневой ключ одинаков в `ov.conf` и `openviking_api_key`, `owner_user_id` одинаков у двух сервисов, куки — корректный JSON.
3. Замена двумя переименованиями: `secrets` → `secrets.prev`, `secrets.new` → `secrets`.
4. Если система уже установлена, затронутые сервисы пересоздаются (`docker compose up -d --force-recreate --no-deps`) и проверяется готовность. Нужно именно пересоздание: процессы читают секреты и настройки только при запуске. Для настроек это bots, для куки — telegram-mcp, для секретов — сервисы из `config/secrets.json`.

Образы при этом не пересобираются.

## Восстановление после прерывания

Скрипты секретов и настроек и `update.sh` в начале проверяют незавершённую замену:

- есть `secrets.new`, а `secrets` нет — прервалось переименование: набор проверяется, и замена завершается;
- есть оба — прервалась подготовка: `secrets.new` удаляется, работа начинается заново.

Рабочим всегда остаётся полный набор — прежний или новый. `check-deploy.sh` о незавершённой замене сообщает, но сам её не чинит. Ручной откат к предыдущему набору: `sudo mv /etc/telegram-memory/secrets /etc/telegram-memory/secrets.bad && sudo mv /etc/telegram-memory/secrets.prev /etc/telegram-memory/secrets`, затем `sudo scripts/update.sh --force`.

## Итоги и журналы

Все скрипты запускаются через `sudo` и работают по одному: второй запуск во время работы первого сразу выходит с `RESULT=failed busy`.

Последняя строка вывода — машиночитаемый итог:

```
RESULT=<итог> [подробности] LOG=/var/log/telegram-memory/<скрипт>-<время>.log
```

| Код выхода | Значение |
|---|---|
| `0` | Успех: `ok`, `configured`, `secrets-ready`, `cookies-updated`, `up-to-date`, `updated <версия>` |
| `1` | Ошибка или проверка не пройдена: `failed <стадия> <причина>`, `failed busy`, `secrets-missing <имена>` |
| `2` | Неверный вызов: без `sudo` или с неизвестными аргументами (`failed usage`) |

Стадии ошибок: `docker`, `fetch`, `version`, `build`, `verify`, `check`, `start`, `ready`, `secrets`, `config`. Для `start` и `ready` подробности — имя сервиса, который не запустился или перезапускается.

На экран выводятся краткие шаги, в журнал — всё, включая полный вывод `git` и `docker build`. Разбор сбоя:

```bash
ssh сервер sudo less /var/log/telegram-memory/update-20260927-120000.log
```

## Проверка состава

`sudo scripts/check-deploy.sh` без запуска контейнеров проверяет: ровно четыре сервиса; нет `ports`, `build`, `latest`; у всех `read_only`, `no-new-privileges`, `cap_drop: ALL` и предел памяти; изоляцию сетей; `/exchange` только у координатора и telegram-mcp; набор секретов каждого сервиса равен `config/secrets.json` и берётся из его каталога; образы текущей версии есть и их метки коммитов равны `config/vendors.json`; OpenViking — по дайджесту оттуда же; каталог секретов `0700` root и все файлы на месте; `config/bots.json` есть; незавершённой замены нет. `update.sh` выполняет ту же проверку перед запуском.

## Первый запуск ботов

1. В BotFather создать Приёмщика и Собеседника «общий»; у Собеседника выключить privacy mode ([боты](bots.md)).
2. Написать Приёмщику — он должен ответить только владельцу.
3. Сбор реальных каналов начинается с пробы до 100 сообщений (`collect_start` с `mode: pilot`) от принципала `system`; полная история — отдельным решением.

## Резервная копия

Автоматическая копия архива пока не реализована ([планы](roadmap.md)). До неё тома `telegram-memory-archive` и `telegram-memory-state` (в `compose.yaml` — `archive_data` и `coordinator_state`) нужно копировать вручную. Индекс OpenViking и том `telegram-memory-exchange` копировать не обязательно: индекс восстанавливается из архива.

## Тестовая среда в локальном Docker

Скрипты проверяются на машине разработчика в привилегированном контейнере Ubuntu 24.04 со своим Docker внутри и пределами сервера. Вместо GitHub — локальный голый репозиторий. systemd, сеть сервера и установку Docker с нуля эта среда не заменяет: их проверяет первая установка на живом сервере.

Поднять (из корня репозитория, Git Bash; `MSYS_NO_PATHCONV=1` отключает переписывание путей, поэтому файлы на стороне Windows — через `$TEMP`, а не `/tmp`):

```bash
export MSYS_NO_PATHCONV=1
docker build -t telegram-memory-test-env - <<'EOF'
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends docker.io docker-compose-v2 git python3 curl ca-certificates sudo iptables \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -s /bin/bash -G sudo owner && echo 'owner ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/owner
# cgroup v2: init moves to a child group so dockerd can delegate controllers (as docker:dind does)
CMD ["sh", "-c", "mkdir -p /sys/fs/cgroup/init && xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs; sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control; dockerd >/var/log/dockerd.log 2>&1 & exec sleep infinity"]
EOF
docker run -d --privileged --name tm-test --memory 4g --cpus 2 -v tm-test-docker:/var/lib/docker telegram-memory-test-env
git bundle create "$TEMP/tm.bundle" main && docker cp "$TEMP/tm.bundle" tm-test:/tmp/tm.bundle
docker exec -u owner tm-test bash -c 'sudo chown owner /srv && git clone -q --bare /tmp/tm.bundle /srv/tm.git && git -C /srv/tm.git symbolic-ref HEAD refs/heads/main && git clone -q /srv/tm.git ~/telegram-memory'
docker exec -it -u owner -w /home/owner/telegram-memory tm-test bash
```

Buildx в образ среды намеренно не входит: его ставит `update.sh`, как на сервере с Docker из пакета `docker.io`.

Передать новый коммит в «GitHub» среды:

```bash
git bundle create "$TEMP/tm.bundle" main && docker cp "$TEMP/tm.bundle" tm-test:/tmp/tm.bundle
docker exec -u owner tm-test git -C /srv/tm.git fetch -f /tmp/tm.bundle 'main:main' --tags
```

Сбросить: `docker rm -f tm-test && docker volume rm tm-test-docker`.

### Список ручной приёмки

| Код | Что сделать | Ожидается |
|---|---|---|
| Р-01 | `config-setup.sh` → `secrets-setup.sh --cookies` → `secrets-setup.sh` → `update.sh` на чистой среде | `RESULT=updated 0.1.0`; четыре сервиса `running`, координатор и OpenViking `healthy`; `state/applied` записан |
| Р-02 | Повторить `update.sh` | `RESULT=up-to-date`, контейнеры не пересозданы |
| Р-02 | Новый коммит в `/srv/tm.git`, `update.sh` | образы пересобраны, `RESULT=updated` |
| Р-02 | Коммит с тегом `v9.9.9` при `VERSION` 0.1.0; коммит с `VERSION` 0.0.9; `VERSION` = `1.0` | `RESULT=failed version …`, рабочая копия прежняя |
| Р-02 | Сломать Dockerfile в коммите, `update.sh` | `RESULT=failed build …`, контейнеры не перезапущены |
| Р-02 | `update.sh --force` | образы собраны заново |
| Р-02 | Локальная правка в рабочей копии, новый коммит, `update.sh` | `RESULT=failed fetch local changes …` |
| Р-03 | Повторить `secrets-setup.sh`, на всё Enter | `secrets unchanged`, время изменения файлов прежнее |
| Р-03 | Ввести нечисловой `owner_user_id` | `RESULT=failed secrets invalid input: owner_user_id`, файлы не тронуты |
| Р-03а | Заменить `model_api_key` | пересоздан только bots |
| Р-03а | Заменить `receiver_coord_token` | пересозданы coordinator и bots, все готовы |
| Р-03а | Прервать `secrets-setup.sh` между двумя переименованиями (или создать `secrets.new` вручную) | `check-deploy.sh` сообщает о незавершённой замене; следующий скрипт восстанавливает набор |
| Р-03б | Испортить секрет сервиса так, чтобы он падал, затем `update.sh --force` | `RESULT=failed start|ready <сервис>`, `state/applied` прежний |
| Р-04 | `sudo find /etc/telegram-memory/secrets -printf '%m %u %p\n'` | каталоги `700 root`, файлы `444` |
| Р-05 | Поиск введённых значений в `/var/log/telegram-memory`, выводе, `docker history`, `compose.yaml`, git | ничего не найдено |
| Р-06 | `--cookies` с неверным JSON; с верным на установленной системе | неверный отклонён без изменений; верный записан, файл удалён, пересоздан только telegram-mcp |
| Р-07 | 31 запуск `check-deploy.sh` | в журналах 30 файлов этого скрипта; путь журнала в каждой итоговой строке |
| Р-08 | Скрипт без `sudo`; два скрипта одновременно | код `2`; второй — `RESULT=failed busy` |
| Р-09 | Сменить коммит в `config/vendors.json` без пересборки, `check-deploy.sh` | `RESULT=failed check … label … differs` |
| Р-10 | Сборка координатора со сломанным Clipper | `RESULT=failed verify Obsidian Clipper …` |
| Р-11 | Сменить модель в `config-setup.sh` на установленной системе | пересоздан только bots, новая модель в `/run/config/bots.json` контейнера, образы не собирались |
| Р-12 | Лишний `ports`, `latest`, чужой секрет, нарушенная сеть, удалённый образ текущей версии | `check-deploy.sh` → `RESULT=failed check <причина>` |

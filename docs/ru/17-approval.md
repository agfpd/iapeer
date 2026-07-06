# 17 — Подтверждение человеком

Пир работает в одном из двух **режимов подтверждения**. В `yolo` (режим по умолчанию — сегодня так у всего флота) агент действует автономно: рантайм запускается со своим bypass-флагом, и ничто не спрашивает человека перед выполнением инструмента. В `gated` пир запускается **без** bypass, и каждый блокирующий вопрос-подтверждение, который поднял бы рантайм, уходит **человеку** через брокер подтверждений в демоне — кнопкой в Telegram, кликом в трее или командой `iapeer approve`. Решение человека `allow`/`deny` (с причиной) возвращается в рантайм, и инструмент либо исполняется, либо отклоняется.

Это **нормативный контракт**. Брокер подтверждений живёт в демоне; fleet-эндпоинты и типы событий `ev` ниже — это поверхность, под которую пишутся операторские клиенты (CLI, трей, telegram-рантайм), а не исходники демона. Факты перехвата (какое событие рантайма фаярит, в какой форме) закреплены за **Claude Code 2.1.201** и **codex-cli 0.142.5** — сняты с живых бинарей и актуальных доков рантаймов.

`gated` значит **«спрашивать перед действием»**, а не «в песочнице». Он убирает bypass, чтобы блокирующие вопросы всплывали; он **не** добавляет OS-песочницу (отдельная ось, не в v1). На codex gated явно есть `аппрувы ВКЛ + песочница ВЫКЛ` (см. таблицу тумблера).

## Тумблер режима

### Поле профиля

Foundation-owned lifecycle-поле в `peer-profile.json`, рядом с `wake_policy` / `initial_prompt`:

```json
{ "approval_mode": "gated" }
```

`"yolo" | "gated"`, **дефолт `yolo`**. Персистится только `gated` — запись `yolo` **удаляет** поле (поэтому круг `gated→yolo→gated` байт-в-байт, а весь флот остаётся ровно таким, каким был до появления этой фичи). Единственное место, где живёт дефолт «отсутствует ⇒ yolo», — `approvalModeOf(profile)`; каждый читатель (запуск, супервизор, fleet-снапшот, CLI) резолвит через него и никогда не переопределяет. В fleet-снапшот режим попадает аддитивным полем `approval_mode` (docs/15) чтением локального профиля — pre-approval-демон его опускает, и клиенты ОБЯЗАНЫ трактовать отсутствие как `yolo`.

### Поверхности запуска, которых касается флип

Bypass — это **аргумент запуска**, у каждого рантайма свой, и режим есть согласованная операция над **всеми** поверхностями, которые этот аргумент подразумевает. iapeer владеет запуском, поэтому полнота списка — за фундаментом.

**claude** (вариант D — matcher-free хук `PermissionRequest`; проверено живьём 2.1.201):

| # | Поверхность | yolo | gated |
|---|---|---|---|
| C1 | argv `--dangerously-skip-permissions` | присутствует | **убран** |
| C2 | argv permission-mode | (bypass) | `--permission-mode default` (явно — не наследует acceptEdits/bypass defaultMode) |
| C3 | ready-gate маркер `isInputReady` | нужен баннер `bypass permissions on` | баннера **НЕТ** → маркер mode-aware (composer `❯` + сняты boot-диалоги), иначе пир никогда не станет ready и wake проваливается |
| C4 | boot-диалог «Bypass Permissions mode» accept | появляется (первый bypass) | не появляется (нет bypass) |
| C5 | хук `PermissionRequest` в `<cwd>/.claude/settings.json` | **отсутствует** (0 оверхеда, байт-в-байт как сегодня) | **установлен** — matcher-free (см. ниже), `command = iapeer approval-hook` |
| C6 | allow-rule собственного MCP-инструмента пира (`permissions.allow: ["mcp__iapeer__send_to_peer"]`) | не нужен (bypass) | **нужен** — иначе default-mode гейтит сам IAP-канал пира, и он виснет на `send_to_peer` |
| C7 | супервизор: circuit-breaker (dangerous-rm, выше permission-слоя) | авто-Yes + аудит-лог | **маршрут человеку** через брокер |
| C8 | argv `--disallowedTools AskUserQuestion` | остаётся | остаётся в v1 (см. Лимитации) |

**Почему matcher-free `PermissionRequest`, а не `PreToolUse`.** `PermissionRequest` фаярит **только когда permission-конфиг рантайма решил спросить** — вызов, не покрытый allow/deny-правилом. Значит политика *что спрашивать* остаётся на 100% у рантайма: юзер настраивает её обычными permission-правилами (инструмент в `permissions.allow` не спрашивается никогда → хук не фаярит → авто-allow). Нет матчера классов, который дрейфует, нет проскакивающего нового инструмента, нет зависания. iapeer лишь сеет хук + одно allow-правило для собственного MCP-инструмента пира.

**codex** (хук `PreToolUse` — проверено живьём, codex-cli 0.142.5):

| # | Поверхность | yolo | gated |
|---|---|---|---|
| X1 | argv `--dangerously-bypass-approvals-and-sandbox` | присутствует | **убран** |
| X2 | argv approval/sandbox | (bypass) | `-c approval_policy=on-request -c sandbox_mode=danger-full-access` — аппрувы **ВКЛ**, песочница **ВЫКЛ** (чтобы loopback-MCP `send_to_peer` и запись в vault-память вне cwd работали; `workspace-write` отрезал бы сеть и внешние пути). Session-scoped через `-c`, не хост-конфиг. |
| X3 | хук `PreToolUse` `<cwd>/.codex/hooks.json` + trust-preseed в `~/.codex/config.toml [hooks.state]` | **отсутствует** | **установлен + доверен** (`preSeedCodexHooksTrust`; недоверенный codex-хук молча пропускается) |
| X4 | codex cwd-trust `[projects."<cwd>"] trust_level="trusted"` | pre-trusted (обе моды) | pre-trusted (при активных аппрувах важнее) |
| X5 | ready-gate `isInputReady` (composer `›`) | mode-независим | без изменений |

codex-хук матчится по регекспу имён инструментов `^(Bash|Shell|shell|local_shell|exec|apply_patch|ApplyPatch)$` — грубый матчер классов живёт на собственном `hooks.json` рантайма (юзер правит как обычный рантайм-конфиг).

### Идемпотентность и момент применения

- **argv-поверхности** (C1–C2, C8, X1–X2) вычисляются из моды на каждом запуске — идемпотентны структурно, накопления нет.
- **settings.json / hooks.json** (C5–C6, X3) — add при gated / remove при yolo, no-clobber merge, ключ по стабильному маркеру `approval-hook`: наш блок дописывается детерминированно и удаляется дочиста (опустевший массив `hooks.PermissionRequest` / `PreToolUse` снимается, опустевший объект `hooks` / `permissions` снимается, чужие хуки/правила не трогаются). Круг `gated→yolo→gated` восстанавливает pre-install байты.
- **codex trust** (X3–X4) переиспользует уже идемпотентные `preSeedCodexHooksTrust` / `removeCodexHooksTrustUnder`.

Все поверхности читаются/применяются **на старте сессии**. **Живая сессия держит свою запущенную моду** до следующей фреш-сессии — ровно как агентик-пир лениво подхватывает новую доктрину на следующем wake. Тумблер: (1) персистит `approval_mode`, (2) идемпотентно приводит settings/hooks-поверхности к моде, (3) НЕ трогает живую сессию. Чтобы применить сразу — подними фреш-сессию (`iapeer approval-mode <peer> <mode> --now`, или `iapeer new`/`refresh`).

## Механизм перехвата

У обоих рантаймов есть Claude-совместимая **hook-система**, которая перехватывает подтверждение программно и возвращает `allow`/`deny` + причину + структурное содержимое действия. Это первичный механизм. **Экранный pty-скрейп — бэкстоп только для одного класса** — claude-circuit-breaker `dangerous-rm`, который живёт *выше* permission-слоя и не виден ни одному хуку.

- **claude `PermissionRequest`** — на stdin `{tool_name, tool_input, …}`; хук печатает `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow|deny","message":"…"}}}`. `deny` доносит `message` до модели. Фаярит только на вопрос-достойных вызовах.
- **codex `PreToolUse`** — тот же shape stdin; печатает `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow|deny","permissionDecisionReason":"…"}}`. `exit 2` (+ stderr) тоже отклоняет. Проверено живьём (0.142.5): codex фаярит `PreToolUse` (не `PermissionRequest`) на tool-вызовах с `tool_name:"Bash"` для shell; `deny` жёстко блокирует тул и причина доходит до модели даже под `sandbox_mode=danger-full-access` — так что под gated-конфигом (danger-full-access + on-request → `permission_mode=bypassPermissions`) хук — ЕДИНСТВЕННЫЙ гейт.
- **супервизор circuit-breaker** — гард `dangerous-rm`/`rmdir` claude (и стандартный command-approval-промпт, который показывает no-bypass-сессия) — это TUI-селект, невидимый хуку. pty-супервизор читает его со своей авторитетной модели и под gated POSTит брокеру (ниже); под yolo авто-жмёт YES с аудит-строкой.

Хук-бинарь — сабкоманда `iapeer approval-hook`: читает hook-JSON рантайма со stdin, резолвит `PEER_PERSONALITY`/`PEER_RUNTIME` из session-env и URL демона из `router.json`, POSTит блокирующий запрос брокеру и печатает рантайм-специфичный JSON решения.

## Номенклатура v1 и содержимое на точке перехвата (критерий «что подтверждается»)

В любом канале человек видит **конкретное содержимое** действия, а не только имя инструмента.

**claude** — `Bash` → полная команда (+ описание); `Edit` → файл + old/new; `Write` → файл + содержимое; `ExitPlanMode` → текст плана; circuit-breaker `dangerous-rm` → полный текст промпта + rm-команда + target (pane-скрейп, не структурно).

**codex** — `Bash`/`exec` → команда; `apply_patch` → патч/диф; эскалации (shell/сеть/MCP) через `PermissionRequest` → инструмент + input + человекочитаемое описание.

Неизвестный инструмент падает на pretty-print `tool_input`, так что непрозрачного нет ничего.

**Лимитации (не замалчиваю):**

1. **claude `AskUserQuestion` не перехватывается хуком** — у него нет permission-check и он не событие `PreToolUse`. В v1 остаётся заглушённым через `--disallowedTools AskUserQuestion` (осознанное решение владельца, не дыра к закрытию; возврат — только по его явному запросу).
2. **codex MCP-elicitation** отдаёт содержимое только на экране, не структурным хуком — редко, в v1 не покрывается.
3. **у codex нет plan-mode-аппрува** — класс «план» существует только у claude (асимметрия, не отсутствие фичи).

## Брокер (единый источник истины)

Очередь подтверждений живёт **в демоне** (always-on процесс). Каждый канал, который спрашивает (хук рантайма, breaker супервизора), и каждый, который отвечает (CLI, трей, telegram-рантайм), — интерфейс к этой одной очереди: решение из любого канала гасит запрос везде. In-memory + эфемерна — ожидающие запросы **не** переживают рестарт демона (блокирующее соединение хука рвётся → хук fail-safe в deny); durable `approvals.log` — аудит-след, не хранилище восстановления.

Путь: хук gated-пира (или breaker супервизора) блокируется на `POST /fleet/v1/approvals` → брокер кладёт в очередь, эмитит `approval-request` (в `approvals.log` → SSE) и держит соединение → канал отвечает `POST /fleet/v1/approvals/<id>/(approve|deny)` → промис резолвится, демон пишет обратно hook-JSON, инструмент исполняется или блокируется с причиной.

**Fail-safety — все направления отказа = `deny`:** брокер недоступен, демон рестартнул при ожидании (соединение рвётся), requester-дисконнект, неизвестный id и таймаут per-request — всё резолвится в deny. Это инженерное основание уборки bypass под gated: без bypass «нет решения» деградирует к собственному permission-промпту рантайма (блокирующий TUI), а **не** к авто-run — сбой перехвата безопасен, никогда не пермиссивен. (Под *сохранённым* bypass хук-таймаут = авто-run — ровно тот вред, ради которого gated существует.)

**Таймауты (упорядочены так, чтобы default-deny брокера всегда выигрывал):** брокер default-deny — **300 с** (`IAPEER_APPROVAL_TIMEOUT_MS`); потолок fetch хук-клиента — **600 с**; `timeout` установленного хука рантайма — **900 с**. Так брокер отвечает (или default-денит) первым, клиент абортится вторым, а рантайм убивает хук последним. Таймаут доносится модели как `deny` с `reason="approval timed out (default-deny)"`.

## Fleet API

Поверхность подтверждений отдаётся на обоих листенерах демона под `/fleet/v1`, с той же авторизацией и обязательствами клиента, что и остальной Fleet API (docs/15). Добавляет четвёртый durable-лог `approvals.log` в SSE-тейл — клиенты ОБЯЗАНЫ игнорить неизвестные `ev` (обязательство 1), ровно так зарезервированы `approval-request` / `approval-resolved`.

**События** (компактная logfmt-строка → SSE JSON; полное содержимое НЕ в событии — читай очередь):

- `approval-request` — `id, personality, runtime, kind, tool, summary, created, expires, approvers`.
- `approval-resolved` — `id, personality, runtime, decision (allow|deny), reason, by (approver), via (cli|tray|telegram|timeout|disconnect), latencyMs`.

**Эндпоинты:**

| Метод + путь | Назначение |
|---|---|
| `GET /fleet/v1/approvals` | список ожидающих (полные item'ы) |
| `GET /fleet/v1/approvals/<id>` | один ожидающий, полный `content` (многострочный диф / план / команда) |
| `POST /fleet/v1/approvals/<id>/approve` | `{approver?}` → allow |
| `POST /fleet/v1/approvals/<id>/deny` | `{reason?, approver?}` → deny (причина к модели) |
| `POST /fleet/v1/approvals` | **блокирующий long-poll**, который держит спрашивающий хук/breaker: `{personality, runtime, kind, tool, content, summary?}` → `{id, decision, reason?}` |

`kind` — таксономический тег (`tool` | `plan` | `question` | `circuit-breaker`; терпим к свободной форме). Так бейдж/SSE остаётся лёгким, а полное содержимое доступно в каждом канале через два `GET`.

## CLI

- `iapeer approvals [--json]` — очередь ожидающих: personality · runtime · kind · **дословная команда/содержимое** · возраст · id.
- `iapeer approve <id> [--approver <peer>]` — одобрить.
- `iapeer deny <id> [reason] [--approver <peer>]` — отклонить с причиной (доносится модели).
- `iapeer approval-mode <peer> [gated|yolo] [--now]` — прочитать текущую моду (опустить моду) или флипнуть: персистит поле, идемпотентно приводит рантайм-поверхности к моде и сообщает момент применения. `--now` дополнительно поднимает фреш-сессию, чтобы мода вступила сразу.

`approve` / `deny` / `approvals` достают до in-daemon брокера по Fleet API (как трей), не in-process — очередь живёт в живом демоне.

## Совместимость

Аддитивно в рамках `/fleet/v1` (docs/15): эндпоинты и `ev` `approval-*` растят поверхность без бампа версии. Pre-approval-демон просто опускает `approval_mode` в снапшоте и не отдаёт эндпоинтов `/approvals`; клиент feature-детектит по наличию поля / `200` от `GET /fleet/v1/approvals`.

# Мультиаккаунтный режим (форк)

Один процесс на много Steam-аккаунтов вместо одного контейнера на аккаунт. Трафик каждого аккаунта идёт через его
прокси: DMarket API, Steam и notary.

```bash
node dist/multi/main.js /config/multi.json
# в образе: docker run … --entrypoint node ghcr.io/…/p2p-sdk dist/multi/main.js /config/multi.json
```

## Конфиг

Ключи такие же, как в одиночном конфиге (README → Configuration), плюс `accounts` и два ключа в `prover`:

```json
{
  "managementSecret": "<openssl rand -hex 32>",
  "dataDir": "/data",
  "prover": { "globalConcurrency": 8, "connectDeadlineMs": 600000 },
  "accounts": [
    { "id": "acc001", "proxy": "http://user:pass@10.0.0.1:3128" },
    { "id": "acc002", "proxy": "http://10.0.0.2:3128", "steamWrites": false }
  ]
}
```

| Ключ | Что делает |
|---|---|
| `accounts[].id` | `[A-Za-z0-9_-]{1,64}`, имя аккаунта в маршрутах API и логах |
| `accounts[].proxy` | `http://[user:pass@]host:port`, HTTP-прокси с поддержкой CONNECT. Без ключа аккаунт ходит напрямую |
| `accounts[].steamWrites` | переопределяет общий `steamWrites` для одного аккаунта |
| `prover.globalConcurrency` | сколько proof-ов одновременно на весь процесс; остальные стоят в очереди FIFO |
| `prover.connectDeadlineMs` | сколько proof-процесс может ждать слот; с очередью по умолчанию 10 мин (у библиотеки 30 с) |

Состояние аккаунта хранится в `dataDir/<id>/`, сокет очереди proof-ов — в `dataDir/prover-gate.sock`.

## API

Bearer тот же — `managementSecret`. Маршруты одиночного SDK переехали под аккаунт, коды ответов не изменились:

- `PUT /v1/accounts/{id}/dmarket/key`
- `PUT /v1/accounts/{id}/steam/session`
- `GET /v1/accounts/{id}/health`
- `GET /v1/health` — сводка: статус и коды проблем каждого аккаунта, состояние очереди proof-ов. Отвечает `503`, если
  хотя бы один аккаунт в состоянии `down`.

Если worker аккаунта упал, он перезапускается через 5 с, а остальные аккаунты продолжают работать. Как после рестарта
одиночного SDK, ключ и токен нужно прислать заново. Пока worker поднимается, API отвечает
`503 ACCOUNT_STARTING`.

## Как устроено

- Каждый аккаунт работает в своём `worker_thread` с неизменённым `SdkRuntime`.
- В worker-е стоит свой глобальный `undici.ProxyAgent`, поэтому весь `fetch` библиотеки идёт через прокси аккаунта.
  Версия `undici` должна совпадать с той, что встроена в Node (`node -p process.versions.undici`). С undici 7 и
  Node 22 запросы падают с `invalid content-length header`.
- Proof-процессы библиотека запускает через `child_process.fork` с урезанным env. Worker подменяет `fork`: передаёт
  `P2P_PROXY_URL` и `P2P_PROVER_GATE` и добавляет `--import prover-preload.js`.
- Preload сначала ждёт слот в общей очереди, затем заворачивает `net.createConnection` (TLS-сессия со Steam, которую
  заверяет notary) и `tls.connect` (WebSocket к notary) в CONNECT-туннель через прокси аккаунта.

Код библиотеки `@dmarket/p2p-tracker-headless` не меняется. Форк опирается на её внутреннее поведение: `fork` через
default-импорт `node:child_process`, `connectTcp` через `net.createConnection`, notary через `ws`. Поэтому после
каждого обновления библиотеки нужно прогнать проверку из раздела «Проверено».

## Ресурсы (замер)

- Около 45 MB RSS на аккаунт в простое: 50 аккаунтов — 2,27 GB. На 350 аккаунтов нужно около 16 GB плюс
  `globalConcurrency × ~640 MB` на proof-ы.
- Старт: 50 worker-ов поднимаются примерно за 9 с на 2 vCPU.
- Рекомендуется делить на шарды по 50–100 аккаунтов на процесс: меньше радиус поражения при падении и быстрее
  рестарт.

## Проверено

На заглушке DMarket и двух логирующих прокси:

- heartbeat двух аккаунтов прошёл каждый через свой прокси, `linkedSteamId` у каждого свой;
- ключ, токен и `409 STEAM_WRONG_ACCOUNT` маршрутизируются по аккаунтам; `401` без bearer, `404` для неизвестного
  аккаунта;
- в proof-процессе транспорт библиотеки `connectTcp` и WSS через `ws` идут через прокси своего аккаунта;
- очередь с `globalConcurrency: 1` пропустила второй proof только после завершения первого;
- URL прокси с паролем не попадает в логи;
- все 103 исходных теста проходят.

**Не проверено:** полный proof с настоящим notary DMarket и Steam. Это первый тест на одном реальном аккаунте.

## Ограничения

- Поддерживаются только HTTP-прокси с CONNECT. SOCKS5 пока нет.
- Секреты по-прежнему хранятся только в памяти, как в upstream.
- Нет приоритета proof-ов по дедлайну сделки: очередь FIFO.

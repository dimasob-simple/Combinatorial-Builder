# 4 · Wave Print-CSV → Builder (Iteration / Homunculus / Screening)

## Описание

Собирает pipeline payload из рецептов волны и отправляет POST-запрос в Builder API для генерации видео-креативов.

## Триггер

| Поле | Значение |
|---|---|
| Таблица | Waves |
| Событие | When a record matches conditions |
| Условие | `Status = Print-CSV` AND `Recipes is not empty` |

## Условие ветки

```
goal = Iteration OR Homunculus OR Screening
```

## Жизненный цикл Wave.Status

```
Print-CSV → Printed  (успех)
          → Error    (при ошибке)
```

## Что делает скрипт (алгоритм)

### 1. Резолв overlays (дисклеймер)
- Читает `Wave.disclaimer` → Overlays-запись → `s3_link_9x16` / `s3_link_16x9`
- **v6:** если `Asset.disclaimer_style = black` → берёт `Overlays.dark_variant` для этого рецепта
- Fallback: если `16x9`-путь пуст → используется `9x16`-путь

### 2. Резолв стикера (v5)
- Читает `Wave.sticker` → Overlays-запись → `s3_link_9x16` / `s3_link_16x9`
- Идёт в поле `overlay_all` payload (накладывается поверх всего)

### 3. Сборка pipeline tasks
Для каждого рецепта (отсортированного по `auto_id`):
- `videos[]` — по каждому слоту: `video_path` (с суффиксом `_16x9` для 16×9), `overlay_path` (дисклеймер, пропускается для endcard-слотов), `brightness: 0`, `volume: 1`
- `audios[]` — путь к музыке + `volume` (из `Recipe.volume` или дефолт 0.80)
- `result_name` — `{creo_name}.mp4`
- `overlay_all` — путь стикера (если есть)

### 4. Manifest (folder_name)
- Читает Task → Pack → первый Pack-name + approach из первого creo_name
- `folder_name = martech/video_builder/creatives/{packName}_{approach}_{DD-MM-YY}`

### 5. Auth0 + API call
- POST `https://simple-prod-payment.us.auth0.com/oauth/token` → получает `access_token`
- POST `https://mtech.fstr.app/api/public/v1/pipelines/` с полным payload

## Входные параметры (`input.config()`)

| Имя | Тип | Описание |
|---|---|---|
| `waveRecordId` | Airtable record ID | ID волны |

## Секреты (`input.secret()`)

| Имя | Описание |
|---|---|
| `AUTH0_CLIENT_ID` | Client ID для Auth0 |
| `AUTH0_CLIENT_SECRET` | Client Secret для Auth0 |

## Пути к файлам

| Тип | Формат |
|---|---|
| Видео 9×16 | `martech/video_builder/source_assets/video/Assets/{name}.mp4` |
| Видео 16×9 | `martech/video_builder/source_assets/video/Assets/{name}_16x9.mp4` |
| Аудио | `martech/video_builder/source_assets/audio/{name}` |
| Результат | `martech/video_builder/creatives/{folderName}/{creoName}.mp4` |

## Версии

| Версия | Дата | Изменения |
|---|---|---|
| v6 | 2026-05-27 | Dark disclaimer: `disclaimer_style = black` → `dark_variant` overlay |
| v5 | 2026-05-21 | Стикер: `Wave.sticker` → `overlay_all` в payload |
| v4 | 2026-05-15 | Ratio-aware overlays: отдельные пути для 9×16 / 16×9 |
| v3 | 2026-05-15 | Multi-aspect-ratio source paths, manifest block |
| v2 | 2026-05-15 | Manifest: folder_name, result_name, task_number |

## Связанные таблицы

`Waves` · `Recipes` · `Recipe Slots` · `Constructor Slots` · `Assets` · `Overlays` · `Tasks` · `Packs`

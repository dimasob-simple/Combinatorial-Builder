# 3 · Wave Run → Generate Recipes (Homunculus)

## Описание

Генерирует рецепты для волны с целью **Homunculus** методом стохастического подбора уникальных комбинаций ассетов.  
После создания рецептов автоматически создаёт Packs, Creatives и назначает музыку.

## Триггер

| Поле | Значение |
|---|---|
| Таблица | Waves |
| Событие | When a record matches conditions |
| Условие | `Status = Run` AND `Recipes is empty` |

## Условие ветки

```
goal = Homunculus
AND Constructor ID is not empty
```

## Жизненный цикл Wave.Status внутри скрипта

```
Run → Autofilled (лок, чтобы триггер не сработал повторно)
    → Print-CSV  (успех)
    → Error      (при любой ошибке)
```

## Что делает скрипт (алгоритм)

### 1. Подготовка пула ассетов
- Берёт ассеты из `Wave.assets_for_wave`
- Исключает ассеты без поля `duration_sec` или с нулевой длительностью
- Для режима `16x9-only` фильтрует только ассеты с `s3_sync_status_16x9 = Uploaded`

### 2. Feasibility check
- Сумма минимальных длительностей по слотам не должна превышать `MAX_TOTAL_DURATION_SEC` (60 с)
- Если бюджет невыполним — бросает ошибку сразу

### 3. Генерация кандидатов
- Стохастический подбор: для каждого слота выбирается ассет с наименьшим накопленным exposure (с учётом весов позиций)
- Ограничение бюджета длительности: picker резервирует `minSuffixSum[i+1]` для будущих слотов
- Дедупликация по сигнатуре `assetId1|assetId2|...`

### 4. Greedy selection
- Из кандидатов выбирает `needToCreate` штук с максимальным diversity-score
- Score учитывает: positional exposure, global exposure, role fit bonus, adjacent pair penalty, co-occurrence penalty

### 5. Мультиформат (Task.aspect_ratio)
- Для каждого концепта определяет доступные форматы (`9x16`, `16x9`)
- `16x9` доступен только если все ассеты концепта имеют `s3_sync_status_16x9 = Uploaded`
- На каждый концепт × формат создаётся отдельный Recipe

### 6. Создание записей
- **Recipes** — по одной на концепт × формат, с полями: конструктор, волна, ratio, overlays
- **Recipe Slots** — по одной на каждый слот каждого рецепта (ссылки на Recipe + Constructor Slot + Asset)
- **Packs** — группировка рецептов по стратегии (`flat` / `grouped` / `single`), нумерация через `assignee.member_initials + pad3(N)`
- **Creatives** — `creo_name` по формату `{approach}_{funnel}_{flow}_Video_{pack}_{ratio}_{lang}_{N}`

### 7. Музыка
- Если `Wave.music` заполнена → round-robin по рецептам
- Иначе → берёт `Asset.default_music` первого слота каждого рецепта

## Входные параметры (`input.config()`)

| Имя | Тип | Описание |
|---|---|---|
| `waveRecordId` | Airtable record ID | ID волны |

## Ключевые константы

| Константа | Значение | Описание |
|---|---|---|
| `MAX_TOTAL_DURATION_SEC` | 60 | Максимальная суммарная длительность одного концепта |
| `MAX_SCAN_CANDIDATES` | 4000 | Максимум кандидатов при greedy selection |
| `STATUS_LOCK` | `Autofilled` | Статус-лок в начале работы |
| `STATUS_SUCCESS` | `Print-CSV` | Финальный статус при успехе |
| `STATUS_ERROR` | `Error` | Финальный статус при ошибке |

## Версии

| Версия | Дата | Изменения |
|---|---|---|
| v5 | 2026-05-26 | Ограничение суммарной длительности концепта (duration_sec), feasibility check, suffix-sum reservation |
| v4 | 2026-05-15 | Мультиформат: Task.aspect_ratio как multipleSelects, Recipe.ratio |
| v3 | 2026-05-15 | Создание Packs + Creatives |
| v2 | 2026-04-24 | Фикс зависания генератора, диагностика |

## Связанные таблицы

`Waves` · `Assets` · `Constructors` · `Constructor Slots` · `Recipes` · `Recipe Slots` · `Music` · `Tasks` · `Packs` · `Creatives` · `Team`

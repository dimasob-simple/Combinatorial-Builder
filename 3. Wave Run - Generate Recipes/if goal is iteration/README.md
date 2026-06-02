# 3 · Wave Run → Generate Recipes (Iteration)

## Описание

Генерирует рецепты для волны с целью **Iteration** методом детерминированного перебора всех допустимых комбинаций ассетов.  
Поддерживает мультиплатформенность (Meta / AppLovin / Google) и мультиформат (9×16 / 16×9).

## Триггер

| Поле | Значение |
|---|---|
| Таблица | Waves |
| Событие | When a record matches conditions |
| Условие | `Status = Run` AND `Recipes is empty` |

## Условие ветки

```
goal = Iteration
AND Constructor ID is not empty
```

## Жизненный цикл Wave.Status внутри скрипта

```
Run → Autofilled (лок)
    → Print-CSV  (успех)
    → Error      (при любой ошибке)
```

## Что делает скрипт (алгоритм)

### 1. Подготовка пула ассетов
- Берёт ассеты из `Wave.assets_for_wave`
- Фильтрует каждый слот по `granularity` (из `ITERATION_SLOT_GRANULARITY`):
  - Slot 1 → `brick`
  - Slot 2 → `full_body`
  - Slot 3 → `brick`
- Поддерживает только 2 или 3 слота (иначе ошибка)

### 2. Детерминированный перебор (enumerate)
- Рекурсивный перебор всех допустимых комбинаций
- Исключает дубли с уже существующими рецептами и уже выбранными сигнатурами
- Останавливается как только набрано `needToCreate` комбинаций

### 3. Платформенная логика (Task.platform)

| Платформа | Формат | Flow | Особенности |
|---|---|---|---|
| Meta | 9×16 / 16×9 | ITR / RES | Базовый рецепт |
| AppLovin | 9×16 only | ALC | Подменяет body-ассет на `platform_correct_versions` (если есть) |
| Google | 9×16 / 16×9 | GGC | Аналогично AppLovin, но поддерживает оба формата |

### 4. Создание записей
- **Recipes** — на каждый концепт × формат × платформу
- **Recipe Slots** — с подменой body-слота для ALC/GGC рецептов; endcard-слот для AppLovin пропускается
- **Creatives** — `creo_name`:
  - Iteration 9×16: `{Hook}-{Body}_{funnel}_ITR_Video_{pack}_9x16_{lang}_{N}`
  - Iteration 16×9: `{Hook}-{Body}-FullS_{funnel}_RES_Video_{pack}_16x9_{lang}_{N}`
  - ALC: `{Hook}-{ALCBody}_{funnel}_ALC_Video_{pack}_9x16_{lang}_{N}`
- **policy_of** — ALC/GGC креативы линкуются к соответствующему Meta-креативу

### 5. Музыка
- Аналогично Homunculus: `Wave.music` → round-robin; иначе `Asset.default_music`

## Входные параметры (`input.config()`)

| Имя | Тип | Описание |
|---|---|---|
| `waveRecordId` | Airtable record ID | ID волны |

## Ключевые константы

| Константа | Значение | Описание |
|---|---|---|
| `ITERATION_SLOT_GRANULARITY` | `{1: brick, 2: full_body, 3: brick}` | Ожидаемая гранулярность по номеру слота |
| `SUPPORTED_SLOT_COUNTS` | `[2, 3]` | Допустимое количество слотов |
| `STATUS_LOCK` | `Autofilled` | Статус-лок |
| `STATUS_SUCCESS` | `Print-CSV` | Финальный статус при успехе |
| `STATUS_ERROR` | `Error` | Финальный статус при ошибке |

## Версии

| Версия | Дата | Изменения |
|---|---|---|
| v5 | 2026-05-27 | Поддержка AppLovin (ALC): platform_correct_versions, policy_of линковка, GGC (Google) |
| v4 | 2026-05-21 | Resize-тег `-FullS` в creo_name для 16×9 |
| v3 | 2026-05-15 | Мультиформат (9×16 / 16×9) |
| v2 | 2026-05-15 | Создание Packs + Creatives |

## Связанные таблицы

`Waves` · `Assets` · `Constructors` · `Constructor Slots` · `Recipes` · `Recipe Slots` · `Music` · `Tasks` · `Packs` · `Creatives` · `Team`

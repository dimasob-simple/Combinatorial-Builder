# 4 · Wave Print-CSV → Builder (Free Overlay)

## Описание

Упрощённая ветка для волн с целью **Free Overlay**.  
Вместо отправки в Builder API записывает данные в таблицу `Recipe Exports` для последующей обработки.

## Триггер

| Поле | Значение |
|---|---|
| Таблица | Waves |
| Событие | When a record matches conditions |
| Условие | `Status = Print-CSV` AND `Recipes is not empty` |

## Условие ветки

```
goal = Free Overlay
```

## Жизненный цикл Wave.Status

```
Print-CSV → Printed  (успех)
          → Error    (при ошибке)
```

## Что делает скрипт (алгоритм)

1. Проверяет, что `Wave.Status = Print-CSV`
2. **Очищает** все существующие записи в таблице `Recipe Exports`
3. Загружает рецепты волны, сортирует по `auto_id`
4. Для каждого рецепта:
   - `id` = порядковый номер (1..N)
   - `slot_1` = `Recipe.source_video_path` (полный S3-путь к исходному видео)
   - `overlay_1` = путь оверлея из `Recipe.free_overlay` (link → `Overlays.s3_link` или plain text)
5. Записывает строки в `Recipe Exports` батчами по 50
6. Устанавливает `Wave.Status = Printed`

## Схема рецепта для Free Overlay

```
Recipe
  ├── auto_id            (сортировка)
  ├── source_video_path  (S3-путь к исходному видео)
  └── free_overlay       (link to Overlays OR plain text S3-путь)
```

## Входные параметры (`input.config()`)

| Имя | Тип | Описание |
|---|---|---|
| `waveRecordId` | Airtable record ID | ID волны |

## Связанные таблицы

`Waves` · `Recipes` · `Overlays` · `Recipe Exports`

# 2 · Homunculus → Auto by rules / Only tagged

## Описание

Срабатывает при создании новой волны с целью Homunculus.  
В зависимости от `asset_source_mode` либо автоматически подбирает ассеты по правилам (и линкует их к волне), либо просто переводит волну в статус Run (ассеты уже проставлены вручную через тег).

## Триггер

| Поле | Значение |
|---|---|
| Таблица | Waves |
| Событие | When a record is created |

## Условие запуска

```
Status = Created
AND goal = Homunculus
AND assets_for_wave ID is empty
AND Direction ID is not empty
AND platform is not empty
AND Funnel ID is not empty
```

## Ветки логики

### Auto by rules (`asset_source_mode = Auto by rules`)

1. **Find records #A** — ассеты "for everyone" (подходят всем воронкам)
2. **Find records #B** — ассеты "for a specific funnel" (подходят конкретной воронке волны)
3. **Run a script** — объединяет массивы #A и #B, дедуплицирует, линкует к `Wave.assets_for_wave`
4. **Update record** — `Wave.Status = Run`

### Only tagged (`asset_source_mode = Only tagged`)

1. **Update record** — `Wave.Status = Run` (ассеты уже проставлены вручную)

## Скрипт

`script.js`

### Входные параметры (`input.config()`)

| Имя | Тип | Описание |
|---|---|---|
| `waveRecordId` | Airtable record ID | ID волны |
| `foundA` | List of record IDs | Ассеты из Find records #A |
| `foundB` | List of record IDs | Ассеты из Find records #B |

### Что делает скрипт

- Объединяет `foundA` + `foundB` в один массив (Set — дедупликация)
- Обновляет запись волны: поле `assets_for_wave` ← merged array
- Возвращает `output: linked_assets_count`

### Выходные параметры

| Имя | Описание |
|---|---|
| `linked_assets_count` | Количество уникальных ассетов, прилинкованных к волне |

## Связанные таблицы

- `Waves` — обновляется `assets_for_wave` и `Status`
- `Assets` — источник ассетов

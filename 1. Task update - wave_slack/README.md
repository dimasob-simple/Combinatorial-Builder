# 1 · Task update → create Wave+Slack

## Описание

Реагирует на изменение статуса задачи в таблице `Tasks`.  
В зависимости от нового статуса либо отправляет Slack-уведомление, либо создаёт волну (Wave) и обновляет её статус.

## Триггер

| Поле | Значение |
|---|---|
| Таблица | Tasks |
| Событие | When a record is updated |
| Отслеживаемое поле | `status` |

## Ветки логики

| Условие | Действие |
|---|---|
| `status = ToDo` + `Waves ID is empty` + `task_kind = combinatorial` | Slack: Send a message → #Dima Sobolevskij |
| `status = InProgress` + `task_kind = combinatorial` + `assembly_mode = Iteration` | Create record in Waves → Update record Status (Run) |
| `status = InProgress` + `task_kind = combinatorial` + `assembly_mode = Homunculus` | Create record in Waves |
| `status = InReview` | Slack: Send a message |
| `status = NeedFix` | Slack: Send a message → #Dima Sobolevskij |

## Скрипт

Скрипта нет — автоматизация построена на встроенных экшенах Airtable  
(Send a message, Create record, Update record).

## Связанные таблицы

- `Tasks` — источник триггера
- `Waves` — создаётся новая запись

# Combinatorial — для итераций Builder

Airtable-секция автоматизаций для генерации рекламных креативов.  
Все автоматизации работают в базе **Creative Matrix**.

---

## Общий алгоритм работы

```
Task (статус меняется)
        │
        ▼
[1] Task update → create Wave+Slack
        │
        ├─ ToDo / InReview / NeedFix  →  Slack-уведомление
        │
        └─ InProgress + assembly_mode: Iteration   →  создать Wave (статус Run)
           InProgress + assembly_mode: Homunculus  →  создать Wave (статус Created)
                                                              │
                                                              ▼
                                                [2] Homunculus → Auto by rules / Only tagged
                                                       │
                                                       └─ Auto by rules  →  найти ассеты → статус Run
                                                          Only tagged    →  статус Run (ассеты уже проставлены)
        │
        ▼ (Wave.Status == "Run" && Recipes пусты)
[3] Wave Run → Generate Recipes
        │
        ├─ goal: Homunculus  →  стохастический подбор комбинаций ассетов
        ├─ goal: Iteration   →  детерминированный перебор комбинаций
        └─ goal: FreeOverlay →  найти Creatives с free_status=Queued → создать Recipes
                                                              │
                                                              ▼ (Wave.Status == "Print-CSV" && Recipes не пусты)
                                                [4] Wave Print-CSV → Builder
                                                       │
                                                       ├─ goal: Iteration / Homunculus / Screening
                                                       │         →  собрать payload → POST /api/v1/pipelines/
                                                       └─ goal: FreeOverlay
                                                                 →  заполнить таблицу Recipe Exports

[5] Button → CreoPriority  (независимая ветка, по нажатию кнопки в карточке Iteration)
        └─  создать запись в таблице CreoPriority
```

**Ключевые таблицы Airtable:**  
`Tasks` → `Waves` → `Constructors` / `Constructor Slots` → `Recipes` / `Recipe Slots` → `Packs` → `Creatives`

**Статусная машина волны (Wave.Status):**  
`Created` → `Run` → `Autofilled` → `Print-CSV` → `Printed`  
(при ошибке на любом шаге → `Error`)

---

## Структура репозитория

```
.
├── README.md                                        ← этот файл
└── automations/
    ├── 1_task-update_wave-slack/
    │   └── README.md                                ← описание автоматизации (без скрипта)
    ├── 2_homunculus_auto-by-rules_only-tagged/
    │   ├── script.js
    │   └── README.md
    ├── 3_wave-run_generate-recipes_homunculus/
    │   ├── script.js
    │   └── README.md
    ├── 3_wave-run_generate-recipes_iteration/
    │   ├── script.js
    │   └── README.md
    ├── 4_wave-print-csv_builder_main/
    │   ├── script.js
    │   └── README.md
    ├── 4_wave-print-csv_builder_free-overlay/
    │   ├── script.js
    │   └── README.md
    └── 5_button_creo-priority/
        └── README.md                                ← описание автоматизации (без скрипта)
```

---

## Автоматизации

### 1 · Task update → create Wave+Slack

**Триггер:** изменение поля `status` в таблице `Tasks`

| Условие | Действие |
|---|---|
| `ToDo` + Waves ID пуст + task_kind: combinatorial | Slack-сообщение → #Dima Sobolevskij |
| `InProgress` + assembly_mode: **Iteration** | Создать Wave → Update статус Wave на Run |
| `InProgress` + assembly_mode: **Homunculus** | Создать Wave |
| `InReview` | Slack-сообщение |
| `NeedFix` | Slack-сообщение → #Dima Sobolevskij |

JS-скрипта нет — автоматизация построена на встроенных экшенах Airtable.

---

### 2 · Homunculus → Auto by rules / Only tagged

**Триггер:** создание новой записи в таблице `Waves`  
**Условие:** `Status = Created` AND `goal = Homunculus`

| Ветка | Логика |
|---|---|
| `asset_source_mode = Auto by rules` | Find records #A (ассеты "for everyone") + Find records #B (ассеты "for a specific funnel") → JS-скрипт объединяет и линкует к Wave → Update Status → Run |
| `asset_source_mode = Only tagged` | Update Status → Run (ассеты уже проставлены вручную) |

**Скрипт:** `automations/2_homunculus_auto-by-rules_only-tagged/script.js`

---

### 3 · Wave Run → Generate Recipes

**Триггер:** `Wave.Status = Run` AND `Recipes is empty`

| Ветка | Логика |
|---|---|
| `goal = Homunculus` AND Constructor ID не пуст | JS: стохастический подбор уникальных комбинаций ассетов по слотам конструктора с учётом весов позиций, штрафов за повторения и ограничения суммарной длительности (≤ 60 с). Создаёт Recipes → Recipe Slots → Packs → Creatives → назначает музыку |
| `goal = Iteration` AND Constructor ID не пуст | JS: детерминированный перебор допустимых комбинаций по гранулярности слотов (brick / full_body). Поддерживает мультиплатформенность (Meta / AppLovin / Google) и мультиформат (9×16 / 16×9). Создаёт Recipes → Recipe Slots → Packs → Creatives → назначает музыку |
| `goal = Free Overlay` AND disclaimer ID не пуст | Найти Creatives с `free_status = Queued` → для каждого создать запись в Recipes → обновить `free_status` |

**Скрипты:**
- `automations/3_wave-run_generate-recipes_homunculus/script.js`
- `automations/3_wave-run_generate-recipes_iteration/script.js`

---

### 4 · Wave Print-CSV → Builder

**Триггер:** `Wave.Status = Print-CSV` AND `Recipes is not empty`

| Ветка | Логика |
|---|---|
| `goal = Iteration / Homunculus / Screening` | JS: собрать pipeline payload из Recipes + Recipe Slots + Assets + Overlays → Auth0 token → POST `https://mtech.fstr.app/api/public/v1/pipelines/` → Wave.Status = Printed |
| `goal = Free Overlay` | JS: очистить таблицу Recipe Exports → записать строки (source_video_path + overlay_path) → Wave.Status = Printed |

**Скрипты:**
- `automations/4_wave-print-csv_builder_main/script.js`
- `automations/4_wave-print-csv_builder_free-overlay/script.js`

---

### 5 · Button → CreoPriority

**Триггер:** нажатие кнопки в карточке Iteration  
**Действие:** создать запись в таблице `CreoPriority` с соответствующими предустановками  

JS-скрипта нет — автоматизация построена на встроенном экшене Airtable Create record.

---

## Changelog

| Дата | Автоматизация | Что изменилось |
|---|---|---|
| 2026-05-27 | Wave Run → Iteration | v5: поддержка платформы AppLovin (ALC), policy_of линковка |
| 2026-05-26 | Wave Run → Homunculus | v5: ограничение суммарной длительности концепта (≤ 60 с) |
| 2026-05-27 | Wave Print-CSV → Builder | v6: тёмный дисклеймер (disclaimer_style = black → dark_variant overlay) |
| 2026-05-21 | Wave Print-CSV → Builder | v5: поддержка стикера (Wave.sticker → overlay_all) |
| 2026-05-21 | Wave Run → Iteration | v4: resize-тег `-FullS` в creo_name для 16×9 |
| 2026-05-15 | Wave Run → Homunculus / Iteration | v4: мультиформат (9×16 / 16×9), Recipe.ratio |
| 2026-05-15 | Wave Run → Homunculus / Iteration | v3: создание Packs + Creatives после Recipe Slots |
| 2026-05-15 | Wave Print-CSV → Builder | v3/v4: ratio-aware overlays, multi-aspect-ratio source paths |

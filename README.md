# SAT SRS

PWA для интервального повторения SAT-лексики (цель 1550+, экзамен 05.12.2026). Замена Anki.

## Архитектура

- **Данные** — md-файлы с YAML-frontmatter в приватном repo `second-brain` (Obsidian vault), папка `Учёба/Карточки/`. Приложение — просто ещё один клиент этого repo (наряду с Obsidian и тьютор-агентом).
- **Синхронизация** — GitHub Git Data API напрямую из браузера (fine-grained PAT, только этот repo). Пачка изменений сессии = один коммит. Конфликты: приложение владеет только `fsrs`-блоком и `my_sentence`, остальное всегда берётся из удалённой версии.
- **Офлайн** — IndexedDB-кэш + dirty-флаги; оценки копятся локально и уезжают при появлении сети.
- **Планировщик** — [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) (FSRS-6), desired retention 0.90. Никакого самописного алгоритма.
- **Журнал ревью** — append-only ndjson помесячно в `Учёба/Карточки/_журнал/` (источник для true retention, серии и лимита новых; читается и тьютор-системой).

## Научная база → механики

1. **Retrieval practice** — единственный режим: вспомнить до показа ответа (Dunlosky 2013; Rowland 2014; Adesope 2017).
2. **FSRS-6 вместо SM-2** — точнее предсказывает память, меньше повторов при той же retention.
3. **Words in Context** — карточка = SAT-предложение с пропуском (cloze), не «слово-перевод».
4. **Interleaving** — новые и повторы перемешаны, источники не блоками.
5. **Метакогниция** — 4 оценки (Заново/Трудно/Хорошо/Легко) с показом прогнозного интервала.
6. **Защищённый минимум** — 15 мин/день или пустая очередь = день серии зачтён. Граница дня 04:00 локального времени.

## Схема карточки

```yaml
---
type: card
word: corroborate
pos: verb
meaning_en: "to confirm or give support to (a statement or theory)"
meaning_ru: "подтверждать, подкреплять (доказательствами)"
context: "New fossil evidence served to ______ the hypothesis…"
roots: "con- (вместе) + robur (сила)"
my_sentence: ""
source: seed        # seed | разбор-PT1 | manual | …
added: 2026-07-17
suspended: false
fsrs:
  state: 0          # 0 New · 1 Learning · 2 Review · 3 Relearning
  due: 2026-07-17T00:00:00Z
  stability: 0
  difficulty: 0
  elapsed_days: 0
  scheduled_days: 0
  learning_steps: 0
  reps: 0
  lapses: 0
  last_review: null
---
(тело файла — свободные заметки, приложение его не трогает)
```

Файл без `fsrs`-блока подхватывается как New — внешний агент может создавать карточки, зная только верхнюю часть схемы.

## Разработка

```bash
npm install
npm run icons   # генерация PNG-иконок из SVG
npm run dev     # dev-сервер
npm run build   # tsc + vite build → dist/
```

Стек: Vite 7 · React 19 · TypeScript · vite-plugin-pwa · ts-fsrs · js-yaml · idb. Без бэкенда.

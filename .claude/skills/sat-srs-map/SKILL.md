---
name: sat-srs-map
description: Карта проекта sat-srs (C:\Users\sasha\dev\sat-srs) — PWA-замена Anki для подготовки к SAT. Читай ПЕРЕД тем, как искать файлы или обходить структуру: где планировщик FSRS, синхронизация с vault через GitHub, экраны и хранилище. Экономит обход дерева на каждой сессии.
---

# sat-srs — карта

React + TypeScript + Vite, PWA. Интервальные повторения для SAT. Карточки лежат не в приложении, а в Obsidian-vault и тянутся через GitHub API. Живёт на `s4s4s4s.github.io/sat-srs`, деплой — GitHub Actions (`.github/workflows/deploy.yml`).

## Ядро — `src/lib/`

| Файл | Размер | Ответственность |
|---|---:|---|
| `scheduler.ts` | 19 КБ | **FSRS: интервалы, состояния карточек. Сердце приложения.** |
| `store.ts` | 17 КБ | глобальное состояние |
| `report.ts` | 15 КБ | метрики и отчёты по прогрессу |
| `sync.ts` | 13 КБ | синхронизация с vault |
| `db.ts` | 8,5 КБ | локальное хранилище (IndexedDB) |
| `demo.ts` | 8,5 КБ | демо-режим |
| `journal.ts` | 8 КБ | журнал ответов |
| `yamlfm.ts` | 6 КБ | парсинг YAML-frontmatter карточек |
| `github.ts` | 6 КБ | GitHub API — чтение и запись карточек |
| `types.ts` | 6 КБ | доменные типы |
| `daytime.ts`, `speech.ts` | 3 / 2 КБ | время суток; озвучка |

## Экраны — `src/screens/`

`Review.tsx` (33 КБ — самый крупный, основной цикл повторения), `Settings.tsx`, `Home.tsx`, `Stats.tsx`, `AddCard.tsx`, `Path.tsx`, `Summary.tsx`.

## Компоненты — `src/components/`

`FlameBuddy.tsx` (маскот стрика), `FjordScene.tsx` (фон), `Icon.tsx`, `Tex.tsx` (формулы).

Стили — один файл `src/styles.css` (56 КБ), не CSS-модули.

## Что важно знать

- **Предметы не смешивать.** Слова и математика — только отдельными разделами; interleaving допустим лишь внутри одного предмета. Нарушение этого — регресс, а не фича.
- Правки логики повторений почти всегда идут в `scheduler.ts`; правки «что видно на повторении» — в `screens/Review.tsx`.
- Источник карточек — vault, а не репозиторий: расхождения между приложением и карточками ищи в `sync.ts` / `github.ts`.
- `scripts/` — вспомогательное: `shots.mjs` (скриншоты), `make-icons.mjs` (иконки PWA).
- `package-lock.json` — 256 КБ, читать незачем.

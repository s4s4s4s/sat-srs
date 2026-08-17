import type { Card as FsrsCard } from 'ts-fsrs'

/** Карточка = md-файл в vault. fm — полный frontmatter как есть (чужие поля сохраняем). */
export interface CardRec {
  path: string          // repo-относительный путь, напр. "Учёба/Карточки/corroborate.md"
  sha: string | null    // blob sha на момент последней синхронизации (null = ещё не в repo)
  fm: Record<string, any>
  body: string          // тело файла после frontmatter — не трогаем
  dirty: number         // 1 = есть несинхронизированные изменения
  broken?: number       // 1 = frontmatter не разобрался; карточку не трогаем и не пишем
}

/** Типизированное представление карточки для UI/планировщика. */
export interface CardView {
  path: string
  slug: string
  word: string
  pos: string
  context: string
  contexts: string[]    // все контексты (ротация между показами); context = первый
  meaning_en: string
  meaning_ru: string
  roots: string
  source: string
  added: string         // дата добавления (для приоритета новых)
  level: number         // уровень ввода (Duolingo-путь); только у vocab (kind vocab, pos≠transition); 999 = без уровня, в хвост
  kind: string          // vocab | error | grammar | …
  domain: string        // домен College Board (II/CS/EOI/SEC/ALG/AM/PSDA/GEO)
  confusables: string[] // авторские «путаемые» дистракторы от тьютора — приоритетнее выборки из колоды
  leech: string         // дата пометки пиявкой (isLeech из metrics.ts: reps ≥ LEECH_REPS и stability < LEECH_STABILITY_DAYS), пусто = не пиявка
  choices: string[]     // авторские MC-варианты (error/grammar/math); пусто = дистракторы из колоды
  answerText: string    // правильный вариант для авторских choices
  answerNum: string     // числовой ответ (math): "15", "0.8", "4/5" — ввод с клавиатуры
  desmos: boolean       // задача решается через Desmos — бейдж в вопросе
  explain: string       // объяснение после ответа
  suspended: boolean
  fsrs: FsrsCard
  /** Управление/предлог (опционально): prep — ответ, prepContext — предложение с пропуском предлога */
  prep: string
  prepContext: string
  fsrsPrep: FsrsCard | null
}

/** Навык — отдельное знание со своим FSRS-графиком */
export type Skill = 'recall' | 'prep'

/** Формат упражнения: intro — знакомство с новым словом (показ без викторины) */
export type Format = 'intro' | 'reveal' | 'mc' | 'type' | 'prep'

/** Единица очереди: (карточка × навык) */
export interface StudyItem {
  view: CardView
  skill: Skill
  fsrs: FsrsCard
}

/** Строка журнала ревью (ndjson в vault). */
export interface JournalLine {
  id: string
  v?: number // версия схемы строки
  /* `read` — засчитанное чтение.

     Защищённый минимум состоит из двух половин: SRS 15 минут и чтение 30. Для
     второй половины инструмента не существовало вовсе — в «Метриках» семь
     недель подряд стоит «0/7 (не трекается)». Мерить нечем, значит и делать
     нечего: невидимая половина дисциплины отмирает первой. */
  type: 'review' | 'session' | 'read'
  ts: string   // ISO с локальным смещением
  ms?: number  // миллисекунды внутри секунды ts — тайбрейк хронологии (D1); в старых строках нет = 0
  day: string  // локальный день с rollover 04:00, YYYY-MM-DD — фиксируется при записи
  // review:
  slug?: string
  skill?: string       // recall | prep (отсутствует в старых строках = recall)
  format?: string      // intro | reveal | mc | type | prep
  correct?: boolean    // объективный результат (mc/type/prep); у reveal отсутствует
  typo?: boolean       // ошибка ввода = опечатка (Левенштейн), а не незнание — исключается из retention
  gave_up?: boolean    // C3/C4: пользователь сам признал незнание («не помню» / пустой ввод), не ошибка ввода
  cause?: string       // самоотчёт после ошибки: правило | слово | misread | логика | тайминг
  kind?: string        // тип карточки, если не vocab
  domain?: string      // домен College Board, если задан
  level?: number       // ступень слова на момент показа (retention по ступеням не врёт после переразметки)
  rating?: number      // 1 Again · 2 Hard · 3 Good · 4 Easy
  prev_state?: number  // 0 New · 1 Learning · 2 Review · 3 Relearning
  new_state?: number
  due?: string
  stability?: number
  scheduled_days?: number // плановый интервал из FSRS — точный бакет интервала без реконструкции
  elapsed_ms?: number
  // session:
  dur_ms?: number
  reviews?: number
  new_seen?: number
  acc?: number | null      // ретеншн по ЗРЕЛЫМ карточкам (prev_state = Review); null, если их не было
  acc_all?: number | null  // точность за урок по ВСЕМ оценкам — то, что видит ученик на итогах
  again?: number           // сколько раз за урок нажато «Заново» (включая честное «не помню»)
  queue_empty?: boolean
  // read:
  read_min?: number        // засчитанные минуты чтения
  what?: string            // что читал, свободной строкой — по нему потом видно, что работает
}

export interface JournalRec extends JournalLine {
  synced: number // 1 = уже в repo
}

export interface Settings {
  v: number // версия набора настроек; расхождение с SETTINGS_VERSION запускает миграцию
  pat: string
  owner: string
  repo: string
  branch: string
  basePath: string
  newPerDay: number
  newPerLesson: number
  requestRetention: number
  pauseFrom: string // плановая пауза (переезд): серия не рвётся и не растёт, YYYY-MM-DD
  pauseTo: string
  homeOffset: string // домашний пояс в минутах от UTC ('' = часы устройства, '180' = Москва, '240' = Ереван)
  typing: boolean // участвует ли ввод слова по буквам в ротации Review (см. REVIEW_CYCLE)
}

/* Версия настроек.
   Настройки читались как `{ ...DEFAULT_SETTINGS, ...сохранённое }`, поэтому
   правка дефолта не доезжала до уже установленного PWA НИКОГДА: сохранённый
   объект перекрывал её целиком. Два поля из-за этого молча ломали продукт —
   окно паузы и часовой пояс. Версия и миграция в `store.loadSettings` чинят
   именно этот класс: поле, которое пользователь не может починить руками,
   потому что не знает о его существовании. */
export const SETTINGS_VERSION = 5

export const DEFAULT_SETTINGS: Settings = {
  v: SETTINGS_VERSION,
  pat: '',
  owner: 's4s4s4s',
  repo: 'sat-deck',
  branch: 'main',
  basePath: 'Учёба/Карточки',
  /* Дневная норма — 8, а не прежние 15. Ввод пачками уже раз спровоцировал половину
     нынешних проблем: 27.07 в колоду вошло 187 показов за день, и подрасти
     стабильность не успела ни у одной просевшей карточки. Прежний дефолт до уже
     установленного PWA не доедет сам — миграция v4 (store.ts::SETTINGS_MIGRATIONS)
     принудительно доносит новое число. */
  newPerDay: 8,
  /* Новых слов за урок.
     Было 3, и это оказалось настоящим потолком, а не подсказкой: чтобы взять
     дневные 15, урок приходилось запускать пять раз — за десять активных дней
     набралось 41 сессия, а 27.07 шесть подряд по пять минут. Плюс повторное
     знакомство («Подзабылось») тратит тот же счётчик, и 36 окон из 85 ушли на
     переznakomство вместо новых слов. Пять за урок — три захода вместо пяти
     при той же дневной норме. */
  newPerLesson: 5,
  requestRetention: 0.9,
  /* Окно переезда ЗАКРЫТО 05.08.2026.
     Стояло 29.07–16.08, то есть приложение само разрешало не заниматься ещё
     одиннадцать дней при 59 оставшихся до 03.10. Переезд в Ереван состоялся
     29.07; окно оставлено историческим (29.07–04.08), чтобы дни переезда не
     считались срывом задним числом, но сегодня и дальше пауза не действует. */
  pauseFrom: '2026-07-29',
  pauseTo: '2026-08-04',
  homeOffset: '240', // Ереван (UTC+4); было 180 — Москва, граница учебного дня уезжала на час
  /* Ввод по буквам включён с 17.08.2026 — но теперь это один шаг ротации из
     четырёх, а не основной формат. Выключали его 05.08 по двум причинам: он
     занимал 271 показ из 472, и с 26.07 у Александра была сломана левая рука.
     Оба основания отпали (рука зажила, доля ввода упала вчетверо), а без
     производства словарь проверяется только узнаванием — ровно то, из-за чего
     практика и встала. */
  typing: true
}

export type Screen = 'home' | 'review' | 'summary' | 'add' | 'stats' | 'settings' | 'path'

export interface SessionResult {
  day: string       // учебный день, зафиксированный на старте сессии (не в момент финиша)
  reviews: number
  newSeen: number
  again: number
  passRev: number   // прошедшие (rating>1) среди prev_state=2
  totalRev: number  // всего оценок карт в состоянии Review
  durMs: number
  queueEmpty: boolean
}

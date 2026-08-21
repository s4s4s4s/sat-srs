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
  contextsRu: string[]  // перевод предложений, по индексу совпадает с contexts; пусто = перевода нет
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

/** Словарная сноска текста: только трудные леммы (вне частотного ядра и вне колоды уровня ≤ level). */
export interface GlossEntry {
  word: string
  pos: string
  meaning_en: string
  meaning_ru: string
}

/**
 * Текст для чтения = md-файл в каталоге `Чтение` рядом с колодой (`_КОНТРАКТ.md`, раздел «Чтение»).
 *
 * Отдельная сущность, а не карточка с особым `kind`: у текста нет и НЕ БУДЕТ FSRS-графика —
 * его не повторяют, его читают. Общее хранилище с карточками означало бы, что текст попадает
 * в очередь планировщика, в дневную норму ввода и в ретеншн; развести это потом фильтрами
 * дороже, чем держать две сущности сразу.
 *
 * `dirty` у текста нет намеренно: приложение тексты только читает. Единственное, что оно
 * пишет по поводу текста, — строки журнала (`mark`, `reading`), а они уезжают своим каналом.
 */
export interface ReadingRec {
  path: string          // repo-относительный путь, напр. "Учёба/Чтение/2-01-reef.md"
  sha: string           // blob sha на момент последней синхронизации
  fm: Record<string, any>
  body: string          // тело файла после frontmatter — сам текст
  broken?: number       // 1 = frontmatter не разобрался; текст не показываем
}

/** Типизированное представление текста для UI. */
export interface ReadingView {
  path: string
  slug: string          // имя файла без расширения ("2-01-reef") — им же адресуются отметки
  title: string
  level: number         // та же шкала 1–6, что у слов; 999 = уровень не проставлен, в хвост
  order: number         // порядок внутри ступени; 999 = не проставлен
  words: number         // число токенов тела: fm.words, а при его отсутствии — реальный счёт
  added: string
  glossary: GlossEntry[]
  text: string          // тело файла без обрамляющих пустых строк
  broken: boolean       // frontmatter не разобрался — показывать нечего
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
  /* `mark` — отметка незнакомого слова при чтении, `reading` — прочтение текста целиком.

     Имена намеренно разведены с уже занятым `read`: тот считает МИНУТЫ чтения
     чего угодно (защищённый минимум дня), а `reading` относится к конкретному
     тексту колоды. Смешать их в одном типе нельзя — минуты суммируются по дню,
     прочтения считаются поштучно по слагу. */
  type: 'review' | 'session' | 'read' | 'mark' | 'reading'
  ts: string   // ISO с локальным смещением
  ms?: number  // миллисекунды внутри секунды ts — тайбрейк хронологии (D1); в старых строках нет = 0
  day: string  // локальный день с rollover 04:00, YYYY-MM-DD — фиксируется при записи
  // review:
  slug?: string
  skill?: string       // recall | prep (отсутствует в старых строках = recall)
  format?: string      // intro | reveal | mc | type | prep
  correct?: boolean    // объективный результат (mc/type/prep); у reveal отсутствует
  typo?: boolean       // ошибка ввода = опечатка (Левенштейн), а не незнание — исключается из retention
  twin?: boolean       // введён синоним из колоды (C10): значение вспомнено, форма — нет; из retention исключается
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
  // mark:
  /* Источник отметки: `reading:<слаг текста>` сейчас, `card:<слаг карточки>` — когда
     такие же отметки пойдут из упражнений. Префикс, а не отдельное поле «вид источника»:
     одна строка сравнивается и группируется как есть, и разбор источника нужен только
     тому, кто захочет разделить их по видам (readingSrc в journal.ts). */
  src?: string
  word?: string            // слово ровно в той форме, в какой стояло в тексте
  lemma?: string           // словарная форма — по ней отметка и опознаётся (см. markKey)
  sentence?: string        // предложение, в котором встретилось: строка самодостаточна и переживает удаление текста
  in_deck?: boolean        // слово уже было в колоде на момент отметки (историческая правда, не текущее состояние)
  /* Снятие отметки — это строка `on: false`, а не удаление предыдущей: журнал append-only
     и сливается объединением по id, удалять из него нечего (см. markState в journal.ts).
     Отсутствие поля читается как `true`: строка отметки без `on` — поставленная отметка. */
  on?: boolean
  // reading:
  marks?: number           // сколько слов осталось отмечено в тексте на момент прочтения
  passed?: boolean         // взят ли порог понятности текста (readingPassed в journal.ts)
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
  /* Норм ввода в настройках больше нет: источник правды — norms.ts
     (`NEW_PER_DAY`, `NEW_PER_LESSON`). Свободные поля позволяли выставить любое
     число и делали норму невидимой; теперь уровни показаны засечками на полосе
     дня, а не выбираются руками. Мёртвые ключи снимает миграция v8. */
  requestRetention: number
  pauseFrom: string // плановая пауза (переезд): серия не рвётся и не растёт, YYYY-MM-DD
  pauseTo: string
  homeOffset: string // домашний пояс в минутах от UTC ('' = часы устройства, '180' = Москва, '240' = Ереван)
  typing: boolean // участвует ли ввод слова по буквам в ротации Review (см. REVIEW_CYCLE)
  sound: boolean // звуковые сигналы урока (src/lib/sound.ts)
  /* Токен разборщика для кнопки «Почему?» (src/lib/coach.ts). Разбор пишет Claude
     Code на домашней машине под подпиской, а не платный API, — этим токеном
     приложение представляется очереди нарядов. Живёт там же, где токен GitHub:
     в настройках устройства, в коде и в репозитории его нет. Пусто = кнопка
     объясняет, чего не хватает, вместо запроса. */
  coachToken: string
}

/* Версия настроек.
   Настройки читались как `{ ...DEFAULT_SETTINGS, ...сохранённое }`, поэтому
   правка дефолта не доезжала до уже установленного PWA НИКОГДА: сохранённый
   объект перекрывал её целиком. Два поля из-за этого молча ломали продукт —
   окно паузы и часовой пояс. Версия и миграция в `store.loadSettings` чинят
   именно этот класс: поле, которое пользователь не может починить руками,
   потому что не знает о его существовании. */
export const SETTINGS_VERSION = 8

export const DEFAULT_SETTINGS: Settings = {
  v: SETTINGS_VERSION,
  pat: '',
  owner: 's4s4s4s',
  repo: 'sat-deck',
  branch: 'main',
  basePath: 'Учёба/Карточки',
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
  typing: true,
  /* Звук включён по умолчанию: обратная связь урока — часть механики,
     а не украшение. Выключается в настройках одним тумблером. */
  sound: true,
  coachToken: '',
}

export type Screen = 'home' | 'review' | 'summary' | 'add' | 'stats' | 'settings' | 'path' | 'reading'

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

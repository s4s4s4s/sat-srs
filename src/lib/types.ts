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

/** Одно из значений слова, помимо основного (meaning_en/meaning_ru) - fm.other_senses. */
export interface Sense {
  pos: string
  en: string
  ru: string
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
  confusables: string[] // авторские «путаемые» дистракторы от тьютора, приоритетнее выборки из колоды
  synonyms: string[]    // допустимые ответы ввода помимо word; задаёт тьютор
  other_senses: Sense[] // остальные значения слова (fm.other_senses); нет поля = ещё не сверено, [] = сверено, других нет
  from_mark: string[]   // формы, в которых владелец отметил это слово как незнакомое (см. liveMarkedLemmas в journal.ts);
                        // пусто, если карточка добавлена не из живой отметки — совпадение по word тоже поднимает ввод
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

/**
 * Вопрос практики = md-файл в каталоге `Учёба/Вопросы` (сосед `Учёба/Карточки` и `Учёба/Чтение`) —
 * настоящий вопрос SAT с четырьмя вариантами и разбором, готовит его инструмент пк-контура.
 *
 * Отдельная сущность, а не карточка: у вопроса нет и не будет FSRS-графика. Карточка проверяет
 * ПАМЯТЬ о слове через интервалы; повторный показ уже решённого вопроса проверял бы память
 * об ответе, а не навык, — FSRS здесь бессмысленен так же, как у текста для чтения
 * (см. ReadingRec). Формат файла зафиксирован инструментом, который его пишет, и приложением
 * не меняется.
 *
 * `dirty` нет намеренно: приложение вопросы только читает, как и тексты для чтения.
 */
export interface QuestionRec {
  path: string          // repo-относительный путь, напр. "Учёба/Вопросы/rhetorical-synthesis-medium-afec1a70.md"
  sha: string | null    // blob sha на момент последней синхронизации (null = ещё не в repo)
  fm: Record<string, any>
  body: string          // тело файла после frontmatter: разделы «## Вопрос» / «## Варианты» / «## Разбор»
  broken?: number       // 1 = frontmatter или тело не разобрались; вопрос не показываем
}

/** Один вариант ответа вопроса практики. */
export interface QuestionChoice {
  letter: 'A' | 'B' | 'C' | 'D'
  text: string
}

/** Типизированное представление вопроса практики для UI/статистики. */
export interface QuestionView {
  path: string
  qid: string
  assessment: string
  test: string
  domain: string
  skill: string
  difficulty: string
  stem: string                // условие (проза); может содержать строки списка "- "
  choices: QuestionChoice[]   // ровно 4 варианта A–D у целого вопроса
  answer: 'A' | 'B' | 'C' | 'D' | '' // правильный вариант; пусто, если раздела «## Разбор» нет
  rationale: string           // разбор; пусто, если раздела не было
  added: string
  broken: boolean
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
  type: 'review' | 'session' | 'read' | 'mark' | 'reading' | 'practice'
  ts: string   // ISO с локальным смещением
  ms?: number  // миллисекунды внутри секунды ts — тайбрейк хронологии (D1); в старых строках нет = 0
  day: string  // локальный день с rollover 04:00, YYYY-MM-DD — фиксируется при записи
  // review:
  slug?: string
  skill?: string       // recall | prep (отсутствует в старых строках = recall); у practice — навык вопроса (fm.skill)
  format?: string      // intro | reveal | mc | type | prep
  correct?: boolean    // объективный результат (mc/type/prep, а также practice); у reveal отсутствует
  typo?: boolean       // ошибка ввода = опечатка (Левенштейн), а не незнание — исключается из retention
  twin?: boolean       // введён синоним из колоды (C10): значение вспомнено, форма — нет; из retention исключается
  cued?: boolean       // C12: взято со скелета слова после провала, оценка Hard, из retention исключается как typo/twin
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
  scheduled_days?: number // план до следующего показа; для бакетов интервала не годится, см. elapsed_days
  elapsed_days?: number   // фактический интервал с прошлого показа по FSRS (целые сутки), по нему бакетируется retention
  elapsed_ms?: number
  /* F20: время от показа до САМОГО ОТВЕТА, без чтения вердикта и разбора после него.
     elapsed_ms доезжает до кнопки «Дальше» и потому включает чтение объяснения -
     порог «медленно» (slowThresholdMs), калиброванный по elapsed_ms, оказывался
     завышен временем чтения, а не ответа: 13% строк живого журнала выше такого
     порога против 5% реально поставленных Hard. Пишется, только когда у показа
     есть отдельный момент ответа (submitObjective/giveUp/revealAnswer) - у знакомства
     (intro) его нет, и поле остаётся пустым. C12: подсказка (скелет слова) начинает отсчёт
     заново - в поле уезжает время ВТОРОЙ попытки, от раскрытия подсказки до ответа, без
     первой попытки и без чтения подсказки. Иначе слово, вспомненное со скелета за три
     секунды, приходило бы в slowThresholdMs минутой раздумий над первой попыткой. Старые строки без него читаются через
     запасной elapsed_ms (medianForKind/speedStats, metrics.ts), см. answerTimeOf. */
  answer_ms?: number
  // session:
  dur_ms?: number
  reviews?: number
  new_seen?: number
  acc?: number | null      // ретеншн по ЗРЕЛЫМ карточкам (prev_state = Review); null, если их не было
  acc_all?: number | null  // точность за урок по ВСЕМ оценкам - то, что видит ученик на итогах
  again?: number           // сколько раз за урок нажато «Заново» (включая честное «не помню»)
  /* L2: сколько ответов за урок угадано со скелета слова (не входит в acc_all). Названо не
     `cued`, чтобы не столкнуться по типу с полем review-строки выше (`cued?: boolean` -
     C12, признак ОДНОГО ответа): JournalLine - плоский интерфейс на все типы строк, и то же
     имя с другим типом (`number`) TS не пропускает (Duplicate identifier). */
  session_cued?: number
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
  /* Секунды над текстом. Вместе с `words` текста даёт темп чтения — единственный
     объективный вход для калибровки ступеней. Пишется только у измеренного чтения:
     у строк до 22.08.2026 поля нет, и это не пропуск, а «не измеряли». */
  read_s?: number
  // practice:
  /* Ответ на настоящий вопрос SAT (`Учёба/Вопросы`). Отдельный тип, не `review`: у вопроса нет
     FSRS-графика (см. QuestionRec), и оценка здесь не двигает никакого расписания — это просто
     факт «ответил на вопрос X так-то», нужный для очереди practice.ts (pickPractice) и сводки
     (practiceStats). */
  qid?: string         // qid вопроса (fm.qid из файла)
  difficulty?: string  // сложность вопроса на момент ответа (fm.difficulty)
  chose?: string       // буква, которую выбрал ученик (A|B|C|D)
  sec?: number         // секунды над вопросом; отсутствует у неизмеренных ответов
  /* Флаг мягкого таймера (D5, PACE_SEC в practice.ts): true, если ответ пришёл после 71 с
     над вопросом. Таймер ничего не блокирует и не аннулирует ответ - это только отметка
     темпа для разреза practiceBreakdown, добавлено поле, старые строки без него читаются
     как "в темпе" (правило D3: только добавление полей). */
  slow?: boolean
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

export type Screen = 'home' | 'review' | 'summary' | 'add' | 'stats' | 'settings' | 'path' | 'reading' | 'words' | 'practice'

export interface SessionResult {
  day: string       // учебный день, зафиксированный на старте сессии (не в момент финиша)
  reviews: number
  newSeen: number
  again: number
  passRev: number   // прошедшие (rating>1) среди prev_state=2
  totalRev: number  // всего оценок карт в состоянии Review
  durMs: number
  queueEmpty: boolean
  /** WS5b: цель захода (goal в состоянии сессии, store.ts) достигнута к моменту финиша -
   *  считает Review.tsx по дневному счётчику упражнений (reviewsByDay/practiceUnitsByDay
   *  плюс эта сессия), не по одному lock r.reviews сессии. Summary.tsx решает по этому
   *  полю, показывать ли «заход закрыт» и кнопку «ещё заход». */
  goalReached: boolean
  /** WS5b (часть 2): дневной счётчик упражнений на момент финиша (baseUnits + reviews этой
   *  сессии) - та же величина, что показывает счётчик «N из goal» на экране. Summary.tsx
   *  печатает по ней «до цели ещё K», K = sessionGoal - doneToday, не пересчитывая заново. */
  doneToday: number
  /* L2: сколько раз за урок ввод угадан со скелета слова (verdict === 'cued', оценка Hard).
     Необязательное поле - старые вызовы и демо-данные без него читаются как 0, sessionAccuracy
     (journal.ts) отсекает cued из точности урока вслед за accuracyShare (metrics.ts). */
  cued?: number
}

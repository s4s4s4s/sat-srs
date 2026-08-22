import { State } from 'ts-fsrs'
import type { JournalLine, JournalRec } from './types'
import { addDaysKey, dayKey } from './daytime'

export const MIN_MINUTES = 15          // защищённый минимум SRS
export const READ_MIN_MINUTES = 30     // вторая половина минимума — чтение
export const CARD_TIME_CAP_MS = 60_000 // AFK-защита: на карточку в зачёт минут — максимум 60 c
export const READ_CAP_MINUTES = 180    // разумный потолок одной отметки чтения

/**
 * Порог «опечатка, а не незнание» при вводе (checkTyped): <= TYPO_MAX_EDITS правок Левенштейна
 * при длине искомого слова >= TYPO_MIN_LEN. Мотив из данных: bolster ×9, scrutinize ×8,
 * corroborate ×7, ambivalent ×6 за 14 дней — это орфография, но засчитывалась как провал памяти
 * и рушила и расписание, и метрику. Опечатка помечается typo:true, исключается из retention и
 * не обрушает интервал FSRS (см. suggestedGrade → Good, Review.tsx — переспрос в этом же уроке).
 */
export const TYPO_MIN_LEN = 6
export const TYPO_MAX_EDITS = 2

export function newId(): string {
  // crypto.randomUUID есть только в secure context и Safari ≥ 15.4 — фолбэк на getRandomValues
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/**
 * Разбор ndjson: валидная строка обязана иметь строковые id, ts и day.
 * Невалидные-но-непустые строки возвращаются сырыми — при перезаписи месяца
 * они сохраняются как есть (чужие данные не теряем и не даём одной кривой
 * строке заблокировать push со всех устройств).
 */
export function parseNdjson(text: string): { lines: JournalLine[]; rejects: string[] } {
  const lines: JournalLine[] = []
  const rejects: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try {
      const o = JSON.parse(line)
      if (o && typeof o === 'object' && typeof o.id === 'string' && typeof o.ts === 'string' && typeof o.day === 'string') {
        lines.push(o as JournalLine)
      } else {
        rejects.push(line)
      }
    } catch {
      rejects.push(line)
    }
  }
  return { lines, rejects }
}

/**
 * Хронологический порядок строк журнала. `ts` пишется с точностью до секунды, поэтому оценка
 * и завершение сессии в одну секунду сравнивались как равные, а фактический порядок задавала
 * выдача IndexedDB (ключ = случайный uuid) — отсюда нарушения D1: строка `session` оказывалась
 * в файле раньше последней `review` своей сессии, а `forcedTodaySlugs` рвал сессию не там.
 * Тайбрейк — миллисекунды внутри секунды (`ms`, D3: схема расширяется добавлением поля;
 * старые строки без него читаются как ms = 0 и сохраняют свой относительный порядок).
 */
export function byTime(a: JournalLine, b: JournalLine): number {
  const t = (typeof a.ts === 'string' ? a.ts : '').localeCompare(typeof b.ts === 'string' ? b.ts : '')
  return t !== 0 ? t : (a.ms ?? 0) - (b.ms ?? 0)
}

export function toNdjson(lines: JournalLine[], rawExtras: string[] = []): string {
  const sorted = [...lines].sort(byTime)
  const body = sorted.map(l => JSON.stringify(stripSynced(l)))
  const all = [...body, ...rawExtras]
  return all.join('\n') + (all.length ? '\n' : '')
}

function stripSynced(l: JournalLine): JournalLine {
  const { ...rest } = l as JournalRec
  delete (rest as any).synced
  return rest
}

/**
 * Точность УРОКА: доля непровальных ответов среди всех оценок сессии.
 * Итоги урока раньше показывали ретеншн по зрелым карточкам (`passRev/totalRev`), и после
 * 41 упражнения с 13 «Заново» экран выдавал «повторов 1 · точность 100%» — потому что зрелой
 * в том уроке была одна карточка. Ретеншн остаётся отдельной строкой (matureRetention):
 * он нужен FSRS-диагностике, но не описывает проделанную работу.
 */
export function sessionAccuracy(r: { reviews: number; again: number }): number | null {
  return r.reviews > 0 ? Math.round(((r.reviews - r.again) / r.reviews) * 100) : null
}

/** Ретеншн по зрелым карточкам урока (prev_state = Review): null, если зрелых не было. */
export function matureRetention(r: { passRev: number; totalRev: number }): number | null {
  return r.totalRev > 0 ? Math.round((r.passRev / r.totalRev) * 100) : null
}

/** Кап зачётного времени на карточку: math-задачи решаются дольше слов */
export function cardTimeCap(kind?: string): number {
  return kind === 'math' ? 180_000 : CARD_TIME_CAP_MS
}

/** Минуты ревью по дням (с капом на карточку) */
export function minutesByDay(lines: JournalLine[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const l of lines) {
    if (l.type !== 'review') continue
    const ms = Math.min(l.elapsed_ms ?? 0, cardTimeCap(l.kind))
    m.set(l.day, (m.get(l.day) ?? 0) + ms / 60000)
  }
  return m
}

/** Минуты ЧТЕНИЯ по дням — вторая половина защищённого минимума.
 *  Считается отдельно от SRS намеренно: это разные навыки, и подменять
 *  тридцать минут чтения пятнадцатью минутами карточек нельзя. */
export function readMinutesByDay(lines: JournalLine[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const l of lines) {
    if (l.type !== 'read') continue
    const min = Math.min(Math.max(l.read_min ?? 0, 0), READ_CAP_MINUTES)
    m.set(l.day, (m.get(l.day) ?? 0) + min)
  }
  return m
}

export function readMinutesToday(lines: JournalLine[], today: string = dayKey()): number {
  return readMinutesByDay(lines).get(today) ?? 0
}

/** Оценок (упражнений) по дням — основа нижнего порога дня. */
export function reviewsByDay(lines: JournalLine[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const l of lines) {
    if (l.type !== 'review') continue
    m.set(l.day, (m.get(l.day) ?? 0) + 1)
  }
  return m
}

/** Дни, где очередь была добита до конца.
 *
 *  Требование `reviews > 0` — не придирка. Пустая очередь засчитывалась
 *  автоматически при РЕНДЕРЕ главного экрана, без единого упражнения: из 41
 *  сессии 19 несли `queue_empty`, а порог в 15 минут не был взят ни разу за всю
 *  историю. То есть серия три недели держалась на открытии приложения.
 *  Добитая очередь остаётся законным зачётом — но только когда её добивали. */
export function emptyDays(lines: JournalLine[]): Set<string> {
  const s = new Set<string>()
  for (const l of lines) if (l.type === 'session' && l.queue_empty && (l.reviews ?? 0) > 0) s.add(l.day)
  return s
}

/** Пол дня: держит серию. Один «заход» — столько упражнений, сколько влезает
 *  в две минуты по замеренной скорости (медиана ответа 7,4 с). */
export const RUN_MIN_REVIEWS = 12

/**
 * Порогов у дня два, и это осознанно.
 *
 * Был один — 15 минут — и за 41 сессию он не был взят НИ РАЗУ: медиана урока
 * 0,78 минуты, максимум 12,2. Порог, который не берут никогда, не дисциплинирует,
 * а обесценивает: 31.07 человек вернулся после трёх дней тишины, сделал 30
 * упражнений за 4,4 минуты и получил «день не зачтён» и серию 0. После этого не
 * открывал приложение пять дней.
 *
 * Нижний порог (заход) держит серию, верхний (15 минут) остаётся нормой дня и
 * показывается отдельной строкой. Норма не размывается — она перестаёт быть
 * условием того, чтобы день вообще засчитался.
 */
export function isDayDone(day: string, minutes: Map<string, number>, empty: Set<string>, reviews?: Map<string, number>): boolean {
  return (minutes.get(day) ?? 0) >= MIN_MINUTES
    || (reviews?.get(day) ?? 0) >= RUN_MIN_REVIEWS
    || empty.has(day)
}

/** Норма дня (верхний порог) — отдельно от пола, для строки прогресса. */
export function isDayFull(day: string, minutes: Map<string, number>, empty: Set<string>): boolean {
  return (minutes.get(day) ?? 0) >= MIN_MINUTES || empty.has(day)
}

/**
 * Сколько из последних `window` дней закрыты полом (сегодня включительно).
 *
 * Это второе число главного экрана и единственное, которое зависит только от
 * поведения. Первое («сколько слов готово») по построению не может двигаться
 * ежедневно: стабильность растёт скачками и с задержкой. Число, которое человек
 * может изменить сегодня, обязано быть на экране — иначе экран сообщает только
 * то, что всё плохо, и делать с этим нечего.
 */
export function floorDays(lines: JournalLine[], today: string = dayKey(), window = 14): { done: number; window: number } {
  const minutes = minutesByDay(lines)
  const empty = emptyDays(lines)
  const reviews = reviewsByDay(lines)
  let done = 0
  for (let i = 0; i < window; i++) {
    if (isDayDone(addDaysKey(today, -i), minutes, empty, reviews)) done++
  }
  return { done, window }
}

export interface StreakInfo {
  days: number
  todayDone: boolean
  freezes: number // банк заморозок: 1 за каждые 7 закрытых дней подряд, максимум 2
  toFreeze: number // дней до следующей заморозки (0 = банк полон)
  pausedToday: boolean // сегодня — плановая пауза (переезд)
  freezeSpentYesterday: boolean // вчера заморозка спасла серию — сказать об этом
}

export interface PauseRange { from: string; to: string }

/**
 * Серия с заморозками (проход вперёд от первого дня журнала):
 * закрытый день продолжает серию, каждые 7 подряд дают заморозку (банк ≤ 2),
 * пропущенный день сжигает заморозку вместо серии; сегодня не судим до конца дня.
 * Дни плановой паузы прозрачны: серия не рвётся, не растёт, заморозки не тратятся.
 */
export function streak(lines: JournalLine[], today: string = dayKey(), pause?: PauseRange | null): StreakInfo {
  const minutes = minutesByDay(lines)
  const empty = emptyDays(lines)
  const reviews = reviewsByDay(lines)
  const done = (d: string) => isDayDone(d, minutes, empty, reviews)
  const inPause = (d: string) => !!(pause && pause.from && pause.to && d >= pause.from && d <= pause.to)
  const activeDays = [...new Set(lines.map(l => l.day))].filter(Boolean).sort()
  if (!activeDays.length) return { days: 0, todayDone: false, freezes: 0, toFreeze: 7, pausedToday: inPause(today), freezeSpentYesterday: false }

  const yesterday = addDaysKey(today, -1)
  let run = 0
  let bank = 0
  let sinceEarn = 0
  let freezeSpentYesterday = false
  let d = activeDays[0]
  while (d < today) {
    if (inPause(d)) {
      // пауза: день прозрачен (но занятия в паузе всё равно засчитываются в run)
      if (done(d)) { run++ }
    } else if (done(d)) {
      run++
      sinceEarn++
      if (sinceEarn >= 7) { bank = Math.min(2, bank + 1); sinceEarn = 0 }
    } else if (bank > 0) {
      bank-- // заморозка сгорает вместо серии
      if (d === yesterday) freezeSpentYesterday = true
    } else {
      run = 0
      sinceEarn = 0
    }
    d = addDaysKey(d, 1)
  }
  const todayDone = done(today)
  if (todayDone) {
    run++
    if (!inPause(today)) {
      sinceEarn++
      if (sinceEarn >= 7) { bank = Math.min(2, bank + 1); sinceEarn = 0 }
    }
  }
  return { days: run, todayDone, freezes: bank, toFreeze: bank >= 2 ? 0 : 7 - sinceEarn, pausedToday: inPause(today), freezeSpentYesterday }
}

/** Точность по форматам за 30 дней (review-показы): mc/type/prep — по correct, reveal — по rating>1 */
export function retentionByFormat(lines: JournalLine[], today: string = dayKey()): Record<string, { pass: number; total: number }> {
  const from = addDaysKey(today, -29)
  const acc: Record<string, { pass: number; total: number }> = {}
  for (const l of lines) {
    if (l.type !== 'review' || !l.day || l.day < from) continue
    if (l.prev_state !== State.Review || l.typo || l.twin) continue
    const f = l.format ?? 'reveal'
    if (f === 'intro') continue
    acc[f] ??= { pass: 0, total: 0 }
    acc[f].total++
    const ok = l.correct !== undefined ? l.correct : (l.rating ?? 0) > 1
    if (ok) acc[f].pass++
  }
  return acc
}

/** True retention за 30 дней: доля rating>1 среди оценок карточек в состоянии Review */
export function trueRetention30(lines: JournalLine[], today: string = dayKey()): { pct: number | null; n: number } {
  const from = addDaysKey(today, -29)
  let pass = 0
  let total = 0
  for (const l of lines) {
    if (l.type !== 'review' || l.prev_state !== State.Review || l.typo || l.twin) continue
    if (l.day < from || l.day > today) continue
    total++
    if ((l.rating ?? 0) > 1) pass++
  }
  return { pct: total ? Math.round((pass / total) * 100) : null, n: total }
}

/** Сколько новых учебных единиц (слово × навык) уже введено в этот учебный день */
/**
 * Сколько новых единиц введено в этот учебный день. `slugs` сужает счёт до одного
 * раздела, и это не удобство, а условие правильности: пока лимит был один на всю
 * колоду, урок слов съедал его целиком, и блок «Грамматика» рисовал «Всё повторено»
 * поверх двадцати НИ РАЗУ не показанных карточек — с погашенной кнопкой. Предметы у
 * нас разведены по разделам, значит и дневная норма ввода считается по предмету.
 */
export function newIntroducedOn(lines: JournalLine[], day: string, slugs?: ReadonlySet<string>): number {
  const seen = new Set<string>()
  for (const l of lines) {
    if (l.type === 'review' && l.day === day && l.prev_state === State.New && l.slug) {
      if (slugs && !slugs.has(l.slug)) continue
      seen.add(`${l.slug}#${l.skill ?? 'recall'}`)
    }
  }
  return seen.size
}

export function minutesToday(lines: JournalLine[], today: string = dayKey()): number {
  return minutesByDay(lines).get(today) ?? 0
}

/**
 * Слова, введённые в этот учебный день и подлежащие обязательной отработке (point 3/4).
 * Механизм — вывод из журнала (без нового поля в карточке): слово считается введённым
 * сегодня, если у него есть recall-строка этого дня с format:intro или prev_state:0.
 * Пометка снимается, когда слово отработано (не-intro recall) в ДВУХ отдельных сессиях
 * ПОСЛЕ сессии знакомства — сессии разделяются строками type:session. До этого слово
 * принудительно добирается в последующие уроки дня; со сменой учебного дня список пуст.
 *
 * ПРАВИЛО КАСАЕТСЯ ТОЛЬКО СЛОВАРЯ (`kind: vocab`). Оно построено на устройстве
 * знакомства со СЛОВОМ: окно `intro` рейтинга не даёт (A7), поэтому день, в который
 * слово впервые показано, обязан содержать ещё и отработки — иначе слово уйдёт спать
 * непроверенным. У упражнения (разбор ошибки, грамматика, математика) окна-знакомства
 * нет вовсе: первый же показ — полноценный вопрос с оценкой.
 *
 * Признак `prev_state:0` этого не различал, и под правило попадало КАЖДОЕ упражнение,
 * впервые показанное сегодня: урок был обязан вернуть его ещё дважды. Замер по журналу
 * за 21.08.2026: `log-cs-cel-teksta-ne-tema` показан трижды за восемь минут, а
 * `log-ii-most-trebuet-cifry` — семь раз за семнадцать часов. Второй показ одного и того
 * же вопроса через две минуты не проверяет приём рассуждения: ответ помнится, а не
 * выводится, и в модель уходит «верно», которого не было. Жалоба владельца 22.08.2026
 * («все упражнения в одном уроке по второму кругу пошли») — ровно этот путь.
 *
 * Сколько раз за день показывать упражнение, решает не это правило, а срок:
 * `holdExerciseToNextDay` (scheduler.ts) не даёт упражнению вернуться в тот же день.
 */
export function forcedTodaySlugs(lines: JournalLine[], today: string = dayKey()): Set<string> {
  const todays = lines
    .filter(l => l.day === today && (l.type === 'review' || l.type === 'session'))
    .sort(byTime)
  let block = 0
  const introBlock = new Map<string, number>()      // slug → индекс сессии знакомства
  const laterPractice = new Map<string, Set<number>>() // slug → индексы сессий с отработкой после знакомства
  for (const l of todays) {
    if (l.type === 'session') { block++; continue }
    if ((l.skill ?? 'recall') !== 'recall' || !l.slug) continue
    // вид карточки пишется в строку, только если он не vocab (см. rateItem в store.ts)
    if ((l.kind ?? 'vocab') !== 'vocab') continue
    const isIntro = l.format === 'intro' || l.prev_state === State.New
    if (isIntro && !introBlock.has(l.slug)) introBlock.set(l.slug, block)
    const intro = introBlock.get(l.slug)
    if (intro !== undefined && block > intro && l.format !== 'intro') {
      const s = laterPractice.get(l.slug) ?? new Set<number>()
      s.add(block)
      laterPractice.set(l.slug, s)
    }
  }
  const out = new Set<string>()
  for (const slug of introBlock.keys()) {
    if ((laterPractice.get(slug)?.size ?? 0) < 2) out.add(slug)
  }
  return out
}

/* ---- чтение: отметки незнакомых слов и прочтения текстов ------------------ */

/**
 * Доля незнакомых слов, выше которой текст был не по силам.
 *
 * Порог отметок — не украшение строки журнала: он отвечает на единственный вопрос, ради
 * которого чтение вообще меряют, — «этот текст читали или продирались сквозь него». Два
 * процента (98% знакомых слов) — общепринятая граница самостоятельного чтения; на тексте
 * контракта в 840 слов это 16 отметок. Выше — текст стоит понизить ступенью, а не хвалить
 * ученика за упорство.
 */
export const READING_UNKNOWN_SHARE_MAX = 0.02

/* Потолок предложения в строке отметки. Предложение хранится ЦЕЛИКОМ ради тьютора: слово без
   контекста разбирать нечем, а сходить за контекстом в текст он потом не сможет — текст мог
   смениться. Потолок нужен только против аномалии (абзац без единой точки), не против длины
   нормального предложения: в текстах контракта средняя длина держится ориентиром ступени. */
export const MARK_SENTENCE_MAX = 400

/** Источник отметки для текста: `reading:<слаг>`. */
export const readingSrc = (slug: string) => `reading:${slug}`

/* Источник отметки для упражнения: `card:<слаг карточки>`.

   Разведён с `reading:` не ради красоты: у слова, отмеченного в тексте, и слова, отмеченного
   в условии карточки, разная цена для тьютора. Первое — незнакомое слово в связном чтении,
   второе — незнакомое слово в задании, которое ученик всё равно обязан решить. Общий источник
   смешал бы их в одном счёте, а порог понятности текста (`readingPassed`) считает отметки
   ИМЕННО этого текста и от чужих отметок обязан быть избавлен. */
export const cardSrc = (slug: string) => `card:${slug}`

/** Нормализация формы слова для сравнения: регистр и обрамляющая пунктуация значения не имеют. */
export function normWord(w: string): string {
  return w.trim().toLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')
}

/** Есть ли слово в колоде — по любой из известных форм (леммы и той, что стояла в тексте). */
export function deckHasWord(deck: ReadonlySet<string>, ...forms: (string | undefined)[]): boolean {
  return forms.some(f => {
    const n = f ? normWord(f) : ''
    return !!n && deck.has(n)
  })
}

/**
 * Ключ отметки: источник + лемма (при её отсутствии — форма из текста).
 *
 * Единица отметки — слово В ТЕКСТЕ, а не его конкретное вхождение. Одна лемма, встреченная
 * трижды, — одно незнакомое слово, а не три: иначе счёт отметок зависел бы от того, сколько
 * раз автор повторил слово, и порог понятности потерял бы смысл. Отсюда же следует, что
 * снятие отметки снимает её у всех вхождений — ученик снимает не подсветку, а признание
 * «не знаю это слово».
 */
export function markKey(l: JournalLine): string {
  const w = normWord(String(l.lemma || l.word || ''))
  return w ? `${l.src ?? ''}\u0000${w}` : ''
}

/**
 * Кто из двух строк одной отметки описывает более позднее решение.
 *
 * Хронология — `byTime` (ts с точностью до секунды + миллисекунды внутри неё). Полное
 * равенство разрешается сравнением `id`: два устройства могут поставить и снять отметку в
 * одну миллисекунду, и тогда порядок в массиве у них разный (журнал приходит объединением по
 * id), а ответ обязан быть одинаковым — иначе одно устройство показывает слово отмеченным,
 * второе нет, и расхождение не лечится синхронизацией. `id` — единственный тотальный порядок,
 * который у обоих устройств совпадает.
 */
function markLater(a: JournalLine, b: JournalLine): boolean {
  const t = byTime(a, b)
  return t !== 0 ? t > 0 : a.id > b.id
}

/**
 * Текущее состояние отметок текста, восстановленное из потока строк.
 *
 * Журнал append-only: снятие отметки — это не удаление строки, а новая строка `on: false`
 * (удалять из журнала нечего, он сливается объединением по id, и удалённая на одном
 * устройстве строка вернулась бы с другого). Значит текущее состояние — последнее решение
 * по каждому ключу, а не сумма событий: три постановки и одно снятие после них дают «снято»
 * независимо от их числа. Строка без `on` читается как поставленная отметка (D3: старые и
 * чужие строки не должны становиться невидимыми из-за поля, которого в них не было).
 *
 * `src` опущен — берутся отметки ВСЕХ источников сразу (нужно отчёту: он собирает
 * кандидатов в карточки по всей работе, а не по одному тексту). Ключ отметки уже
 * включает источник (`markKey`), поэтому одно и то же слово, отмеченное в двух
 * текстах, остаётся двумя отметками и не схлопывается в одну.
 */
export function activeMarks(lines: JournalLine[], src?: string): JournalLine[] {
  const last = new Map<string, JournalLine>()
  for (const l of lines) {
    if (l.type !== 'mark' || (src !== undefined && l.src !== src)) continue
    const key = markKey(l)
    if (!key) continue
    const prev = last.get(key)
    if (!prev || markLater(l, prev)) last.set(key, l)
  }
  return [...last.values()].filter(l => l.on !== false).sort(byTime)
}

/** Отмечено ли сейчас это слово в этом тексте. */
export function isMarked(lines: JournalLine[], src: string, word: string, lemma?: string): boolean {
  const key = markKey({ src, word, lemma } as JournalLine)
  return !!key && activeMarks(lines, src).some(l => markKey(l) === key)
}

/** Сколько слов текста отмечено сейчас. */
export function markCount(lines: JournalLine[], src: string): number {
  return activeMarks(lines, src).length
}

/** Взят ли порог понятности: отметок не больше READING_UNKNOWN_SHARE_MAX от объёма текста. */
export function readingPassed(marks: number, words: number): boolean {
  return words > 0 && marks <= words * READING_UNKNOWN_SHARE_MAX
}

/** Слаги текстов, прочтение которых уже записано (строка type: reading). */
export function readTextSlugs(lines: JournalLine[]): Set<string> {
  const s = new Set<string>()
  for (const l of lines) if (l.type === 'reading' && l.slug) s.add(l.slug)
  return s
}

/** Одно отмеченное слово, сведённое по всем источникам. */
export interface MarkDigestEntry {
  lemma: string          // словарная форма — под ней слово и пойдёт в карточку
  marks: number          // в скольких источниках отмечено сейчас
  fromReading: number    // из них текстов
  fromCards: number      // из них заданий
  inDeck: boolean        // есть ли слово в колоде СЕЙЧАС
  sample: string         // предложение из первой отметки — готовый контекст для карточки
}

/** Сводка отметок: сколько их и какие слова просятся в колоду. */
export interface MarkDigest {
  total: number
  fromReading: number
  fromCards: number
  entries: MarkDigestEntry[]
}

/**
 * Что владелец отметил как незнакомое — сведённое по всем источникам.
 *
 * Отметки копятся в журнале с 22.08.2026, но не показывались нигде: ни на экране, ни
 * в отчёте тьютору. Смысл отметки в том, чтобы слово попало в колоду, а невидимая
 * отметка не попадёт туда никогда — она просто лежит строкой в ndjson.
 *
 * Принадлежность к колоде считается ПО ТЕКУЩЕЙ колоде, а не по полю `in_deck` строки:
 * там записана историческая правда на момент отметки, и слово, добавленное после,
 * так и осталось бы «кандидатом» навсегда.
 *
 * Слово, отмеченное при живой карточке, — не кандидат, а сигнал: карточка есть, а
 * слово не узнаётся. Такое лечится переформулировкой, поэтому эти два случая
 * разведены, а не сложены в один список.
 */
export function markDigest(lines: JournalLine[], deck: ReadonlySet<string>): MarkDigest {
  const byLemma = new Map<string, MarkDigestEntry>()
  let fromReading = 0
  let fromCards = 0
  for (const l of activeMarks(lines)) {
    const lemma = normWord(String(l.lemma || l.word || ''))
    if (!lemma) continue
    const isReading = (l.src ?? '').startsWith('reading:')
    const isCard = (l.src ?? '').startsWith('card:')
    if (isReading) fromReading++
    if (isCard) fromCards++
    const prev = byLemma.get(lemma)
    if (prev) {
      prev.marks++
      if (isReading) prev.fromReading++
      if (isCard) prev.fromCards++
      if (!prev.sample && l.sentence) prev.sample = l.sentence
    } else {
      byLemma.set(lemma, {
        lemma,
        marks: 1,
        fromReading: isReading ? 1 : 0,
        fromCards: isCard ? 1 : 0,
        inDeck: deckHasWord(deck, l.lemma, l.word),
        sample: l.sentence ?? '',
      })
    }
  }
  /* Сначала то, чего в колоде нет, — это рабочий список на добавление; внутри — по
     числу отметок: слово, споткнувшее владельца дважды, важнее споткнувшего однажды. */
  const entries = [...byLemma.values()].sort((a, b) =>
    Number(a.inDeck) - Number(b.inDeck) || b.marks - a.marks || a.lemma.localeCompare(b.lemma))
  return { total: entries.reduce((n, e) => n + e.marks, 0), fromReading, fromCards, entries }
}

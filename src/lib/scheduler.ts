import { fsrs, generatorParameters, Rating, State, type Grade, type Card as FsrsCard, type FSRS } from 'ts-fsrs'
import type { CardView, Format, StudyItem } from './types'
import { endOfStudyDay, dayKey, addDaysKey } from './daytime'
import { TYPO_MIN_LEN, TYPO_MAX_EDITS } from './journal'

export function makeScheduler(requestRetention: number): FSRS {
  // fuzz разводит одновременно выученные карточки по разным дням — меньше комков и MC-соседей
  return fsrs(generatorParameters({ request_retention: requestRetention, enable_fuzz: true }))
}

/* Дат две, и путать их дорого.

   PRIMARY — 03.10, первая настоящая попытка и якорь всех планов вальта.
   EXAM — 07.11, суперскор-попытка: второй заход, если первый не добрал.

   Раньше константа была одна, EXAM = 07.11, и по ней считалось всё. Отсюда
   три следствия, каждое проверено на живых данных:

     — главный экран показывал 96 дней до экзамена вместо 61;
     — DUE_CAP стоял на 31.10, то есть ПОЗЖЕ первой попытки: карточка легально
       получала срок повтора за 03.10 и до реального экзамена не возвращалась
       ни разу;
     — окно повышенного retention приходилось на 24.10–07.11 — целиком после
       той даты, к которой готовятся.

   Задание очереди от 27.07 это предписывало прямо: «EXAM_DATE не трогать,
   добавить PRIMARY_DATE = 03.10, для основной плашки использовать PRIMARY».
   Метрику на PRIMARY перевели, планировщик остался на EXAM — развилка так и
   стояла полураскрытой.

   Планировщик работает по PRIMARY: готовым надо быть к первой попытке, а не к
   запасной. EXAM остаётся горизонтом суперскора. */
export const PRIMARY_DATE = new Date(2026, 9, 3)   // 03.10.2026, первая попытка
export const EXAM_DATE = new Date(2026, 10, 7)     // 07.11.2026, суперскор

/* Потолок интервалов — за неделю до первой попытки, а не после неё. Неделя
   запаса нужна, чтобы последний повтор пришёлся не на канун экзамена. */
export const DUE_CAP = new Date(2026, 8, 26)       // 26.09.2026

/* Стоп ввода новых слов. Слову нужно порядка 21 дня стабильности, чтобы дозреть к
   PRIMARY (03.10) — введённое позже этой границы просто не успевает: колода дальше
   не растёт, только дозревает то, что уже введено.

   Решения этого класса раньше не существовало в коде вовсе — оно держалось на
   памяти владельца: «не забыть зайти в настройки и обнулить newPerDay». Запрещённый
   класс — правило, которое человек обязан помнить, а не код. Здесь константа.

   Граница включает саму дату: с 00:00 19.09.2026 бюджет новых уже нулевой, последний
   день ввода — 18.09.2026. */
export const NEW_STOP_DATE = new Date(2026, 8, 19)  // 19.09.2026, с этого дня бюджет новых — 0

/** true, пока новые слова ещё разрешено вводить (см. NEW_STOP_DATE). */
function newIntroAllowed(now: Date): boolean {
  return now.getTime() < NEW_STOP_DATE.getTime()
}

/** Последние 2 недели перед КАЖДОЙ из дат — retention поднимается до 0.95 */
export function effectiveRetention(base: number, now: Date = new Date()): number {
  const близко = (d: Date) => {
    const days = (d.getTime() - now.getTime()) / 86400_000
    return days >= 0 && days <= 14
  }
  return близко(PRIMARY_DATE) || близко(EXAM_DATE) ? Math.max(base, 0.95) : base
}

export const GRADES: { rating: Grade; key: string; label: string }[] = [
  { rating: Rating.Again, key: '1', label: 'Заново' },
  { rating: Rating.Hard, key: '2', label: 'Трудно' },
  { rating: Rating.Good, key: '3', label: 'Хорошо' },
  { rating: Rating.Easy, key: '4', label: 'Легко' }
]

/** Человекочитаемый прогноз интервала для кнопки оценки */
export function intervalLabel(f: FSRS, card: FsrsCard, rating: Grade, now: Date): string {
  const next = f.repeat(card, now)[rating].card
  const ms = next.due.getTime() - now.getTime()
  const min = Math.round(ms / 60000)
  if (min < 60) return `${Math.max(1, min)} мин`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} ч`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} дн`
  const mo = d / 30.44
  if (mo < 12) return `${mo.toFixed(mo < 3 ? 1 : 0)} мес`
  return `${(d / 365.25).toFixed(1)} г`
}

const isLearning = (s: State) => s === State.Learning || s === State.Relearning

/** Раздел: слова/RW отдельно от математики — межпредметного перемешивания нет,
    interleaving работает внутри раздела (домены математики перемешаны между собой) */
export type Section = 'rw' | 'grammar' | 'math'
const MATH_DOMAINS = new Set(['ALG', 'AM', 'PSDA', 'GEO'])
export function sectionOf(v: CardView): Section {
  if (v.kind === 'math' || MATH_DOMAINS.has(v.domain)) return 'math'
  // грамматика: пунктуация/правила SEC + связки/логика EOI — отдельно от словаря
  if (v.kind === 'grammar' || v.domain === 'SEC' || v.domain === 'EOI' || v.pos === 'transition') return 'grammar'
  return 'rw'
}

/**
 * Приоритет типа при выборе новых: error/grammar (доказанные пробелы) → слово из
 * разбора пробника → math → рутинный словарь.
 *
 * Слово из разбора пробника (`source` начинается на «pt»: `pt4`, `pt4-m2q27`,
 * `pt1-q14`…, см. _КОНТРАКТ.md) — это провал на настоящем экзамене, тот же класс
 * доказанного пробела, что и error/grammar, просто размеченный обычным vocab с
 * произвольным `level`. Без этой ветки такое слово не вводится НИКОГДА: `freshItems`
 * идёт уровнями по возрастанию, третьих ступеней и ниже — сотни, а до NEW_STOP_DATE
 * влезает около 264 слова. Живой пример — `paucity`/`surmise`/`buttress`, все source:
 * pt4, level 6: стояли за очередью, которая до них не доедет никогда.
 *
 * level НЕ трогаем — он остаётся честной оценкой трудности для «Пути» и статистики
 * по ступеням, здесь только порядок ВВОДА.
 */
export function kindRank(v: CardView): number {
  const r: Record<string, number> = { error: 0, grammar: 1, math: 3 }
  if (v.kind in r) return r[v.kind]
  return v.source.startsWith('pt') ? 2 : 4
}

/** Карточка, которой управляет система уровней: словарь без связок. Только у неё осмыслен level. */
export function isLevelled(v: CardView): boolean {
  return v.kind === 'vocab' && v.pos !== 'transition'
}

/**
 * Текущий активный уровень: минимальный уровень со ещё не введёнными (New) словами.
 * Все ранние уровни введены → берём максимальный существующий (новые слова падают к последнему).
 * Уровней нет вовсе → 1. Используется для штампа level в самодобавленные карточки и для UI.
 */
export function activeLevel(cards: CardView[]): number {
  const levelled = cards.filter(c => !c.suspended && isLevelled(c) && c.level < 999)
  if (!levelled.length) return 1
  const fresh = levelled.filter(c => c.fsrs.state === State.New)
  if (fresh.length) return Math.min(...fresh.map(c => c.level))
  return Math.max(...levelled.map(c => c.level))
}

export interface LevelStat { level: number; total: number; introduced: number; review: number }

/** Прогресс по уровням для экрана «Путь»: сколько слов покинуло New (introduced) и ушло в Review (mastery). */
export function levelStats(cards: CardView[]): LevelStat[] {
  const m = new Map<number, LevelStat>()
  for (const c of cards) {
    if (c.suspended || !isLevelled(c) || c.level >= 999) continue
    const e = m.get(c.level) ?? { level: c.level, total: 0, introduced: 0, review: 0 }
    e.total++
    if (c.fsrs.state !== State.New) e.introduced++
    if (c.fsrs.state === State.Review) e.review++
    m.set(c.level, e)
  }
  return [...m.values()].sort((a, b) => a.level - b.level)
}

/** Learning-карточки показываем чуть раньше срока (Anki learn-ahead), чтобы шаг не терялся на конце сессии/дня */
export const LEARN_AHEAD_MS = 30 * 60000

/**
 * Минимальный разрыв между двумя показами ОДНОЙ карточки (point 2).
 * Три верных ответа за минуту проверяют кратковременный буфер, а не память; между
 * извлечениями должно пройти хотя бы столько, чтобы след успел «остыть». Побочный
 * эффект, который и нужен: очередь начинает чередовать слова, а не долбить одно.
 */
export const MIN_SHOW_GAP_MS = 60_000

/**
 * Аварийный пол разрыва. Основной разрыв — 60 c, и он соблюдается, пока уроку есть что
 * показать вместо этой карточки (добор: сегодняшние недоработанные → ранний повтор →
 * ещё одно новое в пределах ДНЕВНОГО лимита). Если альтернатив нет вообще, карточка
 * показывается по этому полу — но ученик не сидит без дела: экрана-ожидания нет.
 * Сначала здесь была честная пауза с отсчётом — это оказалось хуже всего остального:
 * 25 секунд простоя в учебном приложении, которые вдобавок обходились выходом и
 * повторным входом в урок (счётчики показов живут внутри сессии).
 */
export const MIN_SHOW_GAP_FLOOR_MS = 30_000

/**
 * Разрыв между ЗНАКОМСТВОМ и первой отработкой того же слова. Знакомство — не извлечение
 * из памяти, а показ: смысл A2 («три верных ответа внутри минуты не проверяют память»)
 * относится к паре оценка→оценка, а не к паре показ→первая оценка. Требование A3 (между ними
 * обязательно другая карточка) остаётся, поэтому первая отработка приходит через два-три
 * чужих экрана — как первый learning-шаг в Anki. Без этого различия урок на тонком пуле
 * упирался в тупик: слово введено, а показать его снова нельзя ещё минуту, и показывать
 * больше нечего.
 */
export const INTRO_GAP_MS = 20_000

/**
 * Минимум отработок между знакомствами с новыми словами.
 * Новые подряд грузят рабочую память и мешают друг другу (interference):
 * слово должно быть хотя бы раз извлечено, прежде чем в голову зайдёт следующее.
 */
export const NEW_GAP = 2

/**
 * Потолок повторов за один урок.
 *
 * Ограничения не было: очередь брала все просроченные карточки разом. При
 * четырёхстах словах это порядка 160 повторов в день, а после недели пропуска
 * больше тысячи — примерно два часа одним заходом. Такой урок не начинают, и
 * долг растёт дальше; колода умирает не от сложности, а от размера очереди.
 *
 * Шестьдесят — это около 12–15 минут, то есть ровно защищённый минимум.
 * Остаток не пропадает: он придёт следующим уроком, самое просроченное первым.
 */
export const MAX_REVIEW_PER_LESSON = 60

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * Развёртка колоды в учебные единицы (карточка × навык).
 * prep-навык подключается, когда слово уже знакомо (recall в Review) —
 * или сразу, если prep-график уже начат (не бросаем начатое).
 */
export function expandItems(cards: CardView[]): StudyItem[] {
  const items: StudyItem[] = []
  for (const c of cards) {
    if (c.suspended) continue
    items.push({ view: c, skill: 'recall', fsrs: c.fsrs })
    if (c.prep && c.fsrsPrep) {
      const started = c.fsrsPrep.state !== State.New
      if (started || c.fsrs.state === State.Review) {
        items.push({ view: c, skill: 'prep', fsrs: c.fsrsPrep })
      }
    }
  }
  return items
}

export const itemKey = (i: StudyItem) => `${i.view.path}#${i.skill}`

/**
 * Новые единицы в порядке ввода: сначала error/grammar (доказанные пробелы), потом math,
 * потом словарь уровнями (Duolingo-путь): level ASC, внутри уровня added ASC.
 * Вынесено из buildQueue, потому что тем же порядком урок добирает лишнее новое слово,
 * когда иначе ему нечего показать (см. Review.tsx::proceed).
 */
export function freshItems(items: StudyItem[]): StudyItem[] {
  return items
    .filter(i => i.fsrs.state === State.New)
    .sort((a, b) => {
      const ka = kindRank(a.view)
      const kb = kindRank(b.view)
      if (ka !== kb) return ka - kb
      if (isLevelled(a.view) && isLevelled(b.view)) {
        if (a.view.level !== b.view.level) return a.view.level - b.view.level
        const ad = a.view.added.localeCompare(b.view.added)
        if (ad !== 0) return ad
        return a.view.slug.localeCompare(b.view.slug)
      }
      const ad = b.view.added.localeCompare(a.view.added)
      if (ad !== 0) return ad
      return a.view.slug.localeCompare(b.view.slug)
    })
}

/**
 * Следующие новые слова за пределами урочного лимита — последняя ступень добора (B4).
 * После NEW_STOP_DATE добора нет: этот путь (bonusNew в Review.tsx) — второй вход
 * нового слова в урок, помимо основного бюджета buildQueue, и обязан закрываться тем же
 * правилом, иначе «стоп ввода» держится наполовину.
 */
export function nextNewItems(cards: CardView[], exclude: Set<string>, limit = 1, now: Date = new Date()): StudyItem[] {
  if (!newIntroAllowed(now)) return []
  return freshItems(expandItems(cards))
    .filter(i => i.skill === 'recall' && !exclude.has(itemKey(i)))
    .slice(0, Math.max(0, limit))
}

/**
 * Очередь сессии: Learning/Relearning → Review (due сегодня) → New (лимит).
 * Review и New перемешаны interleaving-ом, learning — впереди по due.
 */
export function buildQueue(cards: CardView[], newBudget: number, now: Date = new Date(), forced?: Set<string>): StudyItem[] {
  const eod = endOfStudyDay(now)
  const items = expandItems(cards)

  const learning = items
    .filter(i => isLearning(i.fsrs.state) && i.fsrs.due.getTime() <= now.getTime() + LEARN_AHEAD_MS)
    .sort((a, b) => a.fsrs.due.getTime() - b.fsrs.due.getTime())

  /* Потолок повторов за урок. Его не было вовсе: очередь брала ВСЁ, что
     просрочено, без ограничения.

     Пока живых карточек 38, это не видно. На четырёхстах словах и нынешней
     медиане стабильности выходит порядка 160 повторов в день, а пропуск
     недели даёт больше тысячи — часа два одним куском. Такой урок не
     начинают, долг растёт дальше, и колода умирает не от сложности, а от
     размера очереди.

     Самое просроченное идёт первым: чем дольше карточка ждёт, тем ближе она к
     полному забыванию. Остаток вернётся следующим уроком — в отличие от
     двухчасовой стены, которую просто закрывают. */
  const overdue = items
    .filter(i => i.fsrs.state === State.Review && i.fsrs.due.getTime() < eod.getTime())
    .sort((a, b) => a.fsrs.due.getTime() - b.fsrs.due.getTime())
  const review = shuffle(overdue.slice(0, MAX_REVIEW_PER_LESSON))

  // выбор новых: сначала error/grammar (закрывают доказанные пробелы), потом pt-разбор, потом
  // math, потом словарь; словарь идёт уровнями (Duolingo-путь): level ASC, внутри уровня —
  // свежедобавленные последними (added ASC, стабильный порядок). error/grammar/math/transition —
  // порядок прежний: added DESC.
  // NEW_STOP_DATE: после стопа бюджет нулевой независимо от того, что передал вызывающий —
  // правило живёт здесь, а не в каждом месте, которое считает newBudget снаружи.
  const fresh = freshItems(items)
  const effectiveBudget = newIntroAllowed(now) ? newBudget : 0
  const newItems = shuffle(fresh.slice(0, Math.max(0, effectiveBudget)))

  // interleaving с разрядкой: новые распределяем среди review, но не ближе чем через
  // NEW_GAP других карточек; позицию 0 не занимаем — сессия начинается с повтора, если он есть.
  // Если повторов мало и слова всё равно встают рядом, очередь дополнительно разряжается
  // на лету (отработка только что введённого слова служит разделителем).
  const mixed: StudyItem[] = [...review]
  if (newItems.length) {
    const stride = Math.max(NEW_GAP + 1, Math.round((review.length + newItems.length) / newItems.length))
    newItems.forEach((it, i) => {
      const pos = Math.min(mixed.length, (review.length ? 1 : 0) + i * stride)
      mixed.splice(pos, 0, it)
    })
  }

  // point 3: обязательный добор. Слова, введённые сегодня и ещё не отработанные в двух
  // последующих сессиях (список forced считает вызывающий по журналу), принудительно
  // попадают в урок — даже если их due перенесён на завтра (см. point 1, держим в Learning).
  // Берём только recall-единицы в Learning/Relearning: New уже в пуле новых, Review-слова
  // (напр. «уже знаю это слово») отработки не требуют. Добор — в хвост, перемешанный.
  const already = new Set([...learning, ...review, ...newItems].map(itemKey))
  const drills = forced?.size
    ? shuffle(items.filter(i =>
        i.skill === 'recall' && forced.has(i.view.slug) && isLearning(i.fsrs.state) && !already.has(itemKey(i))))
    : []
  return [...learning, ...mixed, ...drills]
}

/**
 * Заполнитель (B4, третья ступень лестницы добора): повтор, срок которого ещё не пришёл,
 * но придёт в ближайшие трое суток. Нужен, когда урок обязан развести знакомство и первую отработку
 * слова (A3), а разбавлять нечем: после большой сессии всё введённое уезжает на следующий день
 * (A1), пул созревших пустеет, и урок вырождался в одно знакомство. Ранний повтор — правка
 * состава очереди, не формул: FSRS штатно обрабатывает досрочный показ (E1 не нарушается).
 * Ступень включается ТОЛЬКО когда без неё урок встанет, и ограничена MAX_EARLY_FILLERS,
 * чтобы не вычерпывать завтрашний день.
 */
export const FILLER_LOOKAHEAD_MS = 72 * 3600_000
export const MAX_EARLY_FILLERS = 12

/**
 * Насколько урок может превысить свой лимит новых слов, когда иначе ему нечего показать.
 * Урочный лимит — про комфортный темп, и он уступает пустому экрану, но не безгранично:
 * без потолка урок на тонком пуле вводил всю дневную норму за один присест.
 * Дневной лимит (`newPerDay`) не превышается никогда.
 */
export const MAX_INTRO_BONUS = 2

export function earlyFillers(cards: CardView[], now: Date, exclude: Set<string>, limit = MAX_EARLY_FILLERS): StudyItem[] {
  const eod = endOfStudyDay(now)
  const horizon = now.getTime() + FILLER_LOOKAHEAD_MS
  const сегодня = dayKey(now)
  return expandItems(cards)
    .filter(i => {
      if (i.fsrs.state === State.New) return false
      /* Спрошенное сегодня в заполнители не берём. Память «что уже показано» жила
         внутри урока (`drilled` в экране), а лестница добора смотрит на трое суток
         вперёд — и второй урок того же вечера начинался с той же карточки: ответив
         на неё, ученик сам сделал её ближайшей по сроку, а заполнители сортируются
         именно по сроку. Замер 20.08.2026: 51 показ на 27 карточек за день.
         Обязательная отработка введённого сегодня слова (`forcedTodaySlugs`) от
         этого не страдает — она идёт своей дорогой, через buildQueue. */
      if (i.fsrs.last_review && dayKey(i.fsrs.last_review) === сегодня) return false
      const t = i.fsrs.due.getTime()
      // уже созревшее в заполнители не берём — оно и так попадает в очередь обычным путём
      const readyNow = isLearning(i.fsrs.state) ? t <= now.getTime() + LEARN_AHEAD_MS : t < eod.getTime()
      return !readyNow && t <= horizon && !exclude.has(itemKey(i))
    })
    .sort((a, b) => a.fsrs.due.getTime() - b.fsrs.due.getTime())
    .slice(0, Math.max(0, limit))
}

/**
 * Возврат карточки в очередь после оценки: позиция пропорциональна времени до
 * due (~20 c на карточку), иначе 10-минутный learning-шаг схлопнулся бы в
 * полминуты и слово «выучивалось» бы из рабочей памяти, минуя интервал.
 *
 * Так и происходило. Прежняя версия зажимала позицию в `Math.min(queueLen, …)`
 * — то есть при короткой очереди ставила карточку в конец и возвращала её
 * через минуту вместо десяти. А очередь короткая почти всегда: новых за урок
 * было три, повторов у молодой колоды мало.
 *
 * Что это сделало с моделью, по живым данным за две недели: 472 отработки на
 * 49 уникальных слов, 3.21 показа слова за день, две трети промежутков между
 * показами одного слова — меньше получаса. Медиана difficulty 9.08 из 10,
 * медиана стабильности 1.25 дня, зрелых карточек НОЛЬ, ни одно слово не вышло
 * за интервал в десять дней. Модель считала, что слово забывается за часы, —
 * потому что её и спрашивали каждые несколько минут.
 *
 * Теперь честно: не помещается — не возвращаем. Карточка уходит из урока со
 * своим настоящим сроком и приходит следующим заходом. Пустой урок лучше
 * испорченной модели.
 */
export function requeuePosition(queueLen: number, next: FsrsCard, now: Date): number | null {
  const waitMs = next.due.getTime() - now.getTime()
  const нужно = Math.max(3, Math.ceil(waitMs / 20000))
  return нужно <= queueLen ? нужно : null
}

export function shouldRequeue(next: FsrsCard, now: Date): boolean {
  return isLearning(next.state) && next.due.getTime() - now.getTime() < 30 * 60000
}

/**
 * Формат упражнения:
 * - prep-навык → всегда prep (выбор предлога);
 * - recall в New → intro (знакомство: слово+значения+пример, без викторины);
 * - recall в Learning/Relearning → reveal (retrieval уже возможен — слово показывали);
 * - recall в Review → чередование по reps: MC (формат Words in Context цифрового SAT,
 *   дистракторы из колоды) и ввод с клавиатуры (production + написание).
 */
/**
 * Формат показа.
 *
 * C8 (17.08.2026). До этой даты словарь в Review проверялся ОДНИМ способом —
 * выбором слова из четырёх в пропуске предложения. Правка 05.08 сделала MC
 * основным форматом (обоснованно: `type` занимал 271 показ из 472, а SAT
 * проверяет словарь рецептивно), но `mcReady()` истинно почти всегда, поэтому
 * «основной» на практике означало «единственный», а ввод остался за выключенным
 * по умолчанию тумблером.
 *
 * Что из этого вышло, словами самого Александра 17.08.2026: «где выбор из 4 слов
 * я просто выбираю знакомое, а в предложениях вижу знакомое предложение и помню,
 * какое слово там было». Обе лазейки — прямое следствие конструкции, а не лени:
 * у слова три фиксированных контекста, значит на десяти повторах каждое
 * предложение возвращается трижды, а выбор из четырёх слов вознаграждает
 * узнавание формы, а не знание значения.
 *
 * Поэтому Review идёт по ротации `REVIEW_CYCLE`: два режима из четырёх не
 * показывают предложение вовсе (заучивать нечего), один спрашивает обратное
 * направление русскими значениями (знакомость английского слова не помогает), и
 * один требует произвести слово по памяти (угадывать не из чего).
 *
 * Прежний запрет ввода снят сознательно: он держался на двух основаниях, и оба
 * отпали — рука Александра зажила (подтверждено 17.08.2026), а в ротации `type`
 * даёт четверть показов вместо прежних 57%. Тумблер `typing` остаётся, но теперь
 * включён по умолчанию и означает «участвует ли ввод в ротации».
 */
export function pickFormat(item: StudyItem, deck: CardView[], introduced?: Set<string>, lapsed?: Set<string>, reintroAllowed = true, typing = false): Format {
  return pickTask(item, deck, introduced, lapsed, reintroAllowed, typing).format
}

/** По чему вспоминаем: пропуск в предложении, значение (ответ — слово) или слово (ответ — значение). */
export type Cue = 'sentence' | 'meaning' | 'word'

/**
 * Ротация режимов проверки в Review, по числу оценок карточки.
 *
 * Порядок не случаен: первым идёт формат реального экзамена, чтобы он оставался
 * тренируемым, дальше — режимы, закрывающие лазейки. Шаг, недоступный карточке
 * (нет значения, мало дистракторов, ввод выключен), деградирует к ближайшему
 * возможному, а не пропускается: пропуск сдвинул бы фазу и вернул предложение в
 * каждый показ.
 */
/* С какого повтора карточка попадает в ротацию. Два — это «слово уже дважды
   опознано»: тот же порог, что у C1 для производства (см. baseFormat). */
export const ROTATE_FROM_REPS = 2

export const REVIEW_CYCLE: ReadonlyArray<{ format: Format; cue: Cue }> = [
  { format: 'mc', cue: 'sentence' },  // Words in Context — целевой формат SAT
  { format: 'mc', cue: 'meaning' },   // значение → слово, предложения нет
  { format: 'mc', cue: 'word' },      // слово → значение, варианты по-русски
  { format: 'type', cue: 'meaning' }, // значение → вписать слово (производство)
]

/**
 * Дистракторы-значения для обратного режима (`cue: 'word'`).
 *
 * Здесь узнавание по новизне не работает в принципе — все варианты русские, — но
 * работает семантическая далёкость: если значения из разных смысловых зон, ответ
 * виден без знания слова. Поэтому лестница ведёт от самых похожих (та же часть
 * речи и та же ступень) к любым словам раздела.
 */
export function meaningDistractors(card: CardView, deck: CardView[], n = 3): string[] {
  const answer = (card.meaning_ru || '').trim()
  const taken = new Set([answer.toLowerCase()])
  const sec = sectionOf(card)
  const pool = deck.filter(c =>
    !c.suspended && c.path !== card.path && sectionOf(c) === sec && !!(c.meaning_ru || '').trim())
  const samePos = (c: CardView) => c.pos === card.pos
  // 999 — «без уровня» (связки, SEC): такие между собой не роднее, чем любые другие
  const sameLevel = (c: CardView) => card.level !== 999 && c.level === card.level
  const ladder: CardView[][] = [
    pool.filter(c => samePos(c) && sameLevel(c)),
    pool.filter(samePos),
    pool
  ]
  const out: string[] = []
  for (const step of ladder) {
    if (out.length >= n) break
    for (const c of shuffle(step)) {
      if (out.length >= n) break
      const m = (c.meaning_ru || '').trim()
      if (taken.has(m.toLowerCase())) continue
      out.push(m)
      taken.add(m.toLowerCase())
    }
  }
  return out.slice(0, n)
}

/** Формат и цель показа вместе: Review.tsx рисует по паре, тесты проверяют пару. */
export function pickTask(item: StudyItem, deck: CardView[], introduced?: Set<string>, lapsed?: Set<string>, reintroAllowed = true, typing = false): { format: Format; cue: Cue } {
  const format = baseFormat(item, deck, introduced, lapsed, reintroAllowed, typing)
  if (format !== 'mc' && format !== 'type') return { format, cue: 'sentence' }
  // авторские варианты (error/grammar) и числовой ответ (math) — своя механика, ротации нет
  if (item.view.choices.length >= 2 || item.view.answerNum) return { format, cue: 'sentence' }
  /* Ротацию открывает второй повтор, а не переход в Review.
     Раньше здесь стояло только `state !== Review`, и на выросшей колоде это
     молча выключило производство. В learning `baseFormat` отдаёт mc, пока в
     колоде находятся три дистрактора, — а находятся они всегда, — так что
     ветка `type` внизу baseFormat достижима лишь на крошечной колоде.
     Замер журнала: в июле, пока колода была мала, 274 показа вводом; 20.08 —
     три, и все три у карточек в Review. Слово, застрявшее в learning, ученик
     десять раз узнавал среди четырёх вариантов и ни разу не вспоминал сам —
     ровно эти слова и оказались пиявками. Узнавание с подсказкой не готовит к
     экзамену, где подсказки нет. */
  if (item.fsrs.state !== State.Review && item.fsrs.reps < ROTATE_FROM_REPS) return { format, cue: 'sentence' }
  const step = REVIEW_CYCLE[((item.fsrs.reps % REVIEW_CYCLE.length) + REVIEW_CYCLE.length) % REVIEW_CYCLE.length]
  return degrade(step, item, deck, typing)
}

/**
 * Ближайший исполнимый режим, если выпавший шаг карточке недоступен.
 * Порядок отката: word → meaning → sentence; type → mc с тем же cue.
 */
function degrade(step: { format: Format; cue: Cue }, item: StudyItem, deck: CardView[], typing: boolean): { format: Format; cue: Cue } {
  const view = item.view
  const hasMeaning = !!(view.meaning_ru || '').trim()
  const canProduce = !view.word.includes(' ') && hasMeaningHint(view)
  let cue = step.cue
  if ((cue === 'meaning' || cue === 'word') && !hasMeaning) cue = 'sentence'
  if (cue === 'word' && meaningDistractors(view, deck).length < 3) cue = 'meaning'
  let format = step.format
  if (format === 'type' && !(typing && canProduce)) format = 'mc'
  // выбор слова требует трёх словесных дистракторов; без них остаётся показ
  if (format === 'mc' && cue !== 'word' && mcDistractors(view, deck).length < 3) {
    return typing && canProduce ? { format: 'type', cue: hasMeaning ? 'meaning' : 'sentence' } : { format: 'reveal', cue }
  }
  return { format, cue }
}

function baseFormat(item: StudyItem, deck: CardView[], introduced?: Set<string>, lapsed?: Set<string>, reintroAllowed = true, typing = false): Format {
  if (item.skill === 'prep') return 'prep'
  // авторские варианты (error/grammar/math) — всегда MC, включая первый показ
  if (item.view.choices.length >= 2) return 'mc'
  // числовой ответ (math) — всегда ввод, включая первый показ
  if (item.view.answerNum) return 'type'
  const typable = !item.view.word.includes(' ')
  // C5: ввод по буквам допустим только при однозначном ответе — слово из одного токена И есть
  // подсказка значения. Без значения задание по контексту неоднозначно (синонимы) — тогда reveal/mc.
  const canProduce = typable && hasMeaningHint(item.view)
  const mcReady = () => mcDistractors(item.view, deck).length >= 3
  if (item.fsrs.state === State.New) {
    // знакомство один раз за сессию; после него первая отработка — узнавание
    return introduced?.has(itemKey(item)) ? (mcReady() ? 'mc' : 'reveal') : 'intro'
  }
  // слово, которое не смогли вспомнить («Заново» в этой сессии — на ЛЮБОЙ стадии, не только Review;
  // либо пришедшее в Relearning из прошлой сессии) — один раз переznakomим окном-знакомством
  // (значение + пример), в UI подпись «Подзабылось» вместо «Новое слово». Но окно-переznakomство
  // тратит тот же урочный лимит, что и новые (для мозга «Подзабылось» — та же нагрузка знакомства):
  // сверх лимита провал отрабатывается обычным упражнением, без окна.
  const failed = lapsed?.has(itemKey(item)) || (item.fsrs.state === State.Relearning && !introduced?.has(itemKey(item)))
  if (failed && reintroAllowed) return 'intro'
  if (item.fsrs.state !== State.Review) {
    // C1: производство (type) — не раньше, чем слово дважды опознано (reveal/mc). reps считает
    // реальные оценки (intro рейтинга не даёт), поэтому reps>=2 = после двух опознаний. Написание
    // по буквам через минуту после первого показа — гарантированный провал (scrutinize/bolster/
    // corroborate 17.07 застряли на type со stability 0.01). Выпускной шаг — объективный формат:
    // самооценка склонна к «показалось знакомым». C5: type — только если ответ однозначен (canProduce).
    if (mcReady()) return 'mc'
    return typing && item.fsrs.reps >= 2 && canProduce ? 'type' : 'reveal'
  }
  if (mcReady()) return 'mc'
  // C5: без подсказки значения ввод неоднозначен — тогда reveal (показ), но не type
  return typing && canProduce ? 'type' : 'reveal'
}

/**
 * C5: задание на ввод (`type`) обязано иметь однозначный ответ. Для словарной карточки это
 * значит, что дана подсказка значения (`meaning_ru`/`meaning_en`) — иначе «a ___ toward positive
 * results» допускает bias/tendency/skew, и верный по смыслу ответ засчитается провалом. Числовой
 * ответ (math) однозначен сам по себе и проверяется раньше, до вызова этого предиката.
 */
export function hasMeaningHint(v: CardView): boolean {
  return !!(v.meaning_ru || v.meaning_en)
}

/** Слово уже показывали и оценивали: reps растёт только с оценкой (A7 — intro знакомством не считается) */
export function isSeenWord(v: CardView): boolean {
  return v.fsrs.reps > 0 || v.fsrs.state !== State.New
}

/**
 * Дистракторы для MC.
 *
 * C6: варианты берутся из слов, которые ученик уже видел. Иначе задание решается
 * узнаванием новизны, а не значением: 06.08.2026 Александр сформулировал это сам —
 * «при выборе слов я просто выбираю знакомое». Замер того же дня: оценку хоть раз
 * получили 49 слов из 450, то есть случайный дистрактор из колоды с вероятностью
 * ~89% ученику вообще не показывался, и правильный ответ отличим не читая
 * предложение. Точность mc 42/47 при этом не измеряла ничего.
 */
export function mcDistractors(card: CardView, deck: CardView[], n = 3): string[] {
  /* Раньше здесь стояло `if (authored.length >= n) return authored` — и это
     вырождало упражнение.
     Замер на живой колоде: confusables ровно по три у 415 карточек из 450.
     Значит четвёрка вариантов у почти каждого слова была зафиксирована
     НАВСЕГДА, менялся только порядок, а ветка выбора по части речи была
     достижима у 35 карточек. Хуже: из 1245 авторских дистракторов лишь 358
     (29%) сами есть в колоде — остальные не встречаются больше нигде, и через
     два показа задание вырождается в «выбери знакомое слово среди трёх
     незнакомых». Узнавание по новизне, а не по значению.

     Теперь пул пересобирается на каждом показе: один авторский дистрактор
     (самая острая ловушка тьютора — их и проверяет SAT) плюс живые слова той же
     части речи из того же раздела. Тьюторская разметка не выбрасывается, но
     перестаёт быть единственным источником. */
  const AUTHORED_KEEP = 1
  const sec = sectionOf(card)
  const taken = new Set([card.word.toLowerCase()])
  const pool = deck.filter(c =>
    !c.suspended && c.word.toLowerCase() !== card.word.toLowerCase() && sectionOf(c) === sec)
  const seenWords = new Set(pool.filter(isSeenWord).map(c => c.word.toLowerCase()))
  /* Авторский дистрактор тоже проверяется на знакомость: 71% confusables не
     встречаются в колоде больше нигде, и незнакомая ловушка выдаёт ответ ровно так же,
     как незнакомый случайный сосед. Знакомые авторские идут первыми, незнакомые
     остаются в хвосте — как запас, когда живых слов не хватает. */
  const authored = shuffle(card.confusables.filter(c => c && c.toLowerCase() !== card.word.toLowerCase()))
    .sort((a, b) => Number(seenWords.has(b.toLowerCase())) - Number(seenWords.has(a.toLowerCase())))
  const out: string[] = []
  for (const a of authored.slice(0, AUTHORED_KEEP)) {
    if (!seenWords.has(a.toLowerCase())) break // незнакомую ловушку берём только в добор, ниже
    out.push(a)
    taken.add(a.toLowerCase())
  }
  /* Лестница источников: знакомое той же части речи → любое знакомое раздела →
     незнакомое той же части речи → любое слово раздела. Незнакомые ступени —
     страховка для первых недель, пока видённых слов меньше четырёх на раздел;
     как только пул набирается, они недостижимы. */
  const samePos = (c: CardView) => c.pos === card.pos
  const ladder: CardView[][] = [
    pool.filter(c => isSeenWord(c) && samePos(c)),
    pool.filter(isSeenWord),
    pool.filter(samePos),
    pool
  ]
  for (const step of ladder) {
    if (out.length >= n) break
    for (const w of shuffle(step.map(c => c.word))) {
      if (out.length >= n) break
      if (taken.has(w.toLowerCase())) continue
      out.push(w)
      taken.add(w.toLowerCase())
    }
  }
  // колода мала или раздел почти пуст — добираем оставшимися авторскими
  for (const a of authored) {
    if (out.length >= n) break
    if (taken.has(a.toLowerCase())) continue
    out.push(a)
    taken.add(a.toLowerCase())
  }
  return out.slice(0, n)
}

/**
 * C7: следующий пример карточки. Ротация обязана переживать перезапуск приложения.
 *
 * Раньше индекс жил в Map внутри модуля экрана и обнулялся при каждом открытии PWA,
 * а карточка внутри урока показывается один раз в 140 случаях из 262 (журнал на
 * 06.08.2026) — то есть почти каждый показ приходился на contexts[0], и слово
 * заучивалось вместе с единственным предложением.
 *
 * `last` — сохранённый индекс прошлого показа (null, если приложение только открыли);
 * тогда счётчиком служит число оценок карточки: оно переживает не только перезапуск,
 * но и переустановку — reps приходит из frontmatter карточки в репозитории.
 */
export function nextCtxIndex(last: number | null | undefined, reps: number, len: number): number {
  if (len <= 1) return 0
  const base = last == null ? reps - 1 : last
  return ((base + 1) % len + len) % len
}

const COMMON_PREPS = ['about', 'against', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'to', 'toward', 'with']

/** Варианты для prep-упражнения: правильный + 3 частотных предлога */
export function prepOptions(answer: string, n = 3): string[] {
  const distractors = shuffle(COMMON_PREPS.filter(p => p !== answer)).slice(0, n)
  return shuffle([answer, ...distractors])
}

/** Расстояние Левенштейна между строками (число правок). */
export function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  if (!m) return n
  if (!n) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

export type TypeVerdict = 'correct' | 'typo' | 'wrong'

export function checkTyped(typed: string, word: string): TypeVerdict {
  const t = typed.trim().toLowerCase()
  const w = word.trim().toLowerCase()
  if (t === w) return 'correct'
  // опечатка: <= TYPO_MAX_EDITS правок при длине слова >= TYPO_MIN_LEN (пороги в journal.ts)
  if (w.length >= TYPO_MIN_LEN && levenshtein(t, w) <= TYPO_MAX_EDITS) return 'typo'
  return 'wrong'
}

/** Парсинг числового ответа: "15", "-2.5", ".75", "3/4", запятая как точка */
export function parseNum(s: string): number | null {
  const t = s.trim().replace(',', '.')
  const frac = t.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/)
  if (frac) {
    const d = Number(frac[2])
    return d ? Number(frac[1]) / d : null
  }
  const n = Number(t)
  return Number.isFinite(n) && t !== '' ? n : null
}

/** Числовая проверка с относительным допуском (эквивалентные формы: 0.8 = 4/5) */
export function checkNumeric(typed: string, answer: string): TypeVerdict {
  const a = parseNum(answer)
  const t = parseNum(typed)
  if (a === null || t === null) {
    return typed.trim().toLowerCase() === answer.trim().toLowerCase() ? 'correct' : 'wrong'
  }
  return Math.abs(a - t) <= 1e-6 * Math.max(1, Math.abs(a)) ? 'correct' : 'wrong'
}

/**
 * Предлагаемая оценка по объективному результату (пользователь может переопределить).
 * Латентность учитывается: SAT — тест на скорость, верный-но-медленный ответ = Hard.
 * Опечатка предлагает Good: орфография на рецептивном экзамене не проверяется.
 */
/** Во сколько раз медленнее личной медианы ответ считается «трудным». */
export const SLOW_FACTOR = 2.5
/** Пол порога: ниже него «медленно» начнёт срабатывать на здоровых ответах. */
const SLOW_FLOOR_MS = 12_000

/**
 * Сколько ответов нужно виду карточек, чтобы верить его собственной медиане.
 * Меньше — шум: одна долгая ночная попытка сдвинет порог для всего вида.
 */
export const MIN_KIND_SAMPLES = 12

/**
 * Пол порога по видам, где в ответ входит чтение условия, а не только узнавание.
 * Замер 21.08.2026 по журналу: словарные ответы — медиана 8,1 с, карточки
 * разбора (kind error) — 21,6 с при p90 43,6 с. Общий пол в 12 с для них
 * означает, что нормальное чтение таблицы засчитывается как заминка.
 */
const KIND_FLOOR_MS: Record<string, number> = { math: 90_000, error: 45_000 }

/**
 * Порог «медленно» — доля от ЛИЧНОЙ медианы, а не константа.
 *
 * Стоял 25 000 мс при измеренной медиане ответа 7 412 мс и p90 17 827 мс, то
 * есть не достигался почти никогда. Результат виден в распределении оценок за
 * всю историю: Again 121, Hard 6, Good 271, Easy 3 — 98% в двух крайних
 * категориях. «Трудно» существовало на кнопке и не существовало в данных, а
 * FSRS различает Hard и Good именно затем, чтобы не гонять полузнание по тем же
 * интервалам, что и уверенное знание.
 *
 * ПОЧЕМУ МЕДИАНА ПО ВИДУ, А НЕ ОБЩАЯ. Общая медиана — это медиана словарных
 * ответов: их в журнале 447 из 464. Карточка разбора (kind error) требует
 * прочитать условие с таблицей и четыре длинных варианта, и её нормальный
 * ответ — 21,6 с при общем пороге 20,9 с. Итог замера 21.08.2026: 53% ответов
 * на такие карточки уходили в Hard против 12% у словарных, а Hard в состоянии
 * Learning не двигает ступень — карточка не выпускается и возвращается в каждый
 * следующий урок. Александр увидел один и тот же вопрос пятый раз именно так.
 *
 * Медиана берётся из журнала снаружи (`medianForKind`); без неё поведение
 * остаётся прежним.
 */
export function slowThresholdMs(kind = 'vocab', medianMs?: number): number {
  const floor = KIND_FLOOR_MS[kind] ?? SLOW_FLOOR_MS
  if (!medianMs || !Number.isFinite(medianMs) || medianMs <= 0) return Math.max(floor, 25_000)
  return Math.max(floor, Math.round(medianMs * SLOW_FACTOR))
}

/**
 * Медиана времени ответа для вида карточки: своя, пока её хватает на статистику,
 * иначе общая. Возвращать общую молча — единственный честный запасной путь:
 * пола по виду (KIND_FLOOR_MS) достаточно, чтобы холодный старт не наказывал
 * длинное условие.
 */
export function medianForKind(speed: { medianMs: number; byKind: Record<string, { medianMs: number; n: number }> }, kind = 'vocab'): number {
  const свой = speed.byKind[kind]
  return свой && свой.n >= MIN_KIND_SAMPLES && свой.medianMs > 0 ? свой.medianMs : speed.medianMs
}

export function suggestedGrade(format: Format, correct: boolean, typo: boolean, elapsedMs = 0, kind = 'vocab', medianMs?: number): Grade | null {
  if (format === 'reveal' || format === 'intro') return null
  if (!correct && !typo) return Rating.Again
  if (elapsedMs > slowThresholdMs(kind, medianMs)) return Rating.Hard
  return Rating.Good
}

/** Прогноз нагрузки: сколько учебных единиц придёт на повтор в ближайшие N дней (просрочка → сегодня) */
export function loadForecast(cards: CardView[], days = 7, now: Date = new Date()): number[] {
  const out = new Array(days).fill(0)
  const today = dayKey(now)
  const dayKeys = Array.from({ length: days }, (_, k) => addDaysKey(today, k))
  for (const i of expandItems(cards)) {
    if (i.fsrs.state === State.New) continue
    let d = dayKey(i.fsrs.due)
    if (d < today) d = today
    const idx = dayKeys.indexOf(d)
    if (idx >= 0) out[idx]++
  }
  return out
}

/**
 * Счётчики для главного экрана (в учебных единицах: карточка × навык).
 * newAvail тоже гасится NEW_STOP_DATE — иначе плашка «N новых» на Home обещала бы
 * ввод, которого buildQueue уже не даст, и расходилась бы с настоящим уроком.
 */
export function homeCounts(cards: CardView[], newBudget: number, now: Date = new Date()) {
  const eod = endOfStudyDay(now)
  const items = expandItems(cards)
  const learnDue = items.filter(i => isLearning(i.fsrs.state) && i.fsrs.due.getTime() <= now.getTime() + LEARN_AHEAD_MS).length
  const revDue = items.filter(i => i.fsrs.state === State.Review && i.fsrs.due.getTime() < eod.getTime()).length
  const newAvail = Math.min(items.filter(i => i.fsrs.state === State.New).length, Math.max(0, newIntroAllowed(now) ? newBudget : 0))
  const revTomorrow = items.filter(i => {
    const t = i.fsrs.due.getTime()
    return i.fsrs.state === State.Review && t >= eod.getTime() && t < eod.getTime() + 86400_000
  }).length + items.filter(i => isLearning(i.fsrs.state) && i.fsrs.due.getTime() > now.getTime() + LEARN_AHEAD_MS && i.fsrs.due.getTime() < eod.getTime() + 86400_000).length
  const active = cards.filter(c => !c.suspended)
  const byState = {
    new: active.filter(c => c.fsrs.state === State.New).length,
    learning: active.filter(c => isLearning(c.fsrs.state)).length,
    review: active.filter(c => c.fsrs.state === State.Review).length
  }
  return { learnDue, revDue, newAvail, revTomorrow, byState, total: active.length }
}

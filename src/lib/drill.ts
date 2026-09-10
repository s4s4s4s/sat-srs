import { Rating, type Grade, State } from 'ts-fsrs'
import type { CardView, Format, JournalRec, StudyItem } from './types'
import { dayKey, isoLocal } from './daytime'
import { journalElapsedMs, newId } from './journal'
import { degrade, hasMeaningHint, isLevelled, mcDistractors, meaningDistractors, type Cue, type TypeVerdict } from './scheduler'

/*
 * A12 (10.09.2026). Жалоба ученика: новое слово показывается один раз и пропадает.
 *
 * Причина была в стыке двух механик. После знакомства (`intro`) слово получало ОДНУ
 * отработку и `rateItem` уводил его на 10-минутную ступень FSRS (`holdOnIntroDay`,
 * scheduler.ts). Вернуться в тот же урок слово могло только сроком (`shouldRequeue`/
 * `requeuePosition` в scheduler.ts) - а он требует порядка тридцати карточек в остатке
 * очереди. На тонкой колоде их нет, и слово молча выпадало из урока: знакомство без
 * единой оценённой отработки не оставляло следа.
 *
 * Правило A12 чинит это ВТОРЫМ путём возврата слова в урок, не полагаясь на срок FSRS:
 * слово, введённое в этом уроке, получает не меньше DRILL_REPS оценённых отработок -
 * первая как раньше (обычная оценка через `rateItem`, двигает FSRS), дальше DRILL_REPS-1
 * дриллов с разрывом не меньше DRILL_GAP чужих экранов (тот же интервал, что и A2 у
 * знакомства - `pickNext` стережёт 60 секунд между показами одного слова). Дрилл
 * оценивается (в том числе Again), но FSRS-блок карточки НЕ двигает: верный ответ и
 * провал одинаково пишутся строкой журнала (`drillLine`), а расписание остаётся на том,
 * что дала первая настоящая отработка. Провал на дрилле (Again) - настоящая оценка,
 * и раньше плана дриллов срабатывает окно «Подзабылось» (см. ветку в `pickTask`).
 *
 * Не путать с `DRILL_PER_SESSION` (progress.ts): там - потолок добора forced-слов в
 * ПОСЛЕДУЮЩИХ уроках того же дня (`forcedTodaySlugs`, journal.ts), здесь - отработки
 * ВНУТРИ одного урока знакомства, план которых живёт в самой единице очереди
 * (`StudyItem.drill`), а не во внешнем счётчике экрана.
 */

/** Сколько оценённых отработок обязано получить слово, введённое в этом уроке: первая + дриллы. */
export const DRILL_REPS = 3

/*
 * Разрыв между дриллами - в чужих экранах, тот же порядок, что у A2/A3 (`NEW_GAP`,
 * `INTRO_GAP_MS` в scheduler.ts). Не вычисляется импортом `NEW_GAP + 1`: drill.ts и
 * scheduler.ts зовут друг друга по кругу (drill.ts берёт форматы/дистракторы у
 * scheduler.ts, scheduler.ts берёт `drillTask`/`DRILL_GAP` у drill.ts), и это безопасно,
 * ПОКА ни одна сторона не читает чужой экспорт на верхнем уровне модуля (тот же приём,
 * что уже описан в scheduler.ts для `logic.ts`). Верхнеуровневая константа `NEW_GAP + 1`
 * в drill.ts нарушила бы это условие: при входе в бандл со стороны scheduler.ts drill.ts
 * читал бы `NEW_GAP` ДО того, как scheduler.ts успевает его определить - живой замер
 * (esbuild, format=esm, entry=scheduler-подобный файл) отдал `DRILL_GAP = NaN` молча, без
 * единой ошибки. Поэтому DRILL_GAP - литерал; синхронность с NEW_GAP + 1 стережёт тест.
 */
export const DRILL_GAP = 3

/** Тот же срез единиц, что использует `forcedTodaySlugs` (journal.ts): только recall, только vocab. */
export function isDrillable(item: StudyItem): boolean {
  return (item.skill ?? 'recall') === 'recall' && item.view.kind === 'vocab'
}

/** Первая отработка слова, введённого в ЭТОМ уроке: план дриллов открывается ровно здесь. */
export function startsDrillPlan(item: StudyItem, prevState: State, format: Format): boolean {
  return prevState === State.New && format !== 'intro' && isDrillable(item)
}

/**
 * Единица после оценки дрилла (или первой отработки): следующая ступень плана.
 * Again держит ту же ступень - окно «Подзабылось» уже отработало провал (см. `pickTask`),
 * и повторять дрилл нужно с той же ступени, а не пропускать её. Плана ещё нет
 * (`item.drill` не задан - это была первая отработка) - план открывается ступенью 1
 * независимо от оценки: DRILL_REPS отработок обязательны и провалу, и попаданию.
 * План исчерпан (следующая ступень длиннее DRILL_REPS-1) - `null`, единица дриллов не ждёт.
 */
export function afterDrill(item: StudyItem, grade: Grade): StudyItem | null {
  const n = item.drill
  if (n === undefined) return { ...item, drill: 1 }
  if (grade === Rating.Again) return { ...item, drill: n }
  const next = n + 1
  return next > DRILL_REPS - 1 ? null : { ...item, drill: next }
}

/** Куда вставить дрилл: не дальше DRILL_GAP позиций от конца остатка очереди, но и не дальше самого остатка. */
export function drillInsertAt(restLen: number): number {
  return Math.min(restLen, DRILL_GAP)
}

/**
 * Формат и опора дрилла - свой ладдер, отдельный от REVIEW_CYCLE: дрилл проверяет узнавание
 * и производство слова прямо после знакомства, а не ротацию созревшей карточки.
 *
 * Дрилл 1 - узнавание в предложении (mc/sentence), откат на показ (reveal/sentence), если
 * в колоде не набралось трёх английских дистракторов. Дрилл 2 - производство (type/meaning),
 * если ввод включён и ответ однозначен (C5: слово без пробела и есть подсказка значения);
 * иначе узнавание слова по значению (mc/word) при трёх русских дистракторах, иначе снова
 * узнавание в предложении, иначе показ. `degrade` (scheduler.ts) - тот же откат cue/format,
 * что у REVIEW_CYCLE, подчищает выбор, если по ходу дела чего-то всё равно не хватило.
 */
export function drillTask(item: StudyItem, deck: CardView[], typing: boolean): { format: Format; cue: Cue } {
  const view = item.view
  const n = item.drill ?? 1
  if (n <= 1) {
    const step: { format: Format; cue: Cue } = mcDistractors(view, deck).length >= 3
      ? { format: 'mc', cue: 'sentence' }
      : { format: 'reveal', cue: 'sentence' }
    return degrade(step, item, deck, typing)
  }
  const producible = !view.word.includes(' ') && hasMeaningHint(view)
  const step: { format: Format; cue: Cue } =
    typing && producible ? { format: 'type', cue: 'meaning' }
      : meaningDistractors(view, deck).length >= 3 ? { format: 'mc', cue: 'word' }
      : mcDistractors(view, deck).length >= 3 ? { format: 'mc', cue: 'sentence' }
      : { format: 'reveal', cue: 'sentence' }
  return degrade(step, item, deck, typing)
}

/**
 * Строка журнала дрилла - по образцу `rateItem` (store.ts) и `logicReviewLine` (logic.ts),
 * но без полей расписания (new_state/due/stability/scheduled_days/elapsed_days): FSRS-блок
 * карточки дриллом не двигается, эти поля означали бы движение, которого не было.
 * `prev_state` - ТЕКУЩЕЕ состояние карточки (оно же и есть предыдущее для будущей настоящей
 * оценки: дрилл его не менял), а не состояние на момент первой отработки.
 */
export function drillLine(
  item: StudyItem,
  grade: Grade,
  elapsedMs: number,
  format: Format,
  now: Date,
  verdict?: TypeVerdict,
  gaveUp?: boolean,
  answerMs?: number,
  sense?: number
): JournalRec {
  return {
    id: newId(),
    v: 1,
    type: 'review',
    ts: isoLocal(now),
    ms: now.getMilliseconds(),
    day: dayKey(now),
    slug: item.view.slug,
    skill: item.skill,
    format,
    drill: item.drill ?? 1,
    // D: `correct` - чистое попадание, та же семантика, что у rateItem
    ...(verdict === undefined ? {} : { correct: verdict === 'correct' }),
    ...(verdict === 'typo' ? { typo: true } : {}),
    ...(verdict === 'twin' ? { twin: true } : {}),
    ...(verdict === 'cued' ? { cued: true } : {}),
    ...(gaveUp ? { gave_up: true } : {}),
    ...(item.view.kind !== 'vocab' ? { kind: item.view.kind } : {}),
    ...(item.view.domain ? { domain: item.view.domain } : {}),
    ...(isLevelled(item.view) && item.view.level < 999 ? { level: item.view.level } : {}),
    rating: grade,
    prev_state: item.fsrs.state,
    elapsed_ms: journalElapsedMs(elapsedMs, item.view.kind),
    ...(answerMs !== undefined ? { answer_ms: journalElapsedMs(answerMs, item.view.kind) } : {}),
    ...(sense !== undefined && sense > 0 ? { sense } : {}),
    synced: 0
  }
}

/**
 * Тесты 265 новых строк src/lib/scheduler.ts, добавленных вокруг выбора дистракторов и
 * оборота вокруг пропуска: stemRu, glossKey/glossParts (переписаны), meaningTwin (расширенное
 * правило двойников), blankSentence, blankPhrase, isFormOf и опорные константы
 * RU_ENDINGS/RU_STOP/RU_LIGHT/RU_NEGATION/PHRASE_BEFORE/PHRASE_AFTER.
 *
 * glossKey, glossParts и isFormOf не экспортированы из scheduler.ts, и export им здесь не
 * добавлен: их контракт целиком наблюдаем снаружи. glossKey/glossParts проверяются через
 * meaningTwin/sharesMeaning — тем же путём, которым их вызывает mcDistractors при выборе
 * дистракторов; isFormOf проверяется через поведение blankPhrase — единственное место, которое
 * его использует. Снаружи видно ровно то же самое, что видит вызывающий код, так что
 * расширять публичный API исходника ради теста незачем.
 *
 * Что проверяется и почему — по комментариям самого scheduler.ts, а не на глаз:
 *  - stemRu: приставка держит разницу между антонимами («сходиться»/«расходиться»,
 *    «утверждать»/«подтверждать») и не срезается никогда; возвратность («-ся») снимается;
 *    основа не короче RU_STEM_MIN — иначе короткие слова превращаются в огрызок («срок»),
 *    а «мера»/«мерить» слипаются в одну основу.
 *  - glossKey (через sharesMeaning): «укреплять» и «укреплять уже имеющееся» — один ключ,
 *    потому что ключ — основа ГЛАВНОГО слова, а не кусок целиком; «ставить под угрозу»/
 *    «ставить под сомнение» — разные ключи, потому что связка-RU_LIGHT смысла не несёт, пока
 *    за ней стоит дополнение; «производить» в одиночестве — связка становится значением сама;
 *    отрицание остаётся частью ключа (антонимы с «не» не путаются с положительной формой);
 *    пояснение в скобках выбрасывается ДО разбиения куска по запятой.
 *  - meaningTwin/sharesMeaning: общая основа даёт двойника; разные части речи — никогда, даже
 *    при общей основе; карточка без meaning_ru двойников не имеет вовсе.
 *  - blankSentence: отдаёт ЦЕЛОЕ предложение с пропуском, а не обрывок (на этом держится
 *    самодостаточность строки отметки в журнале).
 *  - blankPhrase: содержит сам пропуск; не выходит за границу предложения с пропуском;
 *    обрывается перед формой искомого слова, если та встречается повторно; многоточие стоит
 *    ровно на месте среза и не стоит там, где среза не было; формула $…$ — неделимый кусок;
 *    и главное — у двух карточек-синонимов из одного куста (один meaning_ru на всех в режиме
 *    cue:'meaning') обороты РАЗНЫЕ, иначе задание неразрешимо (см. докстроку blankPhrase —
 *    «______ the alibi» / «______ morale»).
 *
 * Живая колода (../sat-deck/Учёба/Карточки) подключается, если существует рядом с пакетом —
 * тем же приёмом, что test/data.test.ts и test/metrics.test.ts. Единственный способ увидеть,
 * что расширенное правило двойников (58% из 400 словарных карточек по замеру 22.08.2026)
 * не схлопывает пул дистракторов ниже трёх — ровно то, на чём падал session-sim.
 *
 * Запуск: `npm run test:synonyms` (esbuild бандлит файл и node его исполняет).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createEmptyCard } from 'ts-fsrs'
import { parseMd, cardView } from '../src/lib/yamlfm'
import {
  stemRu, sharesMeaning, meaningTwin, blankSentence, blankPhrase, mcDistractors,
  PHRASE_BEFORE, PHRASE_AFTER
} from '../src/lib/scheduler'
import type { CardView } from '../src/lib/types'

let passed = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}
function group(name: string): void { console.log(`  ✓ ${name}`); passed++ }
function skip(name: string): void { console.log(`  ⚠ ${name}`) }

// ---- фабрика карточки -------------------------------------------------------

/** Минимальная CardView для проверки чистых функций: значение и часть речи задаются вызовом. */
function card(word: string, meaning_ru: string, pos = 'verb', over: Partial<CardView> = {}): CardView {
  return {
    path: `deck/${word}.md`, slug: word, word, pos,
    context: '', contexts: [], contextsRu: [],
    meaning_en: '', meaning_ru, roots: '',
    source: 'test', added: '2026-07-20', level: 1, kind: 'vocab',
    domain: '', confusables: [], leech: '', choices: [], answerText: '', answerNum: '',
    desmos: false, explain: '', suspended: false,
    fsrs: createEmptyCard(new Date(2026, 7, 22)),
    prep: '', prepContext: '', fsrsPrep: null,
    ...over
  }
}

// ---- 1. stemRu: основа слова -------------------------------------------------

function stemRuChecks(): void {
  // Пример буквально из докстроки stemRu: три формы одного слова → одна основа.
  const forms = ['укреплять', 'укрепление', 'укреплённый'].map(stemRu)
  assert(new Set(forms).size === 1,
    `формы одного слова должны давать одну основу, получено [${forms.join(', ')}]`)
  group('stemRu: «укреплять» / «укрепление» / «укреплённый» дают одну основу')

  // Приставка неприкосновенна — на ней держится разница между антонимами колоды.
  assert(stemRu('сходиться') !== stemRu('расходиться'),
    `приставка «рас-» обязана менять основу: «${stemRu('сходиться')}» vs «${stemRu('расходиться')}»`)
  assert(stemRu('утверждать') !== stemRu('подтверждать'),
    `приставка «под-» обязана менять основу: «${stemRu('утверждать')}» vs «${stemRu('подтверждать')}»`)
  group('stemRu: приставка не срезается — «сходиться»/«расходиться» и «утверждать»/«подтверждать» остаются разными основами')

  // Возвратность снимается первым шагом: «сходиться» и «сходить» обязаны дать ту же основу.
  assert(stemRu('сходиться') === stemRu('сходить'),
    `возвратность обязана сниматься перед разбором окончания: «${stemRu('сходиться')}» vs «${stemRu('сходить')}»`)
  group('stemRu: возвратность («-ся»/«-сь») снимается перед разбором окончания')

  // RU_STEM_MIN = 4: короткое слово не режется в огрызок, «мера» и «мерить» не слипаются.
  assert(stemRu('срок') === 'срок',
    `короткое слово не должно резаться ниже порога RU_STEM_MIN, получено «${stemRu('срок')}»`)
  assert(stemRu('мера') !== stemRu('мерить'),
    `«мера» и «мерить» не должны слипнуться в одну основу, получено «${stemRu('мера')}» и «${stemRu('мерить')}»`)
  group('stemRu: основа не короче RU_STEM_MIN — короткие слова не превращаются в огрызок, «мера»/«мерить» не путаются')
}

// ---- 2. glossKey (через sharesMeaning): ключ куска значения ------------------

function glossKeyChecks(): void {
  // «укреплять» и «укреплять уже имеющееся» — один ключ: ключ — основа ГЛАВНОГО слова куска,
  // а не кусок целиком. Пример из докстроки glossKey: reinforce/buttress.
  const reinforce = card('reinforce', 'усиливать, укреплять уже имеющееся')
  const buttress = card('buttress', 'подкреплять, укреплять')
  assert(sharesMeaning(reinforce, buttress),
    'ключ — основа главного слова куска: «укреплять» и «укреплять уже имеющееся» обязаны дать один ключ')
  group('glossKey: ключ — основа главного слова, уточнение после него ключ не меняет')

  // «ставить под угрозу» vs «ставить под сомнение» — РАЗНЫЕ: связка «ставить» смысла не
  // несёт, пока за ней стоит дополнение, — смысл несёт дополнение.
  const compromise = card('compromise', 'ставить под угрозу')
  const contest = card('contest', 'ставить под сомнение')
  assert(!sharesMeaning(compromise, contest),
    '«ставить под угрозу» и «ставить под сомнение» не должны стать двойниками по общему «ставить»')
  group('glossKey: связка из RU_LIGHT пропускается вперёд, пока за ней есть дополнение — «ставить под X» и «ставить под Y» не совпадают')

  // «производить» — единственное содержательное слово куска, и потому само становится
  // ключом, а не отбрасывается как связка.
  const produce1 = card('yield', 'производить')
  const produce2 = card('generate', 'производить')
  const create = card('create', 'создавать')
  assert(sharesMeaning(produce1, produce2), 'два куска «производить» обязаны дать один и тот же ключ')
  assert(!sharesMeaning(produce1, create), '«производить» и «создавать» не должны совпасть — это разные слова')
  group('glossKey: единственное содержательное слово куска само становится ключом')

  // Отрицание остаётся частью ключа приставкой «не-»: «не обоснованный правилом» (arbitrary)
  // и «обосновывать» (justify) — антонимы, общий ключ выбросил бы лучший дистрактор друг к другу.
  const arbitrary = card('arbitrary', 'не обоснованный правилом')
  const justify = card('justify', 'обосновывать')
  assert(!sharesMeaning(arbitrary, justify),
    'отрицание обязано остаться в ключе: «не обоснованный правилом» и «обосновывать» — антонимы, не двойники')
  group('glossKey: отрицание — часть ключа, слово с «не» не путается с положительной формой')

  // Пояснение в скобках выбрасывается ДО разбиения куска по запятой — иначе кусок после
  // запятой ВНУТРИ скобок («…мнениях)») дал бы второй, ложный ключ.
  const convergeParen = card('converge', 'сходиться (о путях, мнениях)')
  const opinionWord = card('opine', 'мнение')
  assert(!sharesMeaning(convergeParen, opinionWord),
    'пояснение в скобках не должно протечь во второй ключ через запятую внутри скобок (иначе «мнение» ложно совпало бы со «сходиться (…мнениях)»)')
  const convergeParenA = card('convergeA', 'сходиться (о путях)')
  const convergeParenB = card('convergeB', 'сходиться (о мнениях)')
  assert(sharesMeaning(convergeParenA, convergeParenB),
    'разное содержимое скобок не должно менять ключ — пояснение выброшено целиком')
  group('glossKey: пояснение в скобках выбрасывается, а не становится вторым ключом через запятую внутри скобок')
}

// ---- 3. meaningTwin / sharesMeaning: двойники по значению --------------------

function meaningTwinChecks(): void {
  // Общая основа опознаётся — фокус здесь на meaningTwin/sharesMeaning, а не на glossKey
  // (та же пара reinforce/buttress, что и выше).
  const reinforce = card('reinforce', 'усиливать, укреплять уже имеющееся', 'verb')
  const buttress = card('buttress', 'подкреплять, укреплять', 'verb')
  assert(sharesMeaning(reinforce, buttress), 'общая основа куска значения обязана опознаваться как двойник')
  group('meaningTwin: пара с общей основой значения опознаётся двойником')

  // Разные части речи двойниками не считаются, даже при общей основе: слово другой части речи
  // в тот же пропуск не встаёт и введённым синонимом быть не может.
  const verbForm = card('reinforceV', 'укрепление', 'verb')
  const nounForm = card('reinforcementN', 'укрепление', 'noun')
  assert(!sharesMeaning(verbForm, nounForm),
    'общая основа при разных частях речи не должна давать двойника — слово другой части речи в тот же пропуск не встаёт')
  group('meaningTwin: разные части речи двойниками не считаются, даже при общей основе')

  // Карточка без meaning_ru двойников не имеет вовсе — ни как источник, ни как цель сравнения.
  const noMeaning = card('blank', '', 'verb')
  const hasMeaning = card('other', 'что-то', 'verb')
  assert(!meaningTwin(noMeaning)(hasMeaning) && !meaningTwin(hasMeaning)(noMeaning),
    'карточка без meaning_ru не должна иметь двойников — ни как источник, ни как цель сравнения')
  group('meaningTwin: карточка без meaning_ru двойников не имеет вовсе')
}

// ---- 4. blankSentence: целое предложение с пропуском -------------------------

function blankSentenceChecks(): void {
  const ctx = 'The lawyer cited three precedents to ______ her central argument. It worked in the end.'
  const full = 'The lawyer cited three precedents to ______ her central argument.'
  assert(blankSentence(ctx) === full,
    `blankSentence обязана вернуть ЦЕЛОЕ предложение с пропуском, а не обрывок: получено «${blankSentence(ctx)}»`)
  // Самодостаточность строки отметки в журнале: вводная часть, которую blankPhrase
  // намеренно обрезает (см. ниже), здесь на месте целиком.
  assert(blankSentence(ctx).includes('The lawyer cited three precedents'),
    'blankSentence не должна обрезать предложение так, как обрезает blankPhrase')
  group('blankSentence: возвращает целое предложение с пропуском, не обрывок')

  assert(blankSentence('Nothing to see here.') === '',
    'контекст без пропуска обязан дать пустую строку, а не первое предложение как есть')
  group('blankSentence: контекст без пропуска — пусто')
}

// ---- 5. blankPhrase: оборот вокруг пропуска -----------------------------------

function blankPhraseChecks(): void {
  assert(PHRASE_BEFORE === 1 && PHRASE_AFTER === 3,
    `константы оборота — 1 слева / 3 справа (обоснование замером в комментарии), получено ${PHRASE_BEFORE}/${PHRASE_AFTER}`)
  group('PHRASE_BEFORE=1, PHRASE_AFTER=3 — как задокументировано')

  const ctx = 'The lawyer cited three precedents to ______ her central argument.'
  const phrase = blankPhrase(ctx, 'buttress')
  assert(phrase.includes('______'), `оборот обязан содержать сам пропуск, получено «${phrase}»`)
  // Асимметричный срез в одном примере: слева обрезана вводная часть (многоточие есть),
  // справа предложение просто кончилось ровно на границе бюджета — многоточия там НЕТ.
  assert(phrase === '… to ______ her central argument',
    `многоточие обязано стоять ровно на месте среза слева и отсутствовать там, где среза справа не было: получено «${phrase}»`)
  group('blankPhrase: многоточие стоит ровно там, где срез произошёл, и не стоит там, где не произошёл')

  // Не выходит за границу предложения с пропуском, даже если следующее предложение длинное.
  const twoSentences = 'It ______ ended. Then something else happened here forever and ever.'
  const short = blankPhrase(twoSentences, 'x')
  assert(short === 'It ______ ended.',
    `оборот не имеет права выйти за предложение с пропуском (и не обязан искать многоточие, которого здесь не должно быть — сам пропуск близко к обоим краям предложения), получено «${short}»`)
  group('blankPhrase: не выходит за границу предложения с пропуском')

  // Обрывается перед формой искомого слова, если та встречается в предложении ещё раз.
  const repeat = 'The lawyer cited precedents to ______ her buttressed claim in court today.'
  const cut = blankPhrase(repeat, 'buttress')
  assert(!cut.includes('buttressed'), `форма искомого слова не должна попасть в оборот, получено «${cut}»`)
  assert(cut === '… to ______ her …',
    `срез должен произойти ровно перед формой искомого слова («buttressed»), получено «${cut}»`)
  group('blankPhrase: обрывается перед формой искомого слова, встреченной повторно')

  // Контекст без пропуска — пусто.
  assert(blankPhrase('Nothing to see here.', 'x') === '',
    'контекст без пропуска обязан дать пустой оборот')
  group('blankPhrase: контекст без пропуска — пусто')

  // Формула $…$ — неделимый кусок: попав в окно оборота, остаётся целой, а не рвётся на токены.
  const withFormula = 'The identity $x + 3 = 7$ ______ the theorem holds for all cases shown.'
  const formulaPhrase = blankPhrase(withFormula, 'prove')
  assert(formulaPhrase === '… $x + 3 = 7$ ______ the theorem holds …',
    `формула обязана войти в оборот целиком, не разрезанной на токены, получено «${formulaPhrase}»`)
  group('blankPhrase: формула $…$ не разрезается')

  // Ради чего всё затевалось: у двух карточек-синонимов из одного куста (общий meaning_ru,
  // то есть на экране в режиме cue:'meaning' будет один и тот же русский текст) обороты
  // РАЗНЫЕ — задание остаётся разрешимым. Пример буквально из докстроки blankPhrase.
  const buttressCtx = 'The evidence helped ______ the alibi presented in court.'
  const bolsterCtx = 'The extra funding helped ______ morale across the whole team.'
  const buttressPhrase = blankPhrase(buttressCtx, 'buttress')
  const bolsterPhrase = blankPhrase(bolsterCtx, 'bolster')
  assert(buttressPhrase !== bolsterPhrase,
    `синонимы одного куста («подкреплять, укреплять») обязаны получить разные обороты, иначе задание неразрешимо; получено одинаковое «${buttressPhrase}»`)
  group('blankPhrase: у синонимов одного куста обороты разные — задание остаётся разрешимым')
}

// ---- 6. живая колода (необязательно) -----------------------------------------

const DECK_DIR = process.env.SAT_DECK ?? path.join(process.cwd(), '..', 'sat-deck', 'Учёба', 'Карточки')

/**
 * Расширенное правило meaningTwin объявило синонимами 58% живой колоды (замер 22.08.2026,
 * 400 словарных карточек). Если из-за этого пул дистракторов схлопывается, выборка
 * откатывается на авторские confusables (mcDistractors) — но каждая словарная карточка,
 * дошедшая до выбора из четырёх (recall без авторских choices/answerNum — см. baseFormat/
 * pickTask), обязана получить три дистрактора хоть откуда-то. Именно на этом упал набор
 * session-sim: тест ровно тот регресс и проверяет, на настоящих данных, а не на фикстуре.
 */
function liveDeckChecks(): void {
  if (!existsSync(DECK_DIR)) {
    skip(`живая колода не найдена (${DECK_DIR}) — группа пропущена, это не эта машина`)
    return
  }
  const files = readdirSync(DECK_DIR).filter(f => f.endsWith('.md') && !f.startsWith('_'))
  if (!files.length) {
    skip(`живая колода не найдена: в ${DECK_DIR} нет файлов`)
    return
  }
  const cards: CardView[] = []
  for (const f of files) {
    const text = readFileSync(path.join(DECK_DIR, f), 'utf8')
    const { fm, body, broken } = parseMd(text)
    if (broken) continue
    cards.push(cardView({ path: `Учёба/Карточки/${f}`, sha: null, fm, body, dirty: 0 }))
  }
  assert(cards.length > 0, 'в живой колоде должны быть карточки')

  // «Дошла до выбора из четырёх» — словарная карточка (kind vocab) без авторских choices и
  // без числового ответа: именно её показ идёт через mcDistractors (авторские choices и
  // answerNum уходят своей веткой раньше — baseFormat в scheduler.ts).
  const candidates = cards.filter(c => !c.suspended && c.kind === 'vocab' && c.choices.length < 2 && !c.answerNum)
  assert(candidates.length > 0, 'в живой колоде должны быть словарные карточки-кандидаты на выбор из четырёх')

  const short: string[] = []
  for (const c of candidates) {
    if (mcDistractors(c, cards, 3).length < 3) short.push(c.slug)
  }
  console.log(`  ⓘ живая колода: ${cards.length} карточек, ${candidates.length} словарных кандидатов на выбор из четырёх, без трёх дистракторов: ${short.length}${short.length ? ' (' + short.slice(0, 15).join(', ') + (short.length > 15 ? ', …' : '') + ')' : ''}`)
  assert(short.length === 0,
    `расширенное правило двойников не должно схлопывать пул ниже трёх дистракторов (авторский откат на confusables обязан подхватить), не хватило: ${short.join(', ')}`)

  group(`живая колода: ${candidates.length} словарных карточек — у каждой нашлось три дистрактора`)
}

function main(): void {
  console.log('SRS синонимы/дистракторы — stemRu, glossKey/glossParts, meaningTwin, blankSentence/blankPhrase')
  stemRuChecks()
  glossKeyChecks()
  meaningTwinChecks()
  blankSentenceChecks()
  blankPhraseChecks()
  liveDeckChecks()
  console.log(`\nВсе проверки синонимов пройдены (${passed} групп).`)
}

try {
  main()
} catch (e) {
  console.error('\n✗ ТЕСТ СИНОНИМОВ УПАЛ:\n' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
}

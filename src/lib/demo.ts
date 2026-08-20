/**
 * Dev-only демо-режим для дизайн-скриншотов: ?demo&screen=home|review|summary|stats|add|settings&v=mc|new|type
 * В прод-бандл не попадает (guard на import.meta.env.DEV — vite вырезает ветку).
 */
import * as db from './db'
import { dayKey } from './daytime'
import { DEFAULT_SETTINGS, type CardRec, type JournalRec } from './types'

const day = (off: number) => new Date(Date.now() + off * 86400000)

/* Перевод примера для демо-карточек. В колоде он лежит полем `contexts_ru`
   и показывается под предложением после ответа, поэтому демо без него не даёт
   увидеть этот экран целиком. Ключ — само предложение: одна и та же фраза
   встречается в нескольких наборах, а перевод у неё один. */
const ПЕРЕВОД_ПРИМЕРА: Record<string, string> = {
  'Members must ______ to the rules.': 'Участники обязаны придерживаться правил.',
  'We can only ______ the cause.': 'О причине мы можем только догадываться.',
  'They ______ for reform.': 'Они отстаивают реформу.',
  'The data ______ the claim.': 'Данные опровергают это утверждение.',
  'Results ______ the theory.': 'Результаты укрепляют теорию.',
  'The wording is ______.': 'Формулировка неоднозначна.',
  'A ______ argument.': 'Тонкий, взвешенный довод.',
  'An ______ in the data.': 'Аномалия в данных.',
  'The ______ is flawed.': 'Посылка ошибочна.',
  'The fame of trends is ______, fading fast.': 'Слава трендов недолговечна и гаснет быстро.',
  'The link remains ______ at best.': 'Связь в лучшем случае остаётся шаткой.',
  'The fame of most online trends is ______, fading within weeks.':
    'Слава большинства интернет-трендов недолговечна: она гаснет за считанные недели.',
  'Saving is a ______ habit.': 'Копить — благоразумная привычка.',
  'Smartphones are ______ now.': 'Смартфоны теперь повсюду.',
  'Results ______ confidence.': 'Результаты укрепляют уверенность.',
  'Historians ______ the loss.': 'Историки сожалеют об этой утрате.',
  'The evidence pointed to one conclusion ______ the bridge had been failing for years.':
    'Свидетельства указывали на один вывод: мост разрушался годами.'
}

/** Поле `contexts_ru` — только если перевод примера известен: иначе строки просто нет. */
const переводПримера = (ctx: string) => {
  const ru = ПЕРЕВОД_ПРИМЕРА[ctx]
  return ru ? { contexts_ru: [ru] } : {}
}

function card(word: string, ru: string, en: string, ctx: string, st: number, reps: number, dueOff: number, extra: Record<string, any> = {}): CardRec {
  return {
    path: `Учёба/Карточки/${word}.md`, sha: 'demo-' + word, dirty: 0, body: '',
    fm: {
      type: 'card', word, pos: 'adj', meaning_en: en, meaning_ru: ru, context: ctx,
      ...переводПримера(ctx),
      roots: 'epi- (на) + hēmera (день) — «живущий один день»', my_sentence: '', source: 'seed',
      added: '2026-07-16', first_seen: '2026-07-16', suspended: false,
      fsrs: {
        state: st, due: day(dueOff).toISOString(), stability: st === 2 ? 6.4 : 0, difficulty: st === 2 ? 5 : 0,
        elapsed_days: 0, scheduled_days: 1, learning_steps: 0, reps, lapses: 0,
        last_review: st === 2 ? day(-2).toISOString() : null
      },
      ...extra
    }
  }
}

export async function maybeDemo(): Promise<{ screen: string | null; section: 'rw' | 'grammar' | 'math' } | null> {
  if (!import.meta.env.DEV) return null
  const p = new URLSearchParams(location.search)
  if (!p.has('demo')) return null

  const v = p.get('v') ?? 'mc'
  const mathCard = (slug: string, dueOff: number): CardRec => ({
    path: `Учёба/Карточки/${slug}.md`, sha: 'demo-' + slug, dirty: 0, body: '', fm: {
      type: 'card', kind: 'math', word: 'системы: подстановка',
      context: 'Система: $y = 2x + 1$ и $3x + y = 16$. Самый быстрый первый шаг?',
      choices: ['подставить $2x+1$ вместо $y$', 'сложить уравнения почленно', 'выразить $x$ из второго', 'перебирать целые $x$'],
      answer: 'подставить $2x+1$ вместо $y$',
      explain: 'Подстановка: $3x + (2x+1) = 16$ даёт $x = 3$.',
      domain: 'ALG', desmos: false, source: 'seed-math', added: '2026-07-18', suspended: false,
      fsrs: { state: 2, due: day(dueOff).toISOString(), stability: 5, difficulty: 5, elapsed_days: 0, scheduled_days: 1, learning_steps: 0, reps: 1, lapses: 0, last_review: day(-2).toISOString() } }
  })
  const gramCtx = 'The evidence pointed to one conclusion ______ the bridge had been failing for years.'
  const gramCard = (dueOff: number): CardRec => ({
    path: 'Учёба/Карточки/gram-colon.md', sha: 'demo-gram', dirty: 0, body: '', fm: {
      type: 'card', kind: 'grammar', word: 'двоеточие вводит пояснение',
      context: gramCtx,
      choices: [':', ';', '—', ','], answer: ':',
      ...переводПримера(gramCtx),
      explain: 'Двоеточие ставится ПОСЛЕ законченного предложения и вводит пояснение или список.',
      domain: 'SEC', source: 'seed-grammar', added: '2026-07-18', suspended: false,
      fsrs: { state: 2, due: day(dueOff).toISOString(), stability: 5, difficulty: 5, elapsed_days: 0, scheduled_days: 1, learning_steps: 0, reps: 1, lapses: 0, last_review: day(-2).toISOString() } }
  })
  const cards: CardRec[] =
    v === 'reintro' ? [
      // слово в Relearning (после «Заново») — первый показ должен быть окном-знакомством с подписью «Подзабылось»
      card('ubiquitous', 'вездесущий', 'present everywhere', 'Smartphones are ______ now.', 3, 3, -1)
    ] :
    v === 'path' ? [
      // визуальная проверка экрана «Путь»: L1 пройден, L2 активный, L3–L4 заперты
      card('adhere', 'придерживаться', 'to stick to', 'Members must ______ to the rules.', 2, 4, 3, { pos: 'verb', level: 1 }),
      card('surmise', 'предполагать', 'to guess', 'We can only ______ the cause.', 2, 4, 3, { pos: 'verb', level: 1 }),
      card('advocate', 'отстаивать', 'to support', 'They ______ for reform.', 2, 3, 2, { pos: 'verb', level: 2 }),
      card('refute', 'опровергать', 'to disprove', 'The data ______ the claim.', 1, 1, 0, { pos: 'verb', level: 2 }),
      card('bolster', 'укреплять', 'to support', 'Results ______ the theory.', 0, 0, 0, { pos: 'verb', level: 2 }),
      card('ambiguous', 'неоднозначный', 'unclear', 'The wording is ______.', 0, 0, 0, { pos: 'adjective', level: 3 }),
      card('nuanced', 'тонкий', 'subtle', 'A ______ argument.', 0, 0, 0, { pos: 'adjective', level: 3 }),
      card('anomaly', 'аномалия', 'irregularity', 'An ______ in the data.', 0, 0, 0, { pos: 'noun', level: 4 }),
      card('premise', 'посылка', 'basis', 'The ______ is flawed.', 0, 0, 0, { pos: 'noun', level: 4 })
    ] :
    v === 'mix' ? [
      card('ephemeral', 'недолговечный', 'lasting a very short time', 'The fame of trends is ______, fading fast.', 2, 2, -1),
      card('tenuous', 'шаткий', 'very weak', 'The link remains ______ at best.', 0, 0, 0),
      gramCard(-1),
      mathCard('math-sys', -1)
    ] : v === 'grammar' ? [
      gramCard(-1)
    ] : v === 'math' ? [
      mathCard('math-sys', -1)
    ] : v === 'new' ? [
      card('ephemeral', 'недолговечный, мимолётный', 'lasting for a very short time', 'The fame of most online trends is ______, fading within weeks.', 0, 0, 0)
    ] : v === 'newmany' ? [
      // худший случай для разрядки: одни новые, повторений-разделителей нет
      card('ephemeral', 'недолговечный', 'lasting a very short time', 'The fame of trends is ______, fading fast.', 0, 0, 0),
      card('tenuous', 'шаткий', 'very weak', 'The link remains ______ at best.', 0, 0, 0),
      card('prudent', 'благоразумный', 'acting with care', 'Saving is a ______ habit.', 0, 0, 0)
    ] : v === 'type' ? [
      card('ephemeral', 'недолговечный, мимолётный', 'lasting for a very short time', 'The fame of most online trends is ______, fading within weeks.', 2, 1, -1),
      card('prudent', 'благоразумный', 'acting with care', 'Saving is a ______ habit.', 0, 0, 5)
    ] : [
      card('ephemeral', 'недолговечный, мимолётный', 'lasting for a very short time', 'The fame of most online trends is ______, fading within weeks.', 2, 2, -1),
      card('tenuous', 'слабый, шаткий', 'very weak or slight', 'The link remains ______ at best.', 2, 4, 3),
      card('prudent', 'благоразумный', 'acting with care', 'Saving is a ______ habit.', 2, 4, 3),
      card('ubiquitous', 'вездесущий', 'present everywhere', 'Smartphones are ______ now.', 2, 4, 3),
      card('bolster', 'укреплять', 'to support', 'Results ______ confidence.', 0, 0, 0),
      card('lament', 'сожалеть', 'to mourn', 'Historians ______ the loss.', 0, 0, 0)
    ]

  const journal: JournalRec[] = [{
    id: 'demo-s1', type: 'session', ts: day(-1).toISOString(), day: dayKey(day(-1)),
    dur_ms: 960000, reviews: 12, new_seen: 4, acc: 83, queue_empty: true, synced: 1
  }]

  if (p.get('screen') !== 'settings') {
    localStorage.setItem('sat-srs-settings', JSON.stringify({
      // 'demo' вместо ключей: демо показывает приложение настроенным, а не пустым;
      // настоящих запросов из демо не уходит — GitHub и очередь разборов отвечают отказом
      pat: 'demo', coachToken: 'demo', owner: 's4s4s4s', repo: 'second-brain', branch: 'master',
      // норму берём из дефолта, а не литералом: копия уже разъехалась с ним
      // (в демо оставались прежние 15, когда рабочая норма стала 8)
      basePath: 'Учёба/Карточки', newPerDay: DEFAULT_SETTINGS.newPerDay, requestRetention: 0.9
    }))
  } else {
    localStorage.removeItem('sat-srs-settings')
  }
  await db.putCards(cards)
  await db.putJournal(journal)
  if (v === 'path') {
    await db.kvSet('levelNames', {
      '1': 'Твои ошибки PT4', '2': 'Аргументация I', '3': 'Прилагательные I', '4': 'Существительные'
    })
  }
  const section = v === 'grammar' ? 'grammar' : v === 'math' ? 'math' : 'rw'
  return { screen: p.get('screen'), section }
}

export function demoSession() {
  return { day: dayKey(), reviews: 14, newSeen: 4, again: 2, passRev: 8, totalRev: 9, durMs: 754000, queueEmpty: true }
}

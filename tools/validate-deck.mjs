#!/usr/bin/env node
/**
 * Проверка колоды SAT. Запускается в CI ТОГО репозитория, где лежат карточки.
 *
 * Зачем. До сих пор единственным контролем был `buildReport` внутри приложения:
 * он проверял пять требований контракта из примерно двенадцати, вызывался только
 * во время push и писал в `_отчёт.md`, датированный 31.07. Битая карточка
 * доезжала до ученика и превращалась в «ложную пиявку» — невыигрываемое
 * задание, которое FSRS честно считает провалом памяти. Тьютор узнавал об этом
 * через недели, когда слово доходило до Review, или не узнавал вовсе.
 *
 * Теперь ошибка ломает CI через минуту после коммита.
 *
 * Уровни: ОШИБКА валит прогон (карточка невыигрываема или молча мертва),
 * ПРЕДУПРЕЖДЕНИЕ печатается и прогон не валит (качество, а не корректность) —
 * иначе первый же запуск на живой колоде был бы красным от 137 карточек с одним
 * контекстом, и его бы отключили.
 *
 * Запуск: node tools/validate-deck.mjs [папка] [--строго]
 */

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

/* Разбор шапки без обязательной зависимости.
   В репозитории кода есть js-yaml и он точнее. В вальте CI запускает голый
   `node` без npm install, зато там лежит собственный `_tools/фронтматтер.mjs` —
   тот самый плоский разбор, которым живёт весь вальт. Его слепота к вложенным
   картам здесь безвредна: блок `fsrs` мы не проверяем, он зона приложения.
   Порядок попыток фиксирован, чтобы поведение не зависело от того, где запущено. */
async function взятьРазбор() {
  try {
    const yaml = (await import('js-yaml')).default
    return { имя: 'js-yaml', разобрать: (s) => yaml.load(s, { schema: yaml.CORE_SCHEMA }) }
  } catch { /* нет зависимости — идём дальше */ }
  for (const p of ['../фронтматтер.mjs', '../../фронтматтер.mjs', './фронтматтер.mjs']) {
    try {
      const m = await import(new URL(p, import.meta.url).href)
      return { имя: 'фронтматтер.mjs', разобрать: (s) => m.разобрать(`---\n${s}\n---\n`).fm }
    } catch { /* следующий путь */ }
  }
  throw new Error('не найден ни js-yaml, ни _tools/фронтматтер.mjs — разбирать шапку нечем')
}

const ПРОПУСК = 20                 // максимум символов подчёркивания подряд не проверяем — ищем 3+
const МАКС_СИМВОЛОВ = 140          // длиннее — шрифт в приложении падает с 23px до 17px
const СЛОВ_МИН = 8
const СЛОВ_МАКС = 20
const POS = new Set(['verb', 'noun', 'adj', 'adv', 'transition'])
const ДОМЕНЫ = new Set(['II', 'CS', 'EOI', 'SEC', 'ALG', 'AM', 'PSDA', 'GEO'])

const ошибки = []
const предупреждения = []
const бей = (f, m) => ошибки.push(`${f}: ${m}`)
const шепни = (f, m) => предупреждения.push(`${f}: ${m}`)

/** Пропуск внутри $…$ молча убивает формулу: строка режется по пропуску ДО KaTeX,
 *  непарный `$` остаётся в каждой половине и формула становится текстом. */
function пропускВФормуле(s) {
  const i = s.indexOf('___')
  if (i < 0) return false
  return (s.slice(0, i).match(/\$/g) || []).length % 2 === 1
}

function проверитьКарточку(файл, fm) {
  const kind = fm.kind ?? 'vocab'
  const словарная = kind === 'vocab' && fm.pos !== 'transition'

  if (!fm.word) return бей(файл, 'нет поля word — карточка не покажется')

  // --- авторские варианты (error / grammar / math) ---
  if (Array.isArray(fm.choices) && fm.choices.length >= 2) {
    if (fm.answer === undefined) бей(файл, 'есть choices, но нет answer — задание невыигрываемо')
    else if (!fm.choices.some(c => String(c) === String(fm.answer)))
      бей(файл, `answer «${fm.answer}» не совпадает ни с одним choices посимвольно — ложная пиявка`)
    if (Array.isArray(fm.contexts) && fm.contexts.length > 1)
      бей(файл, 'contexts у карточки с choices: предложение прокрутится, а варианты и ответ останутся — второй показ невыигрываем')
  }

  // --- контексты ---
  const ctxs = Array.isArray(fm.contexts) && fm.contexts.length ? fm.contexts : (fm.context ? [fm.context] : [])
  if (словарная && !ctxs.length) бей(файл, 'нет ни context, ни contexts — словарную карточку не о чем спрашивать')

  if (Array.isArray(fm.contexts) && fm.contexts.length && fm.context !== undefined) {
    // как только массив появился, поле context приложением не читается вовсе
    if (String(fm.contexts[0]) !== String(fm.context))
      бей(файл, 'contexts[0] не равен context посимвольно — правка в context молча не долетит до показа')
  }

  /* Пропуск обязателен только там, где ответ — само слово.
     У карточки с авторскими `choices` (error / grammar / math) контекст это
     формулировка вопроса, а не клоуз: «Какой факт ослабляет тезис?» — пропуску
     там взяться неоткуда, и требовать его значит требовать испортить карточку.
     Первый прогон на живой колоде поймал этим правилом 10 логических карточек;
     дефектом оказалось правило, а не они. */
  const авторскиеВарианты = Array.isArray(fm.choices) && fm.choices.length >= 2
  ctxs.forEach((c, i) => {
    const s = String(c)
    const пропусков = (s.match(/_{3,}/g) || []).length
    if (пропусков === 0 && !авторскиеВарианты) бей(файл, `contexts[${i}]: нет пропуска — предложение покажется вместе с искомым словом, и показ уйдёт в FSRS как честный ответ`)
    else if (пропусков > 1) бей(файл, `contexts[${i}]: пропусков ${пропусков}, должен быть ровно один`)
    if (пропускВФормуле(s)) бей(файл, `contexts[${i}]: пропуск внутри $…$ — формула молча превратится в текст`)
    if (словарная && new RegExp(`\\b${String(fm.word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(s))
      бей(файл, `contexts[${i}]: искомое слово упомянуто в предложении`)
    if (s.length > МАКС_СИМВОЛОВ) шепни(файл, `contexts[${i}]: ${s.length} символов при пределе ${МАКС_СИМВОЛОВ}`)
    const слов = s.split(/\s+/).filter(Boolean).length
    if (слов < СЛОВ_МИН || слов > СЛОВ_МАКС) шепни(файл, `contexts[${i}]: ${слов} слов, норма ${СЛОВ_МИН}–${СЛОВ_МАКС}`)
  })

  if (словарная && ctxs.length < 2)
    шепни(файл, `контекст один, норма контракта 3 (минимум 2) — при одном включается режим «по значению», ротации нет`)

  // --- поля ---
  if (fm.pos !== undefined && !POS.has(String(fm.pos)))
    бей(файл, `pos «${fm.pos}» вне словаря (${[...POS].join(', ')}) — расщепление adj/adjective уже стоило колоде разъехавшейся выборки дистракторов`)
  if (fm.domain !== undefined && !ДОМЕНЫ.has(String(fm.domain)))
    бей(файл, `domain «${fm.domain}» вне списка College Board`)
  if (словарная && fm.level === undefined)
    шепни(файл, 'нет level — слово уйдёт в хвост (999) и всплывёт последним')
  if (!словарная && fm.level !== undefined)
    бей(файл, 'level у несловарной карточки: уровни только для kind vocab и pos ≠ transition')
  /* Значение сверяем как текст: типизация зависит от парсера (js-yaml даёт
     boolean, плоский разбор вальта — строку), а проверяем мы карточку, а не
     парсер. */
  if (fm.suspended !== undefined && !['true', 'false'].includes(String(fm.suspended).trim()))
    бей(файл, `suspended должно быть true/false, а не «${fm.suspended}»`)
  if (fm.level !== undefined && !/^\d+$/.test(String(fm.level).trim()))
    бей(файл, `level должно быть целым числом, а не «${fm.level}»`)
}

async function main() {
  const dir = process.argv[2] ?? 'Учёба/Карточки'
  const строго = process.argv.includes('--строго')
  const разбор = await взятьРазбор()
  const файлы = (await readdir(dir)).filter(f => f.endsWith('.md') && !f.startsWith('_'))
  console.log(`Разбор: ${разбор.имя}`)

  for (const f of файлы) {
    const текст = await readFile(path.join(dir, f), 'utf8')
    const m = текст.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!m) { бей(f, 'нет frontmatter — карточка не будет разобрана'); continue }
    let fm
    try {
      fm = разбор.разобрать(m[1])
    } catch (e) {
      // битый YAML гасит карточку целиком и молча
      бей(f, `YAML не разбирается: ${e.message.split('\n')[0]}`)
      continue
    }
    if (!fm || typeof fm !== 'object') { бей(f, 'frontmatter пуст'); continue }
    проверитьКарточку(f, fm)
  }

  console.log(`Проверено карточек: ${файлы.length}`)
  if (предупреждения.length) {
    console.log(`\nПРЕДУПРЕЖДЕНИЯ (${предупреждения.length}) — прогон не валят:`)
    for (const w of предупреждения.slice(0, 40)) console.log('  ·', w)
    if (предупреждения.length > 40) console.log(`  … и ещё ${предупреждения.length - 40}`)
  }
  if (ошибки.length) {
    console.log(`\nОШИБКИ (${ошибки.length}):`)
    for (const e of ошибки) console.log('  ✗', e)
    process.exit(1)
  }
  if (строго && предупреждения.length) {
    console.log('\n--строго: предупреждения считаются ошибками.')
    process.exit(1)
  }
  console.log('\nОшибок нет.')
}

main().catch(e => { console.error(e); process.exit(1) })

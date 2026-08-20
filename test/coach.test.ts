/**
 * Тесты разбора «Почему?» (src/lib/coach.ts).
 *
 * Проверяется то, что ломается молча и дорого: запрос без выбранного учеником
 * варианта (модель объясняет не то, о чём спросили), ключ кэша, который не
 * различает две разные пары (ученик получает чужой разбор), склейка потока по
 * кускам (текст рвётся посреди буквы) и ключ Anthropic, утёкший в тело запроса.
 *
 * Сеть подменяется: настоящих обращений к API отсюда нет.
 *
 * Запуск: `npm run test:coach` (esbuild бандлит файл и node его исполняет).
 */
import { buildPrompt, cacheKey, askWhy, CoachError, COACH_MODEL, type WhyAsk } from '../src/lib/coach'

let passed = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}
function group(name: string): void { console.log(`  ✓ ${name}`); passed++ }

/** Показ, с которого началась кнопка: пара corroborate / bolster. */
const VOCAB: WhyAsk = {
  kind: 'vocab',
  word: 'corroborate',
  pos: 'v.',
  meaningEn: 'to support with evidence',
  meaningRu: 'подтверждать доказательствами',
  roots: 'com- (вместе) + robur (сила)',
  sentence: 'New fossil evidence served to ____ the hypothesis that birds descended from dinosaurs.',
  sentenceRu: 'Новые ископаемые свидетельства подтвердили гипотезу о происхождении птиц от динозавров.',
  answer: 'corroborate',
  picked: 'bolster',
  explain: ''
}

const GRAM: WhyAsk = {
  kind: 'grammar', word: 'запятая перед вводным оборотом', pos: '', meaningEn: '', meaningRu: '',
  roots: '', sentence: 'However ____ the results were reproduced twice.', sentenceRu: '',
  answer: ', (запятая)', picked: 'без знака', explain: 'Вводное слово отделяется запятой.'
}

// ── W1: в запросе есть всё, без чего разбор бессмыслен ------------------------
function promptCarriesTheCase(): void {
  const { system, user } = buildPrompt(VOCAB)
  assert(system.length > 0, 'system-часть запроса пуста')
  assert(user.includes(VOCAB.sentence), 'в запросе нет самого предложения')
  assert(user.includes('corroborate'), 'в запросе нет правильного ответа')
  assert(user.includes('bolster'), 'в запросе нет выбранного учеником варианта — модели нечего сравнивать')
  assert(user.includes(VOCAB.sentenceRu), 'перевод предложения не попал в запрос')
  assert(user.includes(VOCAB.meaningRu), 'значение слова из карточки не попало в запрос')
  assert(user.includes(VOCAB.roots), 'корни из карточки не попали в запрос')
  group('W1: запрос несёт предложение, оба варианта и данные карточки')
}

// ── W2: показ без ответа ------------------------------------------------------
/* «Не помню» — тоже повод спросить «почему»; сравнивать тогда не с чем, и это
   должно быть сказано словами, а не пустой строкой «Ученик выбрал: ». */
function promptWithoutPick(): void {
  const { user } = buildPrompt({ ...VOCAB, picked: '' })
  assert(!user.includes('Ученик выбрал'), 'при пустом выборе в запрос ушла пустая строка выбора')
  assert(user.includes('не ответил'), 'в запросе не сказано, что ответа не было')
  assert(!user.includes('разница между этими двумя'),
    'у показа без ответа спрашивается разница между двумя вариантами, которых нет')
  group('W2: показ без ответа спрашивает не про разницу, а про уместность')
}

// ── W3: словарные поля не лезут в грамматику ----------------------------------
function promptByKind(): void {
  const { user } = buildPrompt(GRAM)
  assert(user.includes('грамматике'), 'грамматическое задание не названо грамматическим')
  assert(user.includes(GRAM.word), 'правило карточки не попало в запрос')
  assert(!user.includes('Карточка слова'), 'грамматике приписан словарный блок карточки')
  assert(user.includes(GRAM.explain), 'авторское пояснение карточки не попало в запрос')
  assert(buildPrompt({ ...VOCAB, kind: 'math' }).user.includes('математике'), 'математика не названа математикой')
  assert(buildPrompt({ ...VOCAB, kind: '' }).user.includes('словарь'), 'пустой kind не считается словарным заданием')
  group('W3: вид задания и состав полей зависят от kind')
}

// ── W4: пустые поля карточки не оставляют пустых строк ------------------------
function promptNoEmptyLines(): void {
  const голая: WhyAsk = { ...VOCAB, pos: '', meaningEn: '', meaningRu: '', roots: '', sentenceRu: '', explain: '' }
  const { user } = buildPrompt(голая)
  for (const строка of user.split('\n')) {
    assert(!/:\s*$/.test(строка), `в запросе висит поле без значения: «${строка}»`)
  }
  assert(!user.includes('Корни:'), 'пустые корни попали в запрос заголовком')
  group('W4: пустые поля карточки не превращаются в пустые строки запроса')
}

// ── W5: ключ кэша ------------------------------------------------------------
function cacheKeys(): void {
  assert(cacheKey(VOCAB) === cacheKey({ ...VOCAB }), 'ключ кэша не стабилен на одном и том же показе')
  const разные: Array<[string, WhyAsk]> = [
    ['другой выбор ученика', { ...VOCAB, picked: 'undermine' }],
    ['правка предложения в колоде', { ...VOCAB, sentence: VOCAB.sentence.replace('New', 'Recent') }],
    ['другой правильный ответ', { ...VOCAB, answer: 'substantiate' }],
    ['другое слово', { ...VOCAB, word: 'bolster' }],
    ['другой вид задания', { ...VOCAB, kind: 'grammar' }]
  ]
  const свой = cacheKey(VOCAB)
  const все = new Set([свой])
  for (const [почему, a] of разные) {
    const k = cacheKey(a)
    assert(k !== свой, `ключ кэша не различает: ${почему} — ученик получит чужой разбор`)
    все.add(k)
  }
  assert(все.size === разные.length + 1, 'два разных показа получили один ключ кэша')
  assert(свой.startsWith('why:'), 'ключ кэша без своего пространства имён — столкнётся с другими записями kv')
  assert(!свой.includes(VOCAB.sentence), 'ключ кэша тащит в себя целое предложение вместо хэша')
  group('W5: ключ кэша стабилен и различает всё, от чего зависит разбор')
}

/** События SSE так, как их шлёт API. */
function sse(события: object[]): string {
  return события.map(e => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

function textEvents(куски: string[]): string {
  return sse([
    { type: 'message_start', message: { id: 'msg_test' } },
    { type: 'content_block_start', index: 0 },
    ...куски.map(t => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' }
  ]) + 'data: [DONE]\n\n'
}

/** Тело-поток, нарезанное по `шаг` БАЙТ: границы рвут и события, и буквы. */
function stream(текст: string, шаг: number): ReadableStream<Uint8Array> {
  const байты = new TextEncoder().encode(текст)
  let i = 0
  return new ReadableStream({
    pull(c) {
      if (i >= байты.length) { c.close(); return }
      c.enqueue(байты.slice(i, i + шаг))
      i += шаг
    }
  })
}

type Запрос = { url: string; init: RequestInit }

/** Подменяет глобальный fetch на время одного вызова и возвращает, что улетело. */
async function withFetch<T>(ответ: (r: Запрос) => unknown, дело: () => Promise<T>): Promise<[T | Error, Запрос[]]> {
  const было = globalThis.fetch
  const запросы: Запрос[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    запросы.push({ url: String(url), init })
    const r = ответ({ url: String(url), init })
    if (r instanceof Error) throw r
    return r as Response
  }) as unknown as typeof fetch
  try {
    return [await дело(), запросы]
  } catch (e) {
    return [e as Error, запросы]
  } finally {
    globalThis.fetch = было
  }
}

const КЛЮЧ_ДЛЯ_ТЕСТА = 'sk-ant-НЕ-НАСТОЯЩИЙ-ключ-только-для-теста'

// ── W6: склейка потока -------------------------------------------------------
/* Куски приходят как придётся: событие рвётся пополам, кириллица — посреди буквы. */
async function streamAssembly(): Promise<void> {
  const части = ['Разница ', 'в том, ', 'что подтверждают ', 'доказательствами.']
  const тело = textEvents(части)
  for (const шаг of [1, 3, 7, 64, 100000]) {
    const пришло: string[] = []
    const [итог] = await withFetch(
      () => ({ ok: true, status: 200, body: stream(тело, шаг) }),
      () => askWhy(КЛЮЧ_ДЛЯ_ТЕСТА, VOCAB, s => { if (s) пришло.push(s) })
    )
    assert(!(итог instanceof Error), `поток кусками по ${шаг} байт упал: ${итог}`)
    assert(итог === части.join(''), `поток кусками по ${шаг} байт собрался неверно: «${итог}»`)
    assert(пришло.join('') === части.join(''), `onDelta по кускам в ${шаг} байт отдал не тот текст`)
    assert(пришло.length > 0, `onDelta ни разу не вызван при кусках по ${шаг} байт`)
  }
  group('W6: поток собирается верно при любой нарезке — событие и буква рвутся безопасно')
}

// ── W7: ответ без тела-потока -------------------------------------------------
async function noBodyFallback(): Promise<void> {
  const тело = textEvents(['Ответ ', 'целиком.'])
  const [итог] = await withFetch(
    () => ({ ok: true, status: 200, body: null, text: async () => тело }),
    () => askWhy(КЛЮЧ_ДЛЯ_ТЕСТА, VOCAB)
  )
  assert(итог === 'Ответ целиком.', `без тела-потока разбор собрался неверно: «${итог}»`)
  group('W7: ответ без тела-потока читается целиком тем же разбором событий')
}

// ── W8: отказы ----------------------------------------------------------------
async function failures(): Promise<void> {
  const случаи: Array<[number, string]> = [[401, 'ключ'], [403, 'ключ'], [429, 'подожд'], [503, 'недоступ']]
  for (const [status, слово] of случаи) {
    const [итог] = await withFetch(
      () => ({ ok: false, status, text: async () => '{"error":{"message":"nope"}}' }),
      () => askWhy(КЛЮЧ_ДЛЯ_ТЕСТА, VOCAB)
    )
    assert(итог instanceof CoachError, `ответ ${status} не превратился в CoachError`)
    const e = итог as CoachError
    assert(e.status === status, `CoachError потерял код: ${e.status} вместо ${status}`)
    assert(e.message.includes(слово), `сообщение об отказе ${status} не объясняет причину: «${e.message}»`)
  }

  const [сеть] = await withFetch(() => new TypeError('Failed to fetch'), () => askWhy(КЛЮЧ_ДЛЯ_ТЕСТА, VOCAB))
  assert(сеть instanceof CoachError && сеть.message.includes('сет'), 'обрыв сети не превратился в понятное сообщение')

  const [впотоке] = await withFetch(
    () => ({ ok: true, status: 200, body: stream(sse([{ type: 'error', error: { message: 'overloaded' } }]), 16) }),
    () => askWhy(КЛЮЧ_ДЛЯ_ТЕСТА, VOCAB)
  )
  assert(впотоке instanceof CoachError, 'ошибка, пришедшая внутри потока, проглочена и выдана за разбор')
  group('W8: каждый отказ доходит до ученика причиной, а не кодом')
}

// ── W9: ключ не уходит никуда, кроме заголовка --------------------------------
async function keyStaysInHeader(): Promise<void> {
  const [итог, запросы] = await withFetch(
    () => ({ ok: true, status: 200, body: stream(textEvents(['ок']), 32) }),
    () => askWhy(КЛЮЧ_ДЛЯ_ТЕСТА, VOCAB)
  )
  assert(!(итог instanceof Error), `обычный запрос упал: ${итог}`)
  assert(запросы.length === 1, `вместо одного запроса ушло ${запросы.length}`)
  const { url, init } = запросы[0]
  const заголовки = init.headers as Record<string, string>
  assert(!url.includes(КЛЮЧ_ДЛЯ_ТЕСТА), 'ключ уехал в URL — он попадёт в логи и историю')
  assert(!String(init.body).includes(КЛЮЧ_ДЛЯ_ТЕСТА), 'ключ уехал в тело запроса')
  assert(заголовки['x-api-key'] === КЛЮЧ_ДЛЯ_ТЕСТА, 'ключ не отправлен заголовком x-api-key')
  assert(заголовки['anthropic-version'] === '2023-06-01', 'не указана версия API')
  assert(заголовки['anthropic-dangerous-direct-browser-access'] === 'true',
    'нет заголовка прямого браузерного доступа — запрос отобьётся CORS')
  const посылка = JSON.parse(String(init.body))
  assert(посылка.model === COACH_MODEL, 'запрос ушёл не той моделью')
  assert(посылка.stream === true, 'поток выключен — ученик ждёт весь ответ молча')
  assert(посылка.max_tokens > 0, 'не задан потолок ответа')
  assert(посылка.messages[0].content.includes(VOCAB.sentence), 'в тело запроса не попало предложение')
  group('W9: ключ уходит только заголовком, посылка — та, что задумана')
}

// ── W10: без ключа сеть не трогается ------------------------------------------
async function noKeyNoRequest(): Promise<void> {
  const [итог, запросы] = await withFetch(
    () => { throw new Error('запрос не должен был случиться') },
    () => askWhy('', VOCAB)
  )
  assert(итог instanceof CoachError, 'пустой ключ не дал понятной ошибки')
  assert((итог as CoachError).message.includes('настройк'), 'ошибка не подсказывает, где взять ключ')
  assert(запросы.length === 0, 'без ключа всё равно ушёл запрос в сеть')
  group('W10: без ключа кнопка объясняет, чего не хватает, и не ходит в сеть')
}

async function main(): Promise<void> {
  console.log('SRS «Почему?» — сборка запроса, ключ кэша, поток и отказы')
  promptCarriesTheCase()
  promptWithoutPick()
  promptByKind()
  promptNoEmptyLines()
  cacheKeys()
  await streamAssembly()
  await noBodyFallback()
  await failures()
  await keyStaysInHeader()
  await noKeyNoRequest()
  console.log(`\nВсе проверки разбора пройдены (${passed} групп).`)
}

main().catch(e => {
  console.error('\n✗ ТЕСТ РАЗБОРА УПАЛ:\n' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
})

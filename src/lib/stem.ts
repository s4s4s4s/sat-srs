/**
 * Основа слова - один консервативный стеммер на всё приложение (J2, 06.09.2026).
 *
 * До этой правки существовало два независимых стеммера с разными правилами -
 * `corpusStem` (`corpus.ts`, через `lemmaCandidates` из `reading.ts`) и `stemEn`
 * (`journal.ts`, урезанный алгоритм Портера). Расхождение между ними било по
 * добавлению карточек ровно противоположно тому, что чинил F41: Портер снимал
 * деривационные суффиксы `-ive`/`-ion`, и `relative` сводился к той же основе,
 * что `relate` (`relat`) - настоящий кандидат на новую карточку («relative» ещё
 * не введено) молча пропадал из списка добавления, потому что deckHasWord видел
 * в колоде «relate» и считал слово уже знакомым.
 *
 * `lightStem` снимает только словоизменение, которое не меняет значение слова:
 * притяжательное 's, множественное число (-s/-es, кроме слов на -ss/-us/-is -
 * class/campus/basis не суффикс, а часть корня), глагольные -ed/-ing и наречное
 * -ly. Деривационных суффиксов Портера (-ive, -ate, -ion и дальше) здесь нет:
 * они меняют часть речи и иногда смысл, и снимать их - решать за словарь, а не
 * лемматизировать форму. `relative` и `relate` поэтому обязаны остаться разными
 * основами - это ядро контракта, а не побочный эффект.
 *
 * Восстановление удвоенной согласной и конечной e после -ed/-ing работает только
 * там, где выбор однозначен: `stopped` -> `stopp` (удвоение) -> `stop`; `making`
 * -> `mak` -> `make` (согласная-гласная-согласная, последняя не w/x/y, значит
 * восстановление не создаёт двусмысленности). Слова, заканчивающиеся на буквенное
 * сочетание, которое само по себе не берёт немую e (`-ck`/`-ng`/`-sh`/`-ch`:
 * `watching` -> `watch`, не `watche`), оставлены как есть.
 */

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u'])
const isVowel = (c: string): boolean => VOWELS.has(c)
const containsVowel = (s: string): boolean => {
  for (const c of s) if (isVowel(c)) return true
  return false
}

/** Последние два символа совпадают и не гласная - удвоенная согласная (stopp, runn). */
function isDoubledConsonant(s: string): boolean {
  const n = s.length
  if (n < 2) return false
  const a = s[n - 1]
  const b = s[n - 2]
  return a === b && !isVowel(a)
}

/** Буквосочетания, которые сами по себе не берут немую e (watch, wash, sing, pack). */
const NO_SILENT_E_TAIL = ['ck', 'ng', 'sh', 'ch']

/** После снятия -ed/-ing решает: вернуть удвоенную согласную или восстановить немую e. */
function restoreAfterStrip(stem: string): string {
  if (isDoubledConsonant(stem)) return stem.slice(0, -1)
  const last = stem[stem.length - 1]
  if (!last || isVowel(last) || last === 'y') return stem
  if (NO_SILENT_E_TAIL.some(tail => stem.endsWith(tail))) return stem
  return stem + 'e'
}

/** Основа слова для сравнения форм - см. комментарий модуля. */
export function lightStem(word: string): string {
  let w = word.toLowerCase().trim().replace(/^[^a-z]+|[^a-z]+$/g, '')
  if (!w) return w
  w = w.replace(/['’]s$/, '') // притяжательное: treaty's -> treaty
  if (w.length < 3) return w

  if (w.endsWith('ing')) {
    const stem = w.slice(0, -3)
    if (stem.length >= 2 && containsVowel(stem)) return restoreAfterStrip(stem)
    return w
  }
  if (w.endsWith('ed')) {
    const stem = w.slice(0, -2)
    if (stem.length >= 2 && containsVowel(stem)) return restoreAfterStrip(stem)
    return w
  }
  // buses -> bus, watches -> watch, wishes -> wish, boxes -> box, prizes -> priz(e)
  if (/(?:[sxz]es|ches|shes)$/.test(w) && w.length > 4) return w.slice(0, -2)
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1)
  if (w.endsWith('ly')) {
    const stem = w.slice(0, -2)
    if (stem.length >= 2 && containsVowel(stem)) return stem
  }
  return w
}

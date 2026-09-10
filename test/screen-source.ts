/**
 * Чтение исходника экрана для структурных проверок.
 *
 * Границы отметки/отбора — свойство экрана, а не слоя данных, но React и DOM в node нет,
 * поэтому такие проверки читают исходник экрана текстом и ищут в нём нужное — это ловит
 * возврат старого кода, но не заменяет живой прогон в браузере.
 *
 * Вынесено из `reading.test.ts`, где жила единственная копия: следующим наборам
 * (`wordlist.test.ts` и далее) эта функция тоже нужна, а две расходящиеся копии
 * с разным сообщением об ошибке хуже одной общей.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export function screenSource(file: string): string {
  const p = path.join(process.cwd(), 'src', 'screens', file)
  if (!existsSync(p)) throw new Error(`не найден исходник экрана ${p} — тест запускают из корня пакета`)
  return readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
}

/**
 * Аргументы первого вызова `name(...)` в куске исходника, разрезанные по запятым ВЕРХНЕГО
 * уровня (вложенные скобки, литералы объектов и массивов остаются целыми). `null` - вызова нет.
 *
 * Нужна там, где проверяется не факт вызова, а ПОРЯДОК аргументов: регулярка вида
 * `name\([^)]*x` отвечает лишь «x где-то внутри» и молча зеленеет, если аргумент переехал
 * на чужое место или вызов уехал за окно поиска. Полноценный парсер TypeScript здесь не
 * нужен: структурные проверки читают собственный исходник проекта, а не произвольный код.
 */
export function callArgs(src: string, name: string): string[] | null {
  const at = src.indexOf(`${name}(`)
  if (at < 0) return null
  const args: string[] = []
  let depth = 0
  let start = at + name.length + 1
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' && depth === 0) { args.push(src.slice(start, i).trim()); return args }
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) { args.push(src.slice(start, i).trim()); start = i + 1 }
  }
  throw new Error(`не закрыт список аргументов вызова ${name} - исходник обрезан по границе окна`)
}

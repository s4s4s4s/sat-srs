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

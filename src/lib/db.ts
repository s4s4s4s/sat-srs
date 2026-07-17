import { openDB, type IDBPDatabase } from 'idb'
import type { CardRec, JournalRec } from './types'

let dbp: Promise<IDBPDatabase> | null = null

function db() {
  if (!dbp) {
    dbp = openDB('sat-srs', 1, {
      upgrade(d) {
        d.createObjectStore('cards', { keyPath: 'path' })
        const j = d.createObjectStore('journal', { keyPath: 'id' })
        j.createIndex('by_day', 'day')
        d.createObjectStore('kv')
      }
    })
  }
  return dbp
}

export async function getAllCards(): Promise<CardRec[]> {
  return (await db()).getAll('cards')
}

export async function putCard(c: CardRec): Promise<void> {
  await (await db()).put('cards', c)
}

export async function putCards(cs: CardRec[]): Promise<void> {
  const tx = (await db()).transaction('cards', 'readwrite')
  await Promise.all(cs.map(c => tx.store.put(c)))
  await tx.done
}

export async function deleteCard(path: string): Promise<void> {
  await (await db()).delete('cards', path)
}

export async function getAllJournal(): Promise<JournalRec[]> {
  return (await db()).getAll('journal')
}

export async function putJournal(lines: JournalRec[]): Promise<void> {
  if (!lines.length) return
  const tx = (await db()).transaction('journal', 'readwrite')
  await Promise.all(lines.map(l => tx.store.put(l)))
  await tx.done
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await db()).get('kv', key)
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await (await db()).put('kv', value, key)
}

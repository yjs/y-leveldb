
import * as Y from 'yjs'
import { PREFERRED_TRIM_SIZE, LevelDbPersistence, getLevelUpdates } from '../src/y-leveldb.js'
import * as t from 'lib0/testing.js'
// @ts-ignore
import level from 'level-mem'
import * as decoding from 'lib0/decoding.js'

/**
 * Read state vector from Decoder and return as Map. This is a helper method that will be exported by Yjs directly.
 *
 * @param {decoding.Decoder} decoder
 * @return {Map<number,number>} Maps `client` to the number next expected `clock` from that client.
 *
 * @function
 */
const readStateVector = decoder => {
  const ss = new Map()
  const ssLength = decoding.readVarUint(decoder)
  for (let i = 0; i < ssLength; i++) {
    const client = decoding.readVarUint(decoder)
    const clock = decoding.readVarUint(decoder)
    ss.set(client, clock)
  }
  return ss
}

/**
 * Read decodedState and return State as Map.
 *
 * @param {Uint8Array} decodedState
 * @return {Map<number,number>} Maps `client` to the number next expected `clock` from that client.
 *
 * @function
 */
const decodeStateVector = decodedState => readStateVector(decoding.createDecoder(decodedState))

/**
 * Flushes all updates to ldb and delets items from updates array.
 *
 * @param {LevelDbPersistence} ldb
 * @param {string} docName
 * @param {Array<Uint8Array>} updates
 */
const flushUpdatesHelper = (ldb, docName, updates) =>
  Promise.all(updates.splice(0).map(update => ldb.storeUpdate(docName, update)))

/**
 * @param {t.TestCase} tc
 */
export const testLeveldbBUpdateStorage = async tc => {
  const docName = 'my level doc'
  const ydoc1 = new Y.Doc()
  ydoc1.clientID = 0 // so we can check the state vector
  const leveldbPersistence = new LevelDbPersistence('tmp-storage', { level })
  const updates = []

  ydoc1.on('update', update => {
    updates.push(update)
  })

  ydoc1.getArray('').insert(0, [1])
  ydoc1.getArray('').insert(0, [2])

  await flushUpdatesHelper(leveldbPersistence, docName, updates)

  const sv = decodeStateVector(await leveldbPersistence.getStateVector(docName))
  t.assert(sv.size === 1)
  t.assert(sv.get(0) === 2)

  const ydoc2 = await leveldbPersistence.getYDoc(docName)
  t.compareArrays(ydoc2.getArray('').toArray(), [1, 2])
}

// /**
//  * @param {t.TestCase} tc
//  */
// export const testEncodeMillionUpdates = async tc => {
//   const million = 1000000
//   const docName = 'my level doc'
//   const ydoc1 = new Y.Doc()
//   ydoc1.clientID = 0 // so we can check the state vector
//   const leveldbPersistence = new LevelDbPersistence('tmp-storage', { level })

//   const updates = []

//   ydoc1.on('update', update => {
//     updates.push(update)
//   })
//   await flushUpdatesHelper(leveldbPersistence, docName, updates)

//   const keys = await getLevelUpdates(leveldbPersistence.db, docName, { keys: true, values: false })

//   for (let i = 0; i < keys.length; i++) {
//     t.assert(keys[i][3] === i)
//   }

//   const yarray = ydoc1.getArray('')
//   for (let i = 0; i < million; i++) {
//     yarray.insert(0, [i])
//   }
//   await flushUpdatesHelper(leveldbPersistence, docName, updates)

//   const ydoc2 = await leveldbPersistence.getYDoc(docName)
//   t.assert(ydoc2.getArray('').length === million)

//   await leveldbPersistence.flushDocument(docName)
//   const mergedKeys = await getLevelUpdates(leveldbPersistence.db, docName, { keys: true, values: false })
//   t.assert(mergedKeys.length === 1)

//   // getYDoc still works after flush/merge
//   const ydoc3 = await leveldbPersistence.getYDoc(docName)
//   t.assert(ydoc3.getArray('').length === million)
// }

// /**
//  * @param {t.TestCase} tc
//  */
// export const testDiff = async tc => {
//   const N = PREFERRED_TRIM_SIZE * 7 // primes are awesome - ensure that the document is at least flushed once
//   const docName = 'my level doc'
//   const ydoc1 = new Y.Doc()
//   ydoc1.clientID = 0 // so we can check the state vector
//   const leveldbPersistence = new LevelDbPersistence('tmp-storage', { level })

//   const updates = []
//   ydoc1.on('update', update => {
//     updates.push(update)
//   })

//   const yarray = ydoc1.getArray('')
//   // create N changes
//   for (let i = 0; i < N; i++) {
//     yarray.insert(0, [i])
//   }
//   await flushUpdatesHelper(leveldbPersistence, docName, updates)

//   // create partially merged doc
//   const ydoc2 = await leveldbPersistence.getYDoc(docName)

//   // another N updates
//   for (let i = 0; i < N; i++) {
//     yarray.insert(0, [i])
//   }
//   await flushUpdatesHelper(leveldbPersistence, docName, updates)

//   // apply diff to doc
//   const diffUpdate = await leveldbPersistence.getDiff(docName, Y.encodeStateVector(ydoc2))
//   Y.applyUpdate(ydoc2, diffUpdate)

//   t.assert(ydoc2.getArray('').length === ydoc1.getArray('').length)
//   t.assert(ydoc2.getArray('').length === N * 2)
// }

// /**
//  * @param {t.TestCase} tc
//  */
// export const testMetas = async tc => {
//   const leveldbPersistence = new LevelDbPersistence('tmp-storage', { level })
//   await leveldbPersistence.setMeta('test', 'a', 4)
//   await leveldbPersistence.setMeta('test', 'a', 5)
//   await leveldbPersistence.setMeta('test', 'b', 4)
//   const a = await leveldbPersistence.getMeta('test', 'a')
//   const b = await leveldbPersistence.getMeta('test', 'b')
//   t.assert(a === 5)
//   t.assert(b === 4)
//   const metas = await leveldbPersistence.getMetas('test')
//   t.assert(metas.size === 2)
//   t.assert(metas.get('a') === 5)
//   t.assert(metas.get('b') === 4)
//   await leveldbPersistence.clearDocument('test')
//   const metasEmpty = await leveldbPersistence.getMetas('test')
//   t.assert(metasEmpty.size === 2)
// }

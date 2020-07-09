
import * as Y from 'yjs'
import { PREFERRED_TRIM_SIZE, LeveldbPersistence, getLevelUpdates, getLevelBulkData } from '../src/y-leveldb.js'
import * as t from 'lib0/testing.js'
import * as decoding from 'lib0/decoding.js'

// When changing this, also make sure to change the file in gitignore
const storageName = 'tmp-leveldb-storage'

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
 * @param {LeveldbPersistence} ldb
 * @param {string} docName
 * @param {Array<Uint8Array>} updates
 */
const flushUpdatesHelper = (ldb, docName, updates) =>
  Promise.all(updates.splice(0).map(update => ldb.storeUpdate(docName, update)))

/**
 * @param {t.TestCase} tc
 */
export const testLeveldbUpdateStorage = async tc => {
  const docName = tc.testName
  const ydoc1 = new Y.Doc()
  ydoc1.clientID = 0 // so we can check the state vector
  const leveldbPersistence = new LeveldbPersistence(storageName)
  // clear all data, so we can check allData later
  await leveldbPersistence._transact(async db => db.clear())
  t.compareArrays([], await leveldbPersistence.getAllDocNames())

  const updates = []

  ydoc1.on('update', update => {
    updates.push(update)
  })

  ydoc1.getArray('arr').insert(0, [1])
  ydoc1.getArray('arr').insert(0, [2])

  await flushUpdatesHelper(leveldbPersistence, docName, updates)

  const encodedSv = await leveldbPersistence.getStateVector(docName)
  const sv = decodeStateVector(encodedSv)
  t.assert(sv.size === 1)
  t.assert(sv.get(0) === 2)

  const ydoc2 = await leveldbPersistence.getYDoc(docName)
  t.compareArrays(ydoc2.getArray('arr').toArray(), [2, 1])

  const allData = await leveldbPersistence._transact(async db => getLevelBulkData(db, { gte: ['v1'], lt: ['v2'] }))
  t.assert(allData.length > 0, 'some data exists')

  t.compareArrays([docName], await leveldbPersistence.getAllDocNames())
  await leveldbPersistence.clearDocument(docName)
  t.compareArrays([], await leveldbPersistence.getAllDocNames())
  const allData2 = await leveldbPersistence._transact(async db => getLevelBulkData(db, { gte: ['v1'], lt: ['v2'] }))
  console.log(allData2)
  t.assert(allData2.length === 0, 'really deleted all data')

  await leveldbPersistence.destroy()
}

/**
 * @param {t.TestCase} tc
 */
export const testEncodeManyUpdates = async tc => {
  const N = PREFERRED_TRIM_SIZE * 7
  const docName = tc.testName
  const ydoc1 = new Y.Doc()
  ydoc1.clientID = 0 // so we can check the state vector
  const leveldbPersistence = new LeveldbPersistence(storageName)
  await leveldbPersistence.clearDocument(docName)

  const updates = []

  ydoc1.on('update', update => {
    updates.push(update)
  })
  await flushUpdatesHelper(leveldbPersistence, docName, updates)

  const keys = await leveldbPersistence._transact(db => getLevelUpdates(db, docName, { keys: true, values: false }))

  for (let i = 0; i < keys.length; i++) {
    t.assert(keys[i][3] === i)
  }

  const yarray = ydoc1.getArray('arr')
  for (let i = 0; i < N; i++) {
    yarray.insert(0, [i])
  }
  await flushUpdatesHelper(leveldbPersistence, docName, updates)

  const ydoc2 = await leveldbPersistence.getYDoc(docName)
  t.assert(ydoc2.getArray('arr').length === N)

  await leveldbPersistence.flushDocument(docName)
  const mergedKeys = await leveldbPersistence._transact(db => getLevelUpdates(db, docName, { keys: true, values: false }))
  t.assert(mergedKeys.length === 1)

  // getYDoc still works after flush/merge
  const ydoc3 = await leveldbPersistence.getYDoc(docName)
  t.assert(ydoc3.getArray('arr').length === N)

  // test if state vector is properly generated
  t.compare(Y.encodeStateVector(ydoc1), await leveldbPersistence.getStateVector(docName))
  // add new update so that sv needs to be updated
  ydoc1.getArray('arr').insert(0, ['new'])
  await flushUpdatesHelper(leveldbPersistence, docName, updates)
  t.compare(Y.encodeStateVector(ydoc1), await leveldbPersistence.getStateVector(docName))

  await leveldbPersistence.destroy()
}

/**
 * @param {t.TestCase} tc
 */
export const testDiff = async tc => {
  const N = PREFERRED_TRIM_SIZE * 2 // primes are awesome - ensure that the document is at least flushed once
  const docName = tc.testName
  const ydoc1 = new Y.Doc()
  ydoc1.clientID = 0 // so we can check the state vector
  const leveldbPersistence = new LeveldbPersistence(storageName)
  await leveldbPersistence.clearDocument(docName)

  const updates = []
  ydoc1.on('update', update => {
    updates.push(update)
  })

  const yarray = ydoc1.getArray('arr')
  // create N changes
  for (let i = 0; i < N; i++) {
    yarray.insert(0, [i])
  }
  await flushUpdatesHelper(leveldbPersistence, docName, updates)

  // create partially merged doc
  const ydoc2 = await leveldbPersistence.getYDoc(docName)

  // another N updates
  for (let i = 0; i < N; i++) {
    yarray.insert(0, [i])
  }
  await flushUpdatesHelper(leveldbPersistence, docName, updates)

  // apply diff to doc
  const diffUpdate = await leveldbPersistence.getDiff(docName, Y.encodeStateVector(ydoc2))
  Y.applyUpdate(ydoc2, diffUpdate)

  t.assert(ydoc2.getArray('arr').length === ydoc1.getArray('arr').length)
  t.assert(ydoc2.getArray('arr').length === N * 2)

  await leveldbPersistence.destroy()
}

/**
 * @param {t.TestCase} tc
 */
export const testMetas = async tc => {
  const docName = tc.testName
  const leveldbPersistence = new LeveldbPersistence(storageName)
  await leveldbPersistence.clearDocument(docName)

  await leveldbPersistence.setMeta(docName, 'a', 4)
  await leveldbPersistence.setMeta(docName, 'a', 5)
  await leveldbPersistence.setMeta(docName, 'b', 4)
  const a = await leveldbPersistence.getMeta(docName, 'a')
  const b = await leveldbPersistence.getMeta(docName, 'b')
  t.assert(a === 5)
  t.assert(b === 4)
  const metas = await leveldbPersistence.getMetas(docName)
  t.assert(metas.size === 2)
  t.assert(metas.get('a') === 5)
  t.assert(metas.get('b') === 4)
  await leveldbPersistence.delMeta(docName, 'a')
  const c = await leveldbPersistence.getMeta(docName, 'a')
  t.assert(c === undefined)
  await leveldbPersistence.clearDocument(docName)
  const metasEmpty = await leveldbPersistence.getMetas(docName)
  t.assert(metasEmpty.size === 0)

  await leveldbPersistence.destroy()
}

/**
 * @param {t.TestCase} tc
 */
export const testDeleteEmptySv = async tc => {
  const docName = tc.testName
  const leveldbPersistence = new LeveldbPersistence(storageName)
  await leveldbPersistence.clearAll()

  const ydoc = new Y.Doc()
  ydoc.clientID = 0
  ydoc.getArray('arr').insert(0, [1])
  const singleUpdate = Y.encodeStateAsUpdate(ydoc)

  t.compareArrays([], await leveldbPersistence.getAllDocNames())
  await leveldbPersistence.storeUpdate(docName, singleUpdate)
  t.compareArrays([docName], await leveldbPersistence.getAllDocNames())
  const docSvs = await leveldbPersistence.getAllDocStateVecors()
  t.assert(docSvs.length === 1)
  t.compare([{ name: docName, clock: 0, sv: Y.encodeStateVector(ydoc) }], docSvs)

  await leveldbPersistence.clearDocument(docName)
  t.compareArrays([], await leveldbPersistence.getAllDocNames())
  await leveldbPersistence.destroy()
}

export const testMisc = async tc => {
  const docName = tc.testName
  const leveldbPersistence = new LeveldbPersistence(storageName)
  await leveldbPersistence.clearDocument(docName)

  const sv = await leveldbPersistence.getStateVector('does not exist')
  t.assert(sv.byteLength === 1)

  await leveldbPersistence.destroy()
}

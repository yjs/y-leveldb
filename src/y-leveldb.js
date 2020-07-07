import * as Y from 'yjs'
import * as encoding from 'lib0/encoding.js'
import * as decoding from 'lib0/decoding.js'
import * as binary from 'lib0/binary.js'
import * as promise from 'lib0/promise.js'
import * as buffer from 'lib0/buffer.js'
// @ts-ignore
import defaultLevel from 'level'

export const PREFERRED_TRIM_SIZE = 500

const YEncodingString = 0
const YEncodingUint32 = 1

const valueEncoding = {
  buffer: true,
  type: 'y-value',
  encode: /** @param {any} data */ data => data,
  decode: /** @param {any} data */ data => data
}

const keyEncoding = {
  buffer: true,
  type: 'y-keys',
  encode: /** @param {Array<string|number>} arr */  arr => {
    const encoder = encoding.createEncoder()
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i]
      if (typeof v === 'string') {
        encoding.writeUint8(encoder, YEncodingString)
        encoding.writeVarString(encoder, v)
      } else if (typeof v === 'number') {
        encoding.writeUint8(encoder, YEncodingUint32)
        encoding.writeUint32(encoder, v)
      } else {
        throw new Error('Unexpected key value')
      }
    }
    return Buffer.from(encoding.toUint8Array(encoder))
  },
  decode: /** @param {Uint8Array} buf */ buf => {
    const decoder = decoding.createDecoder(buf)
    const key = []
    while (decoding.hasContent(decoder)) {
      switch (decoding.readUint8(decoder)) {
        case YEncodingString:
          key.push(decoding.readVarString(decoder))
          break
        case YEncodingUint32:
          key.push(decoding.readUint32(decoder))
          break
      }
    }
    return key
  }
}

/**
 * level returns an error if a value is not found.
 *
 * This helper method for level returns `null` instead if the key is not found.
 *
 * @param {any} db
 * @param {any} key
 */
const levelGet = async (db, key) => {
  try {
    return await db.get(key)
  } catch (err) {
    if (err.notFound) {
      return null
    }
  }
}

/**
 * Level expects a Buffer, but in Yjs we typically work with Uint8Arrays.
 *
 * Since Level thinks that these are two entirely different things,
 * we transform the Uint8array to a Buffer before storing it.
 *
 * @param {any} db
 * @param {any} key
 * @param {Uint8Array} val
 */
const levelPut = async (db, key, val) => db.put(key, Buffer.from(val))

/**
 * A "bulkier" implementation of level streams. Returns the result in one flush.
 *
 * @param {any} db
 * @param {object} opts
 * @return {Promise<Array<any>>}
 */
export const getLevelBulkData = (db, opts) => promise.create((resolve, reject) => {
  /**
   * @type {Array<any>} result
   */
  const result = []
  db.createReadStream(
    opts
  ).on('data', /** @param {any} data */ data =>
    result.push(data)
  ).on('end', () =>
    resolve(result)
  ).on('error', reject)
})

/**
 * Get all document updates for a specific document.
 *
 * @param {any} db
 * @param {string} docName
 * @param {any} [opts]
 * @return {Promise<Array<Buffer>>}
 */
export const getLevelUpdates = (db, docName, opts = { values: true, keys: false }) => getLevelBulkData(db, {
  gte: createDocumentUpdateKey(docName, 0),
  lt: createDocumentUpdateKey(docName, binary.BITS32),
  ...opts
})

/**
 * @param {any} db
 * @param {string} docName
 * @return {Promise<number>} Returns -1 if this document doesn't exist yet
 */
export const getCurrentUpdateClock = (db, docName) => getLevelUpdates(db, docName, { keys: true, values: false, reverse: true, limit: 1 }).then(keys => {
  if (keys.length === 0) {
    return -1
  } else {
    return keys[0][3]
  }
})

/**
 * @param {any} db
 * @param {Array<string|number>} gte Greater than or equal
 * @param {Array<string|number>} lt lower than (not equal)
 * @return {Promise<void>}
 */
const clearRange = async (db, gte, lt) => {
  if (db.supports.clear) {
    await db.clear({ gte, lt })
  } else {
    const keys = await getLevelBulkData(db, { values: false, keys: true, gte, lt })
    const ops = keys.map(key => ({ type: 'del', key }))
    await db.batch(ops)
  }
}

/**
 * @param {any} db
 * @param {string} docName
 * @param {number} from Greater than or equal
 * @param {number} to lower than (not equal)
 * @return {Promise<void>}
 */
const clearUpdatesRange = async (db, docName, from, to) => clearRange(db, createDocumentUpdateKey(docName, from), createDocumentUpdateKey(docName, to))

/**
 * Create a unique key for a update message.
 * We encode the result using `keyEncoding` which expects an array.
 *
 * @param {string} docName
 * @param {number} clock must be unique
 * @return {Array<string|number>}
 */
const createDocumentUpdateKey = (docName, clock) => ['v1', docName, 'update', clock]

/**
 * @param {string} docName
 * @param {string} metaKey
 */
const createDocumentMetaKey = (docName, metaKey) => ['v1', docName, 'meta', metaKey]

/**
 * @param {string} docName
 */
const createDocumentMetaEndKey = (docName) => ['v1', docName, 'metb'] // simple trick

/**
 * @param {string} docName
 */
const createDocumentStateVectorKey = (docName) => ['v1', docName, 'sv']

/**
 * @param {string} docName
 */
const createDocumentFirstKey = (docName) => ['v1', docName] // we assume that this is the last key written for a document

/**
 * @param {string} docName
 */
const createDocumentLastKey = (docName) => ['v1', docName, 'zzz'] // we assume that this is the last key written for a document

// const emptyStateVector = (() => Y.encodeStateVector(new Y.Doc()))()

/**
 * For now this is a helper method that creates a Y.Doc and then re-encodes a document update.
 * In the future this will be handled by Yjs without creating a Y.Doc (constant memory consumption).
 *
 * @param {Array<Uint8Array>} updates
 * @return {{update:Uint8Array, sv: Uint8Array}}
 */
const mergeUpdates = (updates) => {
  const ydoc = new Y.Doc()
  ydoc.transact(() => {
    for (let i = 0; i < updates.length; i++) {
      Y.applyUpdate(ydoc, updates[i])
    }
  })
  return { update: Y.encodeStateAsUpdate(ydoc), sv: Y.encodeStateVector(ydoc) }
}

/**
 * @param {any} db
 * @param {string} docName
 * @param {Uint8Array} sv state vector
 * @param {number} clock current clock of the document so we can determine when this statevector was created
 */
const writeStateVector = async (db, docName, sv, clock) => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, clock)
  encoding.writeVarUint8Array(encoder, sv)
  await levelPut(db, createDocumentStateVectorKey(docName), encoding.toUint8Array(encoder))
}

/**
 * @param {any} db
 * @param {string} docName
 */
const readStateVector = async (db, docName) => {
  const buf = await levelGet(db, createDocumentStateVectorKey(docName))
  if (buf === null) {
    // no state vector created yet or no document exists
    return { sv: null, clock: -1 }
  }
  const decoder = decoding.createDecoder(buf)
  const clock = decoding.readVarUint(decoder)
  const sv = decoding.readVarUint8Array(decoder)
  return { sv, clock }
}

/**
 * @param {any} db
 * @param {string} docName
 * @param {Uint8Array} stateAsUpdate
 * @param {Uint8Array} stateVector
 * @return {Promise<{clock:number, sv: Uint8Array}>}
 */
const flushDocument = async (db, docName, stateAsUpdate, stateVector) => {
  const clock = await storeUpdate(db, docName, stateAsUpdate)
  writeStateVector(db, docName, stateVector, clock)
  clearUpdatesRange(db, docName, 0, clock) // intentionally not waiting for the promise to resolve!
  return { clock, sv: stateVector }
}

/**
 * @param {any} db
 * @param {string} docName
 * @param {Uint8Array} update
 * @return {Promise<number>} Returns the clock of the stored update
 */
const storeUpdate = async (db, docName, update) => {
  const clock = await getCurrentUpdateClock(db, docName)
  await levelPut(db, createDocumentUpdateKey(docName, clock + 1), update)
  return clock + 1
}

export class LevelDbPersistence {
  /**
   * @param {string} location
   * @param {object} [opts]
   * @param {any} [opts.level] Level-compatible adapter. E.g. leveldown, level-rem, level-indexeddb. Defaults to `level`
   * @param {object} [opts.levelOptions] Options that are passed down to the level instance
   */
  constructor (location, { level = defaultLevel, levelOptions = {} } = {}) {
    const db = level(location, { ...levelOptions, valueEncoding, keyEncoding })
    this.tr = promise.resolve()
    /**
     * Execute an transaction on a database. This will ensure that other processes are currently not writing.
     *
     * @template T
     *
     * @param {function(any):Promise<T>} f A transaction that receives the db object
     * @return {Promise<T>}
     */
    this.transact = f => {
      const ret = this.tr.then(() => f(db))
      this.tr = promise.create(resolve => ret.then(resolve, resolve))
      return this.tr
    }
  }

  /**
   * @param {string} docName
   */
  flushDocument (docName) {
    return this.transact(async db => {
      const updates = await getLevelUpdates(db, docName)
      const { update, sv } = mergeUpdates(updates)
      const fr = await flushDocument(db, docName, update, sv)
      return fr
    })
  }

  /**
   * @param {string} docName
   * @return {Promise<Y.Doc>}
   */
  getYDoc (docName) {
    return this.transact(async db => {
      const updates = await getLevelUpdates(db, docName)
      const ydoc = new Y.Doc()
      ydoc.transact(() => {
        for (let i = 0; i < updates.length; i++) {
          Y.applyUpdate(ydoc, updates[i])
        }
      })
      if (updates.length > PREFERRED_TRIM_SIZE) {
        await flushDocument(this, docName, Y.encodeStateAsUpdate(ydoc), Y.encodeStateVector(ydoc))
      }
      return ydoc
    })
  }

  /**
   * @param {string} docName
   * @return {Promise<Uint8Array>}
   */
  getStateVector (docName) {
    return this.transact(async db => {
      const { clock, sv } = await readStateVector(db, docName)
      if (sv !== null && clock === await getCurrentUpdateClock(db, docName)) {
        return sv
      } else {
        // current state vector is outdated
        const { sv } = await this.flushDocument(docName)
        return sv
      }
    })
  }

  /**
   * @param {string} docName
   * @param {Uint8Array} update
   * @return {Promise<number>} Returns the clock of the stored update
   */
  storeUpdate (docName, update) {
    return this.transact(db => storeUpdate(db, docName, update))
  }

  /**
   * @param {string} docName
   * @param {Uint8Array} stateVector
   */
  getDiff (docName, stateVector) {
    return this.transact(async db => {
      const ydoc = await this.getYDoc(docName)
      const update = Y.encodeStateAsUpdate(ydoc, stateVector)
      return update
    })
  }

  /**
   * @param {string} docName
   * @return {Promise<void>}
   */
  clearDocument (docName) {
    return this.transact(db => clearRange(db, createDocumentFirstKey(docName), createDocumentLastKey(docName)))
  }

  /**
   * @param {string} docName
   * @param {string} metaKey
   * @param {any} value
   * @return {Promise<void>}
   */
  setMeta (docName, metaKey, value) {
    return this.transact(db => levelPut(db, createDocumentMetaKey(docName, metaKey), buffer.encodeAny(value)))
  }

  /**
   * @param {string} docName
   * @param {string} metaKey
   * @return {Promise<any>}
   */
  delMeta (docName, metaKey) {
    return this.transact(db => db.del(createDocumentMetaKey(docName, metaKey)))
  }

  /**
   * @param {string} docName
   * @param {string} metaKey
   * @return {Promise<any>}
   */
  getMeta (docName, metaKey) {
    return this.transact(async db => {
      const res = await levelGet(db, createDocumentMetaKey(docName, metaKey))
      if (res === null) {
        return// return void
      }
      return buffer.decodeAny(res)
    })
  }

  /**
   * @param {string} docName
   * @return {Promise<Map<string, any>>}
   */
  getMetas (docName) {
    return this.transact(async db => {
      const data = await getLevelBulkData(db, {
        gte: createDocumentMetaKey(docName, ''),
        lt: createDocumentMetaEndKey(docName),
        keys: true,
        values: true
      })
      const metas = new Map()
      data.forEach(v => { metas.set(v.key, v.value) })
      return metas
    })
  }

  /**
   * Close connection to a leveldb database and discard all state and bindings
   *
   * @return {Promise<void>}
   */
  destroy () {
    return this.transact(db => db.close())
  }
}

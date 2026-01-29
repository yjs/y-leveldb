import * as Y from 'yjs'
import * as encoding from 'lib0/encoding.js'
import * as decoding from 'lib0/decoding.js'
import * as binary from 'lib0/binary.js'
import * as promise from 'lib0/promise.js'
import * as buffer from 'lib0/buffer.js'
import { Level as DefaultLevel } from 'level'
import { Buffer } from 'buffer'

/**
 * The threshold of updates before a document is automatically compacted/flushed.
 */
export const PREFERRED_TRIM_SIZE = 500

const YEncodingString = 0
const YEncodingUint32 = 1

/**
 * @typedef {import('abstract-level').AbstractLevel<any, Array<String|number>, Uint8Array>} AbstractLevel
 */
/**
 * Type definition for keys used in the LevelDB store.
 * @typedef {['v1', string, 'update', number] | ['v1', string, 'meta', string] | ['v1_sv', number]} DocKey
 */

/**
 * Configuration for value encoding in LevelDB.
 */
const valueEncoding = {
  buffer: true,
  type: 'y-value',
  encode: /** @param {any} data */ data => data,
  decode: /** @param {any} data */ data => data
}

/**
 * Write four bytes as an unsigned integer in big endian order.
 * (most significant byte first)
 *
 * @function
 * @param {encoding.Encoder} encoder
 * @param {number} num The number that is to be encoded.
 */
export const writeUint32BigEndian = (encoder, num) => {
  for (let i = 3; i >= 0; i--) {
    encoding.write(encoder, (num >>> (8 * i)) & binary.BITS8)
  }
}

/**
 * Read 4 bytes as unsigned integer in big endian order.
 * (most significant byte first)
 *
 * @function
 * @param {decoding.Decoder} decoder
 * @return {number} An unsigned integer.
 */
export const readUint32BigEndian = decoder => {
  const uint =
    (decoder.arr[decoder.pos + 3] +
    (decoder.arr[decoder.pos + 2] << 8) +
    (decoder.arr[decoder.pos + 1] << 16) +
    (decoder.arr[decoder.pos] << 24)) >>> 0
  decoder.pos += 4
  return uint
}

/**
 * Configuration for key encoding in LevelDB.
 * Handles the transformation of array-based keys into binary buffers.
 */
export const keyEncoding = {
  buffer: true,
  type: 'y-keys',
  /* istanbul ignore next */
  encode: /** @param {Array<string|number>} arr */  arr => {
    const encoder = encoding.createEncoder()
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i]
      if (typeof v === 'string') {
        encoding.writeUint8(encoder, YEncodingString)
        encoding.writeVarString(encoder, v)
      } else /* istanbul ignore else */ if (typeof v === 'number') {
        encoding.writeUint8(encoder, YEncodingUint32)
        writeUint32BigEndian(encoder, v)
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
          key.push(readUint32BigEndian(decoder))
          break
      }
    }
    return key
  }
}

/**
 * Safely retrieves a value from LevelDB. 
 * Returns `undefined` instead of throwing an error if the key is not found.
 *
 * @param {AbstractLevel} db
 * @param {any} key
 * @return {Promise<Uint8Array | undefined>}
 */
const levelGet = async (db, key) => {
  let res
  try {
    res = await db.get(key)
  } catch (err) {
    /* istanbul ignore else */
    if (/** @type {any} */ (err).notFound) {
      return
    } else {
      throw err
    }
  }
  return res
}

/**
 * Stores a value in LevelDB.
 * Transforms Uint8Array to Buffer to ensure compatibility with the database engine.
 *
 * @param {any} db
 * @param {any} key
 * @param {Uint8Array} val
 */
const levelPut = async (db, key, val) => db.put(key, Buffer.from(val))

/**
 * Retrieves a range of database entries (keys and values) as an array.
 * Uses modern Async Iterators to ensure the underlying C++ iterator is closed.
 *
 * @param {AbstractLevel} db
 * @param {import('abstract-level').AbstractIteratorOptions<any, Uint8Array>} opts
 * @return {Promise<Array<{ key: DocKey, value: Uint8Array }>>}
 */
export const getLevelBulkEntries = async (db, opts) => {
  const result = []
  for await (const [key, value] of db.iterator(opts)) {
    result.push({ key, value })
  }
  return result
}

/**
 * Retrieves a range of database keys as an array.
 * Uses modern Async Iterators to ensure memory is released instantly.
 *
 * @param {AbstractLevel} db
 * @param {import('abstract-level').AbstractIteratorOptions<any, Uint8Array>} opts
 * @return {Promise<Array<DocKey>>}
 */
export const getLevelBulkKeys = async (db, opts) => {
  const result = []
  for await (const key of db.keys(opts)) {
    result.push(key)
  }
  return result
}

/**
 * Retrieves a range of database values as an array.
 * Uses modern Async Iterators to prevent "External" memory growth.
 *
 * @param {AbstractLevel} db
 * @param {import('abstract-level').AbstractIteratorOptions<DocKey, Uint8Array>} opts
 * @return {Promise<Array<Uint8Array>>}
 */
export const getLevelBulkValues = async (db, opts) => {
  const result = []
  for await (const value of db.values(opts)) {
    result.push(value)
  }
  return result
}

/**
 * Retrieves all binary Yjs update values for a specific document.
 *
 * @param {any} db
 * @param {string} docName
 * @param {any} [opts]
 * @return {Promise<Array<Uint8Array>>}
 */
export const getLevelUpdates = (db, docName, opts = {}) => getLevelBulkValues(db, {
  gte: createDocumentUpdateKey(docName, 0),
  lt: createDocumentUpdateKey(docName, binary.BITS32),
  ...opts
})

/**
 * Retrieves all stored update entries (keys and values) for a specific document.
 *
 * @param {any} db
 * @param {string} docName
 * @param {any} [opts]
 * @return {Promise<Array<{key: DocKey, value: Uint8Array }>>}
 */
export const getLevelUpdatesEntries = (db, docName, opts = {}) => getLevelBulkEntries(db, {
  gte: createDocumentUpdateKey(docName, 0),
  lt: createDocumentUpdateKey(docName, binary.BITS32),
  ...opts
})

/**
 * Retrieves all binary update keys for a specific document.
 *
 * @param {any} db
 * @param {string} docName
 * @param {any} opts
 * @return {Promise<Array<DocKey>>}
 */
/* istanbul ignore next */
export const getLevelUpdatesKeys = (db, docName, opts = {}) => getLevelBulkKeys(db, {
  gte: createDocumentUpdateKey(docName, 0),
  lt: createDocumentUpdateKey(docName, binary.BITS32),
  ...opts
})

/**
 * Retrieves the state vector keys for all documents currently stored in the database.
 *
 * @param {AbstractLevel} db
 * @return {Promise<Array<DocKey>>}
 */
export const getAllDocsKeys = (db) => getLevelBulkKeys(db, {
  gte: ['v1_sv'],
  lt: ['v1_sw']
})

/**
 * Retrieves the state vector entries (keys and values) for all documents.
 *
 * @param {AbstractLevel} db
 * @return {Promise<Array<{ key: DocKey, value: Uint8Array }>>}
 */
export const getAllDocs = (db) => getLevelBulkEntries(db, {
  gte: ['v1_sv'],
  lt: ['v1_sw']
})

/**
 * Retrieves the highest update clock index currently stored for a document.
 *
 * @param {any} db
 * @param {string} docName
 * @return {Promise<number>} Returns -1 if the document has no updates.
 */
export const getCurrentUpdateClock = (db, docName) => getLevelUpdatesKeys(db, docName, { reverse: true, limit: 1 }).then(entries => {
  if (entries.length === 0) {
    return -1
  } else {
    return /** @type {number} */ (entries[0][3])
  }
})

/**
 * Deletes all keys within a specified range from the database.
 * Uses `db.clear` if supported for better performance.
 *
 * @param {any} db
 * @param {Array<string|number>} gte Greater than or equal (inclusive)
 * @param {Array<string|number>} lt lower than (exclusive)
 * @return {Promise<void>}
 */
const clearRange = async (db, gte, lt) => {
  /* istanbul ignore else */
  if (db.supports.clear) {
    await db.clear({ gte, lt })
  } else {
    const keys = await getLevelBulkKeys(db, { gte, lt })
    const ops = keys.map(key => ({ type: 'del', key }))
    await db.batch(ops)
  }
}

/**
 * Deletes a range of updates for a specific document based on their clock indices.
 *
 * @param {any} db
 * @param {string} docName
 * @param {number} from The starting clock index (inclusive)
 * @param {number} to The ending clock index (exclusive)
 * @return {Promise<void>}
 */
const clearUpdatesRange = async (db, docName, from, to) => clearRange(db, createDocumentUpdateKey(docName, from), createDocumentUpdateKey(docName, to))

/**
 * Generates a database key for a specific document update at a specific clock.
 *
 * @param {string} docName
 * @param {number} clock The unique sequence clock
 * @return {DocKey}
 */
const createDocumentUpdateKey = (docName, clock) => ['v1', docName, 'update', clock]

/**
 * Generates a database key for a specific metadata entry of a document.
 *
 * @param {string} docName
 * @param {string} metaKey
 * @return {DocKey}
 */
const createDocumentMetaKey = (docName, metaKey) => ['v1', docName, 'meta', metaKey]

/**
 * Generates an upper bound key for document metadata range queries.
 *
 * @param {string} docName
 * @return {DocKey}
 */
const createDocumentMetaEndKey = (docName) => ['v1', docName, 'metb']

/**
 * Generates a database key for a document's state vector.
 *
 * @param {string} docName
 * @return {DocKey}
 */
const createDocumentStateVectorKey = (docName) => ['v1_sv', docName]

/**
 * Generates the first possible key for a document's range in the store.
 *
 * @param {string} docName
 * @return {DocKey}
 */
const createDocumentFirstKey = (docName) => ['v1', docName]

/**
 * Generates the last possible key for a document's range in the store.
 * Used as an upper limit for cleanup operations.
 *
 * @param {string} docName
 * @return {DocKey}
 */
const createDocumentLastKey = (docName) => ['v1', docName, 'zzzzzzz']

/**
 * Merges a list of binary Yjs updates into a single update and computes the new state vector.
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
 * Writes the document's state vector and the current clock to the database.
 *
 * @param {any} db
 * @param {string} docName
 * @param {Uint8Array} sv The binary state vector
 * @param {number} clock The clock at which this state vector was captured
 */
const writeStateVector = async (db, docName, sv, clock) => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, clock)
  encoding.writeVarUint8Array(encoder, sv)
  await levelPut(db, createDocumentStateVectorKey(docName), encoding.toUint8Array(encoder))
}

/**
 * Decodes a stored state vector and its associated clock.
 *
 * @param {Uint8Array} buf
 * @return {{ sv: Uint8Array, clock: number }}
 */
const decodeLeveldbStateVector = buf => {
  const decoder = decoding.createDecoder(buf)
  const clock = decoding.readVarUint(decoder)
  const sv = decoding.readVarUint8Array(decoder)
  return { sv, clock }
}

/**
 * Retrieves and decodes the stored state vector for a document.
 *
 * @param {any} db
 * @param {string} docName
 * @return {Promise<{sv: Uint8Array | null, clock: number}>}
 */
const readStateVector = async (db, docName) => {
  const buf = await levelGet(db, createDocumentStateVectorKey(docName))
  if (buf == null) {
    return { sv: null, clock: -1 }
  }
  return decodeLeveldbStateVector(buf)
}

/**
 * Consolidates all current updates for a document into a single base update.
 * Clears the old individual updates to keep the database lean.
 *
 * @param {any} db
 * @param {string} docName
 * @param {Uint8Array} stateAsUpdate The merged update data
 * @param {Uint8Array} stateVector The current state vector
 * @return {Promise<number>} returns the clock of the flushed doc
 */
const flushDocument = async (db, docName, stateAsUpdate, stateVector) => {
  const clock = await storeUpdate(db, docName, stateAsUpdate)
  await writeStateVector(db, docName, stateVector, clock)
  await clearUpdatesRange(db, docName, 0, clock) 
  return clock
}

/**
 * Appends a new Yjs update to the document's update log in the database.
 *
 * @param {any} db
 * @param {string} docName
 * @param {Uint8Array} update
 * @return {Promise<number>} Returns the clock assigned to the stored update
 */
const storeUpdate = async (db, docName, update) => {
  const clock = await getCurrentUpdateClock(db, docName)
  if (clock === -1) {
    const ydoc = new Y.Doc()
    Y.applyUpdate(ydoc, update)
    const sv = Y.encodeStateVector(ydoc)
    await writeStateVector(db, docName, sv, 0)
  }
  await levelPut(db, createDocumentUpdateKey(docName, clock + 1), update)
  return clock + 1
}

/**
 * A persistence layer for Yjs using LevelDB.
 * Manages document updates, state vectors, and metadata with optimized memory usage.
 */
export class LeveldbPersistence {
  /**
   * @param {string} location The directory path for the database files.
   * @param {object} opts
   * @param {any} [opts.Level] Level-compatible adapter. Defaults to `level`.
   * @param {object} [opts.levelOptions] Options passed to the level instance for tuning.
   */
  constructor (location, /* istanbul ignore next */ { Level = DefaultLevel, levelOptions = {} } = {}) {
    // Merged memory guards to prevent "External" memory growth especially for large values.
    const finalOptions = {
      cacheSize: 128 * 1024 * 1024, // 128MB limit for internal block cache
      writeBufferSize: 16 * 1024 * 1024, // 16MB for more efficient value flushes
      maxOpenFiles: 1000,
      ...levelOptions,
      valueEncoding,
      keyEncoding
    }

    /**
     * @type {import('abstract-level').AbstractLevel<any>}
     */
    const db = new Level(location, finalOptions)
    this.tr = promise.resolve()

    /**
     * Internal transaction helper to ensure operations on the database are serialized.
     *
     * @template T
     * @param {function(any):Promise<T>} f A transaction that receives the db object
     * @return {Promise<T>}
     */
    this._transact = f => {
      const currTr = this.tr
      this.tr = (async () => {
        await currTr
        let res = /** @type {any} */ (null)
        try {
          res = await f(db)
        } catch (err) {
          /* istanbul ignore next */
          console.warn('Error during y-leveldb transaction', err)
        }
        return res
      })()
      return this.tr
    }
  }

  /**
   * Merges all individual updates for a document into a single, optimized base update.
   * @param {string} docName
   * @return {Promise<void>}
   */
  flushDocument (docName) {
    return this._transact(async db => {
      const updates = await getLevelUpdates(db, docName)
      const { update, sv } = mergeUpdates(updates)
      await flushDocument(db, docName, update, sv)
    })
  }

  /**
   * Retrieves a document from the database and returns it as a Y.Doc instance.
   * @param {string} docName
   * @return {Promise<Y.Doc>}
   */
  getYDoc (docName) {
    return this._transact(async db => {
      const updates = await getLevelUpdates(db, docName)
      const ydoc = new Y.Doc()
      ydoc.transact(() => {
        for (let i = 0; i < updates.length; i++) {
          Y.applyUpdate(ydoc, updates[i])
        }
      })
      if (updates.length > PREFERRED_TRIM_SIZE) {
        await flushDocument(db, docName, Y.encodeStateAsUpdate(ydoc), Y.encodeStateVector(ydoc))
      }
      return ydoc
    })
  }

  /**
   * Retrieves the current state vector of a document.
   * @param {string} docName
   * @return {Promise<Uint8Array>}
   */
  getStateVector (docName) {
    return this._transact(async db => {
      const { clock, sv } = await readStateVector(db, docName)
      let curClock = -1
      if (sv !== null) {
        curClock = await getCurrentUpdateClock(db, docName)
      }
      if (sv !== null && clock === curClock) {
        return sv
      } else {
        const updates = await getLevelUpdates(db, docName)
        const { update, sv } = mergeUpdates(updates)
        await flushDocument(db, docName, update, sv)
        return sv
      }
    })
  }

  /**
   * Stores a new update for the document.
   * @param {string} docName
   * @param {Uint8Array} update
   * @return {Promise<number>} Returns the clock of the stored update.
   */
  storeUpdate (docName, update) {
    return this._transact(db => storeUpdate(db, docName, update))
  }

  /**
   * Calculates the difference between the stored document and a provided state vector.
   * @param {string} docName
   * @param {Uint8Array} stateVector
   * @return {Promise<Uint8Array>} The binary update representing the difference.
   */
  async getDiff (docName, stateVector) {
    const ydoc = await this.getYDoc(docName)
    return Y.encodeStateAsUpdate(ydoc, stateVector)
  }

  /**
   * Completely removes all data and updates for a specific document from the store.
   * @param {string} docName
   * @return {Promise<void>}
   */
  clearDocument (docName) {
    return this._transact(async db => {
      await db.del(createDocumentStateVectorKey(docName))
      await clearRange(db, createDocumentFirstKey(docName), createDocumentLastKey(docName))
    })
  }

  /**
   * Stores a generic metadata entry for a document.
   * @param {string} docName
   * @param {string} metaKey
   * @param {any} value
   * @return {Promise<void>}
   */
  setMeta (docName, metaKey, value) {
    return this._transact(db => levelPut(db, createDocumentMetaKey(docName, metaKey), buffer.encodeAny(value)))
  }

  /**
   * Deletes a metadata entry from a document.
   * @param {string} docName
   * @param {string} metaKey
   * @return {Promise<void>}
   */
  delMeta (docName, metaKey) {
    return this._transact(db => db.del(createDocumentMetaKey(docName, metaKey)))
  }

  /**
   * Retrieves a metadata entry for a document.
   * @param {string} docName
   * @param {string} metaKey
   * @return {Promise<any>}
   */
  getMeta (docName, metaKey) {
    return this._transact(async db => {
      const res = await levelGet(db, createDocumentMetaKey(docName, metaKey))
      if (res == null) return
      return buffer.decodeAny(res)
    })
  }

  /**
   * Returns a list of all document names currently stored in the database.
   * @return {Promise<Array<string>>}
   */
  getAllDocNames () {
    return this._transact(async db => {
      const docKeys = await getAllDocsKeys(db)
      return docKeys.map(key => /** @type {string} */ (key[1]))
    })
  }

  /**
   * Returns state vectors and names for all documents in the store.
   * @return {Promise<Array<{ name: string, sv: Uint8Array, clock: number }>>}
   */
  getAllDocStateVectors () {
    return this._transact(async db => {
      const docs = await getAllDocs(db)
      return docs.map(doc => {
        const { sv, clock } = decodeLeveldbStateVector(doc.value)
        return { name: /** @type {string} */ (doc.key[1]), sv, clock }
      })
    })
  }

  /**
   * Retrieves all metadata entries for a document as a Map.
   * @param {string} docName
   * @return {Promise<Map<string, any>>}
   */
  getMetas (docName) {
    return this._transact(async db => {
      const data = await getLevelBulkEntries(db, {
        gte: createDocumentMetaKey(docName, ''),
        lt: createDocumentMetaEndKey(docName),
        keys: true,
        values: true
      })
      const metas = new Map()
      data.forEach(v => { metas.set(v.key[3], buffer.decodeAny(v.value)) })
      return metas
    })
  }

  /**
   * Closes the database connection and releases all associated resources.
   * @return {Promise<void>}
   */
  destroy () {
    return this._transact(db => db.close())
  }

  /**
   * Deletes all data within the entire database.
   * @return {Promise<void>}
   */
  clearAll () {
    return this._transact(async db => db.clear())
  }
}
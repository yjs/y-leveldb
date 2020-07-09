# LevelDB database adapter for [Yjs](https://github.com/yjs/yjs)

LevelDB is a fast embedded database. It is the underlying technology of IndexedDB.

Internally, y-leveldb uses [`level`](https://github.com/Level/level) which
allows to exchange the storage medium for a different supported database.
Hence this adapter also supports rocksdb, lmdb, and many more..

* Persistent storage for the server
* Exchangeable storage medium
* Can be used in [y-websocket](https://github.com/yjs/y-websocket)
* A single y-leveldb instance can handle many documents.

## Use it

```sh
npm install y-leveldb --save
```

```js
import { LeveldbPersistence } from 'y-leveldb'

const persistence = new LeveldbPersistence('./storage-location')

const ydoc = new Y.Doc()
ydoc.getArray('arr').insert(0, [1, 2, 3])
ydoc.getArray('arr').toArray() // => [1, 2, 3]

// store document updates retrieved from other clients
persistence.storeUpdate('my-doc', Y.encodeStateAsUpdate(ydoc))

// when you want to sync, or store data to a database,
// retrieve the temporary Y.Doc to consume data
persistence.getYDoc('my-doc').getArray('arr') // [1, 2, 3]
```

## API

### `persistence = LeveldbPersistence(storageLocation, [{ [level] }])`

Create a y-leveldb persistence instance.

You can use any levelup-compatible adapter.

```js
import { LeveldbPersistence } from 'y-leveldb'
import level from 'level-mem'

const persistence = new LeveldbPersistence('./storage-location', { level })
```

#### `persistence.getYDoc(docName: string): Promise<Y.Doc>`

Create a Y.Doc instance with the data persistet in leveldb. Use this to
temporarily create a Yjs document to sync changes or extract data.

#### `persistence.storeUpdate(docName: string, update: Uint8Array): Promise`

Store a single document update to the database.

#### `persistence.getStateVector(docName: string): Promise<Uint8Array>`

The state vector (describing the state of the persisted document - see
[Yjs docs](https://github.com/yjs/yjs#Document-Updates)) is maintained in a separate
field and constantly updated.

This allows you to sync changes without actually creating a Yjs document.

#### `persistence.getDiff(docName: string, stateVector: Uint8Array): Promise<Uint8Array>`

Get the differences directly from the database. The same as
`Y.encodeStateAsUpdate(ydoc, stateVector)`.

#### `persistence.clearDocument(docName: string): Promise`

Delete a document, and all associated data from the database.

#### `persistence.setMeta(docName: string, metaKey: string, value: any): Promise`

Persist some meta information in the database and associate it with a document.
It is up to you what you store here. You could, for example, store credentials
here.

#### `persistence.getMeta(docName: string, metaKey: string): Promise<any|undefined>`

Retrieve a store meta value from the database. Returns undefined if the
`metaKey` doesn't exist.

#### `persistence.delMeta(docName: string, metaKey: string): Promise`

Delete a store meta value.

#### `persistence.getAllDocNames(docName: string): Promise<Array<string>>`

Retrieve the names of all stored documents.

#### `persistence.getAllDocStateVectors(docName: string): Promise<Array<{ name:string,clock:number,sv:Uint8Array}`

Retrieve the state vectors of all stored documents. You can use this to sync
two y-leveldb instances.

Note: The state vectors might be outdated if the associated document is not
yet flushed. So use with caution.

#### `persistence.flushDocument(docName: string): Promise` (dev only)

Internally y-leveldb stores incremental updates. You can merge all document
updates to a single entry. You probably never have to use this.

## License

y-leveldb is licensed under the [MIT License](./LICENSE).

<kevin.jahns@protonmail.com>

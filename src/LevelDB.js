/* global Y */
'use strict'
var levelup = require('levelup')
var sublevel = require('level-sublevel')
var path = require('path')
var mkdirp = require('mkdirp')

var idTemplate = '0000000000' // Length of 10 (Remember |2^32| == 10)
var levelOptions = {
  valueEncoding: 'json',
  keyEncoding: {
    // id[1] will always have the length of 10 - making it sortable
    encode: function (val) {
      if (val.constructor !== Array) {
        return val
      } else if (val.length === 1 || typeof val[1] === 'string') {
        return JSON.stringify(val)
      } else if (val.length === 2 && typeof val[1] === 'number') {
        var num = Number(val[1]).toString()
        num = idTemplate.slice(num.length) + num
        return JSON.stringify([val[0], num])
      } else {
        throw new Error('The LevelDB connector does not support keys with a length greater than 2!')
      }
    },
    decode: function (val) {
      // this is never called (because I never request the key)
      var key = JSON.parse(val)
      if (key.length === 2) {
        var num = Number.parseInt(key[1], 10)
        if (!Number.isNaN(num)) {
          key[1] = num
        }
      }
      return key
    },
    buffer: false,
    type: 'IdEncoding'
  }
}
var leveldown = require('leveldown')

function extend (Y) {
  Y.requestModules(['memory']).then(function () {
    class Store {
      constructor (db) {
        this.db = db
      }
      * find (id) {
        return yield new Promise((resolve, reject) => {
          this.db.get(id, function (err, res) {
            if (err == null) {
              resolve(res)
            } else {
              resolve(null)
            }
          })
        })
      }
      * put (v) {
        return yield new Promise((resolve, reject) => {
          this.db.put(v.id, v, function (err, res) {
            if (err == null) {
              resolve()
            } else {
              console.log('err', err)
            }
          })
        })
      }
      * delete (id) {
        return yield new Promise((resolve, reject) => {
          this.db.del(id, resolve)
        })
      }
      * findWithLowerBound (start) {
        return yield new Promise((resolve, reject) => {
          this.db.createReadStream({
            gte: start,
            limit: 1,
            keys: false
          })
          .on('data', function (value) {
            resolve(value)
          })
          .on('err', function (err) {
            console.log('err', err)
          })
          .on('end', function () {
            resolve(null)
          })
        })
      }
      * findWithUpperBound (end) {
        return yield new Promise((resolve, reject) => {
          this.db.createReadStream({
            lte: end,
            reverse: true,
            limit: 1,
            keys: false
          })
          .on('data', function (value) {
            resolve(value)
          })
          .on('err', function (err) {
            console.log('err', err)
          })
          .on('end', function () {
            resolve(null)
          })
        })
      }
      * findNext (id) {
        return yield* this.findWithLowerBound([id[0], id[1] + 1])
      }
      * findPrev (id) {
        return yield* this.findWithUpperBound([id[0], id[1] - 1])
      }
      * iterate (t, start, end, gen) {
        var conf = {
          keys: false
        }
        if (start != null) {
          conf.gte = start
        }
        if (end != null) {
          conf.lte = end
        }
        var res = yield new Promise((resolve, reject) => {
          // TODO: you could handle this more elegantly..
          var res = []
          this.db.createReadStream(conf)
          .on('data', function (value) {
            res.push(value)
          })
          .on('err', function (e) {
            throw new Error(e)
          })
          .on('end', function () {
            resolve(res)
          })
        })

        for (var i = 0; i < res.length; i++) {
          yield* gen.call(t, res[i])
        }
      }
      * flush () {}
      * logTable () {
        console.log('-- Start logging db content --')
        yield* this.iterate(this, null, null, function * (o) {
          console.log(o.id, o)
        })
        console.log('-- End logging -- ')
      }
    }

    function createStoreClone (Store) {
      class Clone extends Store {
        constructor () {
          super(...arguments)
          this.buffer = []
          this._copyTo = null
        }
        // copy to this store
        // it may be neccessary to reset this every time you create a transaction
        copyTo (store) {
          this._copyTo = store
          return this
        }
        * put (v, dontCopy) {
          if (!dontCopy) {
            this.buffer.push(this._copyTo.put(v))
          }
          yield* super.put(v)
        }
        * delete (id) {
          this.buffer.push(this._copyTo.delete(id))
          yield* super.delete(id)
        }
        * flush () {
          yield* super.flush()
          for (var i = 0; i < this.buffer.length; i++) {
            yield* this.buffer[i]
          }
          yield* this._copyTo.flush()
        }
      }
      return Clone
    }
    Y.utils.createStoreClone = createStoreClone

    var BufferedStore = Store // TODO: replace to increase speed: Y.utils.createSmallLookupBuffer(Store)
    var ClonedStore = Y.utils.createStoreClone(Y.utils.RBTree)

    class Transaction extends Y.Transaction {
      constructor (store) {
        super(store)
        this.store = store
        this.ss = new BufferedStore(store.ss)
        this.os = new BufferedStore(store.os)
        this.ds = new BufferedStore(store.ds)
      }
    }
    class OperationStore extends Y.AbstractDatabase {
      constructor (y, options) {
        super(y, options)

        if (options == null) {
          options = {}
        }
        this.options = options
        if (options.namespace == null) {
          if (y.options.connector.room == null) {
            throw new Error('y-levelup: expect a string (options.namespace)! (you can also skip this step if your connector has a room property)')
          } else {
            options.namespace = y.options.connector.room
          }
        }
        options.dir = options.dir || '.'
        var dbpath = path.join(options.dir, options.namespace)
        this.ready = new Promise(function (resolve) {
          mkdirp(dbpath, function (err) {
            if (err) throw err
            else resolve()
          })
        }).then(function () {
          return new Promise(function (resolve) {
            if (options.cleanStart) {
              leveldown.destroy(dbpath, resolve)
            } else {
              resolve()
            }
          })
        })
        this.os = this.ds = this.ss = null
        this.ready.then(() => {
          this.db = sublevel(levelup(dbpath))
          this.os = this.db.sublevel('os', levelOptions)
          this.ds = this.db.sublevel('ds', levelOptions)
          this.ss = this.db.sublevel('ss', levelOptions)
        })
      }
      * operationAdded (transaction, op) {
        yield* super.operationAdded(transaction, op)
      }
      transact (makeGen) {
        var store = this
        this.ready.then(() => {
          var transaction = new Transaction(this)

          var gen = makeGen.call(transaction)
          handleTransactions(gen.next())

          function handleTransactions (result) {
            var request = result.value
            if (result.done) {
              makeGen = store.getNextRequest()
              if (makeGen != null) {
                if (transaction == null) {
                  throw new Error('Transaction ended unexpectedly.. (should only happen in indexeddb - from which this is forked from)')
                  // transaction = new Transaction(store)
                }
                gen = makeGen.call(transaction)
                handleTransactions(gen.next())
              } // else no transaction in progress!
              return
            }
            // console.log('new request', request.source != null ? request.source.name : null)
            if (request.constructor === Promise) {
              request
              .then(function (res) {
                handleTransactions(gen.next(res))
              })
              .catch(function (err) {
                gen.throw(err)
              })
            } else {
              gen.throw('You must not yield this type!')
            }
          }
        })
      }
      // TODO: implement "free"..
      * destroy () {
        this.db.close()
      }
    }
    Y.extend('leveldb', OperationStore)
  })
}

module.exports = extend
if (typeof Y !== 'undefined') {
  extend(Y)
}

# LevelDB database adapter for [Yjs](https://github.com/y-js/yjs)

Use the LevelDB database adapter to store your shared data persistently in NodeJs applications. The changes will persist after restart.

## Use it!
Install this with bower or npm.

##### Bower
```
bower install y-leveldb --save
```

##### NPM
```
npm install y-leveldb --save
```

### Example

```
Y({
  db: {
    name: 'leveldb',
    namespace: 'textarea-example' (optional - defaults to connector.room),
    dir: './db' // where the database is created,
    cleanStart: false // (if true, overwrite existing content - great for debugging)
  },
  connector: {
    name: 'websockets-client', // use the websockets connector
    room: 'textarea-example'
  },
  share: {
    textarea: 'Text' // y.share.textarea is of type Y.Text
  }
}).then(function (y) {
  // bind the textarea to a shared text element
  y.share.textarea.bind(document.getElementById('textfield'))
}
```

## License
Yjs is licensed under the [MIT License](./LICENSE).

<kevin.jahns@rwth-aachen.de>
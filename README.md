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
    name: 'websockets-client', // choose the websockets connector
    // name: 'webrtc'
    // name: 'xmpp'
    room: 'textarea-example'
  },
  sourceDir: '/bower_components', // location of the y-* modules
  share: {
    textarea: 'Text' // y.share.textarea is of type Y.Text
  }
  // types: ['Richtext', 'Array'] // optional list of types you want to import
}).then(function (y) {
  // bind the textarea to a shared text element
  y.share.textarea.bind(document.getElementById('textfield'))
}
```

## License
Yjs is licensed under the [MIT License](./LICENSE).

<kevin.jahns@rwth-aachen.de>
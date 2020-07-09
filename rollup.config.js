import resolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import nodePolyfills from 'rollup-plugin-node-polyfills'

export default [{
  input: './tests/index.js',
  output: {
    file: './dist/test.cjs',
    format: 'cjs',
    sourcemap: true,
    paths: path => {
      if (/^lib0\//.test(path)) {
        return `lib0/dist/${path.slice(5, -3)}.cjs`
      }
      return path
    }
  },
  external: id => /^(lib0|yjs)\//.test(id)
}, {
  input: './tests/index.js',
  output: {
    file: './dist/test.js',
    format: 'iife',
    sourcemap: true
  },
  plugins: [
    resolve({
      mainFields: ['module', 'browser', 'main'],
      preferBuiltins: false
    }),
    commonjs(),
    nodePolyfills()
  ]
}, {
  input: './src/y-leveldb.js',
  output: {
    name: 'Y',
    file: 'dist/y-leveldb.cjs',
    format: 'cjs',
    sourcemap: true,
    paths: path => {
      if (/^lib0\//.test(path)) {
        return `lib0/dist/${path.slice(5, -3)}.cjs`
      }
      return path
    }
  },
  external: id => /^(lib0|yjs)\//.test(id)
}]

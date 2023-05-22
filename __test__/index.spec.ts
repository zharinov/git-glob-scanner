import test from 'ava'

import * as glob from '..'

test('sync function from native code', (t) => {
  t.is(glob.globToRegex('**/*.ts'), '(?-u)^(?:/?|.*/).*\\.ts$')
})

test('matching glob pattern', (t) => {
  t.deepEqual(glob.walkRepoGlob('.', 'package.json'), ['package.json'])
  t.deepEqual(glob.walkRepoGlobs('.', ['package.json']), ['package.json'])
  t.deepEqual(glob.walkRepoGlobsMap('.', { package: ['package.json'] }), { package: ['package.json'] })
})

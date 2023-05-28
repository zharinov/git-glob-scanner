import { readFileSync } from 'fs-extra'
import * as upath from 'upath'

function getTemplate(name: string): string {
  const path = upath.join(__dirname, 'tpl', name)
  return readFileSync(path, 'utf8')
}

const nativeReadmeTpl = getTemplate('README.native.md')
console.log(getTemplate('README.native.md'))

import { readFileSync } from 'fs-extra'
import * as nunjucks from 'nunjucks'
import * as upath from 'upath'

const packageName = '@jrnv/git-glob-scanner' as const

const nodeArchitectures = ['ia32', 'x64', 'arm64'] as const
const nodePlatforms = ['linux', 'win32', 'darwin'] as const

interface PackageContext {
  packageName: string
  nativePackageName: string
  rustTarget: string
  nodePlatform: string
  nodeArch: string
}

const nativePackages = nodePlatforms.flatMap((nodePlatform) =>
  nodeArchitectures.map((nodeArch): PackageContext => {
    const nativePackageOs = {
      linux: 'linux',
      win32: 'windows',
      darwin: 'macos',
    }[nodePlatform]
    const nativePackageArch = {
      ia32: 'x86',
      x64: 'x64',
      arm64: 'arm64',
    }[nodeArch]
    const nativePackageName = `${packageName}-${nativePackageOs}-${nativePackageArch}`

    const rustTargetArch = {
      ia32: 'i686',
      x64: 'x86_64',
      arm64: 'aarch64',
    }[nodeArch]
    const rustTargetPlatform = {
      linux: 'unknown-linux-gnu',
      win32: 'windows-msvc',
      darwin: 'apple-darwin',
    }[nodePlatform]
    const rustTarget = `${rustTargetArch}-${rustTargetPlatform}`

    return {
      packageName,
      nativePackageName,
      rustTarget,
      nodePlatform,
      nodeArch,
    }
  }),
)

function precompileTemplate(file: string): nunjucks.Template {
  const name = upath.basename(file)
  const path = upath.join(__dirname, 'tpl', name)
  const content = readFileSync(path, 'utf8')
  return nunjucks.compile(content)
}

const templates: Record<string, nunjucks.Template> = {}

function render(tplName: string, context: PackageContext): string {
  templates[tplName] ??= precompileTemplate(tplName)
  const tpl = templates[tplName]
  return tpl.render(context)
}

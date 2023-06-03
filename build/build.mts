import os from 'os';
import fs from 'fs-extra';
import nunjucks from 'nunjucks';
import upath from 'upath';
import pAll from 'p-all';
import { fileURLToPath } from 'url';

const __dirname = upath.dirname(fileURLToPath(import.meta.url));
const distDir = upath.join(__dirname, '..', 'dist');

const packageOrg: string | undefined = '@jrnv' as const;
const packageName = 'git-glob-scanner' as const;

type NodePlatform = 'linux' | 'win32' | 'darwin';
const nodePlatforms = ['linux', 'win32', 'darwin'] as const;

type NodeArch = 'ia32' | 'x64' | 'arm64';
const nodeArchitectures = ['ia32', 'x64', 'arm64'] as const;

interface PackageContext {
  rootPackageName: string;
  nativePackageName: string;
  nativePackageSuffix: string;
  nativePackageDir: string;
  readmePath: string;
  rustTarget: string;
  nodePlatform: NodePlatform;
  nodeArch: NodeArch;
}

function getPackages(): PackageContext[] {
  return nodePlatforms.flatMap((nodePlatform) =>
    nodeArchitectures.map((nodeArch): PackageContext => {
      const rootPackageName = packageOrg ? `${packageOrg}/${packageName}` : packageName;

      const nativePackageOs = {
        linux: 'linux',
        win32: 'windows',
        darwin: 'macos',
      }[nodePlatform];

      const nativePackageArch = {
        ia32: 'x86',
        x64: 'x64',
        arm64: 'arm64',
      }[nodeArch];

      const nativePackageSuffix = `${nativePackageOs}-${nativePackageArch}`;
      const nativePackageName = packageOrg
        ? `${packageOrg}/${packageName}-${nativePackageSuffix}`
        : `${packageName}-${nativePackageSuffix}`;
      const nativePackageDir = upath.join(distDir, nativePackageSuffix);
      const readmePath = upath.join(nativePackageDir, 'README.md');

      const rustTargetArch = {
        ia32: 'i686',
        x64: 'x86_64',
        arm64: 'aarch64',
      }[nodeArch];

      const rustTargetPlatform = {
        linux: 'unknown-linux-gnu',
        win32: 'windows-msvc',
        darwin: 'apple-darwin',
      }[nodePlatform];

      const rustTarget = `${rustTargetArch}-${rustTargetPlatform}`;

      return {
        rootPackageName,
        nativePackageName,
        nativePackageSuffix,
        nativePackageDir,
        readmePath,
        rustTarget,
        nodePlatform,
        nodeArch,
      };
    }),
  );
}

async function precompileTemplate(file: string): Promise<nunjucks.Template> {
  const name = upath.basename(file);
  const path = upath.join(__dirname, 'tpl', name);
  const content = await fs.readFile(path, 'utf8');
  return nunjucks.compile(content);
}

const templates: Record<string, nunjucks.Template> = {};

async function render(tplName: string, context: PackageContext): Promise<string> {
  const tpl = templates[tplName] ?? (await precompileTemplate(tplName));
  templates[tplName] = tpl;
  return tpl.render(context);
}

async function task(context: PackageContext) {
  const readme = await render('README.native.md', context);
  await fs.writeFile(context.readmePath, readme);
}

async function main() {
  const concurrency = os.cpus().length;
  const nativePackages = getPackages();
  const tasks = nativePackages.map((context) => () => task(context));
  await pAll(tasks, { concurrency });
}

await main();

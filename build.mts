import { ChildProcess, spawn } from 'child_process';
import os from 'os';
import fs from 'fs-extra';
import nunjucks from 'nunjucks';
import upath from 'upath';
import pAll from 'p-all';
import { fileURLToPath } from 'url';

const __dirname = upath.dirname(fileURLToPath(import.meta.url));
const distDir = upath.join(__dirname, 'dist');

const packageOrg: string | undefined = '@jrnv' as const;
const packageName = 'git-glob-scanner' as const;

type NodePlatform = 'linux' | 'win32' | 'darwin';
const nodePlatforms = ['win32'] as const;
// const nodePlatforms = ['linux', 'win32', 'darwin'] as const;

type NodeArch = 'ia32' | 'x64' | 'arm64';
const nodeArchitectures = ['arm64' /*, 'x64', 'ia32' */] as const;
// const nodeArchitectures = ['arm64', 'x64', 'ia32'] as const;

interface RootPackageJson {
  name: string;
  version: string;
  description: string;
  repository: string;
  license: string;
}

interface PackageContext {
  rootPackageName: string;
  nativePackageName: string;
  nativePackageSuffix: string;
  nativePackageDir: string;
  rustTargetTriple: string;
  rustTargetDir: string;
  nodePlatform: NodePlatform;
  nodeArch: NodeArch;
  rootPackageJson: RootPackageJson;
}

function getPackages(rootPackageJson: RootPackageJson): PackageContext[] {
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

      const rustTargetArch = {
        ia32: 'i686',
        x64: 'x86_64',
        arm64: 'aarch64',
      }[nodeArch];

      const rustTargetPlatform = {
        linux: 'unknown-linux-gnu',
        win32: 'pc-windows-msvc',
        darwin: 'apple-darwin',
      }[nodePlatform];

      const rustTargetTriple = `${rustTargetArch}-${rustTargetPlatform}`;

      const rustTargetDir = upath.join(__dirname, 'target', nativePackageSuffix, 'release');

      return {
        rootPackageName,
        nativePackageName,
        nativePackageSuffix,
        nativePackageDir,
        rustTargetTriple,
        rustTargetDir,
        nodePlatform,
        nodeArch,
        rootPackageJson,
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

const pending = new Set<ChildProcess>();

process.on('SIGINT', () => {
  for (const child of pending) {
    child.kill('SIGINT');
  }
});

function stripReadyLines(data: Buffer, lineCallback: (line: string) => void, prev = ''): string {
  const asStr = prev + data.toString();
  const lines = asStr.split('\n');

  if (lines.length < 2) {
    return asStr;
  }

  const lastLine = lines.pop()!;
  for (const line of lines) {
    lineCallback(line);
  }
  return lastLine;
}

async function exec(command: string, args: string[], outputPrefix: string = ''): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: true,
      stdio: ['inherit', null, null],
    });
    pending.add(child);

    child.on('error', () => {
      pending.delete(child);
      reject();
    });

    let stdoutRest = '';
    child.stdout?.on('data', (data) => {
      stdoutRest = stripReadyLines(
        data,
        (line) => {
          console.log(`${outputPrefix}${line}`);
        },
        stdoutRest,
      );
    });

    let stderrRest = '';
    child.stderr?.on('data', (data) => {
      stderrRest = stripReadyLines(
        data,
        (line) => {
          console.error(`${outputPrefix}${line}`);
        },
        stderrRest,
      );
    });

    child.on('close', (code) => {
      pending.delete(child);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with code ${code}`));
      }
    });
  });
}

async function task(context: PackageContext, stdoutPrefix: string) {
  const { nativePackageDir } = context;

  await fs.ensureDir(nativePackageDir);

  const readme = await render('README.native.md', context);
  const readmePath = upath.join(nativePackageDir, 'README.md');
  await fs.writeFile(readmePath, readme);

  const packageJson = await render('package.native.json', context);
  const packageJsonPath = upath.join(nativePackageDir, 'package.json');
  await fs.writeFile(packageJsonPath, packageJson);

  await exec('rustup', ['target', 'add', context.rustTargetTriple], stdoutPrefix);

  await exec(
    'yarn',
    [
      '--silent',
      'napi',
      'build',
      '--target',
      context.rustTargetTriple,
      '--target-dir',
      context.rustTargetDir,
      '--output-dir',
      nativePackageDir,
      '--strip',
      '--release',
      '--cross-compile',
    ],
    stdoutPrefix,
  );
}

async function main() {
  const rootPackageJson: RootPackageJson = await fs.readJson(upath.join(__dirname, 'package.json'));
  const nativePackages = getPackages(rootPackageJson);
  const stdoutPrefixLength = 1 + Math.max(...nativePackages.map((context) => context.nativePackageSuffix.length));
  const tasks = nativePackages.map((context) => {
    const stdoutPrefix = `${context.nativePackageSuffix.padEnd(stdoutPrefixLength)}| `;
    return () => task(context, stdoutPrefix);
  });

  const concurrency = os.cpus().length + 1;
  await pAll(tasks, { concurrency });
}

await main();

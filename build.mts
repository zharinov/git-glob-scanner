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

type NodePlatform = 'win32' | 'darwin' | 'linux';
const nodePlatforms = ['win32', 'darwin', 'linux'] as const;

type NodeArch = 'arm64' | 'x64' | 'ia32';
const nodeArchitectures = ['arm64', 'x64'] as const;

interface RootPackageJson {
  name: string;
  version: string;
  description: string;
  repository: string;
  license: string;
}

interface NativePackageContext {
  rootPackageName: string;
  nativePackageName: string;
  nativePackageSuffix: string;
  nativePackageDir: string;
  rustTargetTriple: string;
  rustTargetDir: string;
  nodePlatform: NodePlatform;
  nodeArch: NodeArch;
  rootPackageJson: RootPackageJson;
  outputLinePrefix: string;
}

let cachedNativePackages: NativePackageContext[] | undefined;

async function getNativePackages(): Promise<NativePackageContext[]> {
  if (cachedNativePackages) {
    return cachedNativePackages;
  }

  const rootPackageJson: RootPackageJson = await fs.readJson(upath.join(__dirname, 'package.json'));

  const packageContexts: Omit<NativePackageContext, 'outputLinePrefix'>[] = [];
  let maxSuffixLength = 0;
  for (const nodePlatform of nodePlatforms) {
    for (const nodeArch of nodeArchitectures) {
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

      packageContexts.push({
        rootPackageName,
        nativePackageName,
        nativePackageSuffix,
        nativePackageDir,
        rustTargetTriple,
        rustTargetDir,
        nodePlatform,
        nodeArch,
        rootPackageJson,
      });

      maxSuffixLength = Math.max(maxSuffixLength, nativePackageSuffix.length);
    }
  }

  return packageContexts.map((context) => ({
    ...context,
    outputLinePrefix: `${context.nativePackageSuffix.padEnd(maxSuffixLength)} | `,
    rootPackageJson,
  }));
}

async function precompileTemplate(file: string): Promise<nunjucks.Template> {
  const name = upath.basename(file);
  const path = upath.join(__dirname, 'tpl', name);
  const content = await fs.readFile(path, 'utf8');
  return nunjucks.compile(content);
}

const templates: Record<string, nunjucks.Template> = {};

async function render(tplName: string, context: NativePackageContext): Promise<string> {
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

async function installRustTargets(): Promise<void> {
  const packages = await getNativePackages();
  const tasks = packages.map(
    (pkg) => () => exec('rustup', ['target', 'add', pkg.rustTargetTriple], pkg.outputLinePrefix),
  );
  await pAll(tasks);
}

async function createDistFolders() {
  const packages = await getNativePackages();

  const tasks = packages.map((pkg) => async () => {
    const { nativePackageDir } = pkg;

    await fs.ensureDir(nativePackageDir);

    const readme = await render('README.native.md', pkg);
    const readmePath = upath.join(nativePackageDir, 'README.md');
    await fs.writeFile(readmePath, readme);

    const packageJson = await render('package.native.json', pkg);
    const packageJsonPath = upath.join(nativePackageDir, 'package.json');
    await fs.writeFile(packageJsonPath, packageJson);
  });

  await pAll(tasks);
}

async function buildNodeBinaries() {
  const packages = await getNativePackages();
  const windowsPackages = packages.filter((pkg) => pkg.nodePlatform === 'win32');
  const nonWindowsPackages = packages.filter((pkg) => pkg.nodePlatform !== 'win32');

  const createTask = (pkg: NativePackageContext) => async () => {
    await exec(
      'yarn',
      [
        '--silent',
        'napi',
        'build',
        '--target',
        pkg.rustTargetTriple,
        '--target-dir',
        pkg.rustTargetDir,
        '--output-dir',
        pkg.nativePackageDir,
        '--strip',
        '--release',
        '--cross-compile',
      ],
      pkg.outputLinePrefix,
    );
  };

  const windowsTasks = windowsPackages.map(createTask);
  const nonWindowsTasks = nonWindowsPackages.map(createTask);

  await pAll(windowsTasks, { concurrency: 1 });
  await pAll(nonWindowsTasks, { concurrency: os.cpus().length });
}

async function main() {
  const [command] = process.argv.slice(2);

  if (command === 'install-rust-targets') {
    await installRustTargets();
  } else if (command === 'create-dist-folders') {
    await createDistFolders();
  } else if (command === 'build-node-binaries') {
    await buildNodeBinaries();
  } else {
    await installRustTargets();
    await createDistFolders();
    await buildNodeBinaries();
  }
}

await main();

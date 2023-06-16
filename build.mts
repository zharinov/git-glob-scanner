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
const nodeArchitectures = ['arm64', 'x64', 'ia32'] as const;

type PackageOs = 'windows' | 'macos' | 'linux';
type PackageArch = 'arm64' | 'x64' | 'x86';

type RustArch = 'i686' | 'x86_64' | 'aarch64';
type RustOs = 'unknown-linux-gnu' | 'pc-windows-msvc' | 'apple-darwin';

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
  packageVersion: string;
  packageDescription: string;
  packageRepository: string;
  packageLicense: string;
  stdoutPrefix?: string;
}

async function getRootPackageJson(): Promise<RootPackageJson> {
  const res: unknown = await fs.readJson(upath.join(__dirname, 'package.json'));
  if (typeof res !== 'object' || res === null) {
    throw new Error('Invalid package.json');
  }
  const { name, version, description, repository, license } = res as Record<string, unknown>;

  const err = (field: string): Error => new Error(`Invalid package.json field: ${field}`);

  if (typeof name !== 'string') {
    throw err('name');
  } else if (typeof version !== 'string') {
    throw err('version');
  } else if (typeof description !== 'string') {
    throw err('description');
  } else if (typeof repository !== 'string') {
    throw err('repository');
  } else if (typeof license !== 'string') {
    throw err('license');
  }

  return { name, version, description, repository, license };
}

/**
 * When using OS and architecture names, there is three different naming conventions:
 * - "node": names used in node
 * - "rust": names used in rust
 * - "package": names used in this package and GitHub actions (meant to be human-readable)
 *
 * Following functions convert between these naming conventions.
 */
function nodePlatformToPackageOs(nodePlatform: string): PackageOs {
  const key = nodePlatform.toLowerCase();
  const mapping: Record<string, PackageOs> = {
    win32: 'windows',
    darwin: 'macos',
    linux: 'linux',
  };

  const packageOs = mapping[key];
  if (!packageOs) {
    throw new Error(`Unknown node platform: ${nodePlatform}`);
  }
  return packageOs;
}

function packageOsToNodePlatform(packageOs: string): NodePlatform {
  const key = packageOs.toLowerCase();
  const mapping: Record<string, NodePlatform> = {
    windows: 'win32',
    macos: 'darwin',
    linux: 'linux',
  };

  const nodePlatform = mapping[key];
  if (!nodePlatform) {
    throw new Error(`Unknown package os: ${packageOs}`);
  }
  return nodePlatform;
}

function nodeArchToPackageArch(nodeArch: string): PackageArch {
  const key = nodeArch.toLowerCase();
  const mapping: Record<string, PackageArch> = {
    ia32: 'x86',
    x64: 'x64',
    arm64: 'arm64',
  };

  const packageArch = mapping[key];
  if (!packageArch) {
    throw new Error(`Unknown node arch: ${nodeArch}`);
  }
  return packageArch;
}

function packageArchToRustArch(packageArch: string): RustArch {
  const key = packageArch.toLowerCase();
  const mapping: Record<string, RustArch> = {
    x86: 'i686',
    x64: 'x86_64',
    arm64: 'aarch64',
  };

  const rustArch = mapping[key];
  if (!rustArch) {
    throw new Error(`Unknown package arch: ${packageArch}`);
  }
  return rustArch;
}

function packageOsToRustOs(packageOs: string): RustOs {
  const key = packageOs.toLowerCase();
  const mapping: Record<string, RustOs> = {
    windows: 'pc-windows-msvc',
    macos: 'apple-darwin',
    linux: 'unknown-linux-gnu',
  };

  const rustOs = mapping[key];
  if (!rustOs) {
    throw new Error(`Unknown package os: ${packageOs}`);
  }
  return rustOs;
}

let cachedNativePackages: NativePackageContext[] | undefined;

async function getNativePackages(): Promise<NativePackageContext[]> {
  if (cachedNativePackages) {
    return cachedNativePackages;
  }

  const {
    version: packageVersion,
    description: packageDescription,
    repository: packageRepository,
    license: packageLicense,
  } = await getRootPackageJson();

  const packageContexts: NativePackageContext[] = [];
  let maxSuffixLength = 0;
  for (const nodePlatform of nodePlatforms) {
    for (const nodeArch of nodeArchitectures) {
      const rootPackageName = packageOrg ? `${packageOrg}/${packageName}` : packageName;

      const nativePackageArch = nodeArchToPackageArch(nodeArch);
      const nativePackageOs = nodePlatformToPackageOs(nodePlatform);

      const nativePackageSuffix = `${nativePackageOs}-${nativePackageArch}`;
      const nativePackageName = packageOrg
        ? `${packageOrg}/${packageName}-${nativePackageSuffix}`
        : `${packageName}-${nativePackageSuffix}`;
      const nativePackageDir = upath.join(distDir, nativePackageSuffix);

      const rustTargetArch = packageArchToRustArch(nativePackageArch);
      const rustTargetPlatform = packageOsToRustOs(nativePackageOs);

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
        packageVersion,
        packageDescription,
        packageRepository,
        packageLicense,
      });

      maxSuffixLength = Math.max(maxSuffixLength, nativePackageSuffix.length);
    }
  }

  return packageContexts.map((context) => ({
    ...context,
    stdoutPrefix: `${context.nativePackageSuffix.padEnd(maxSuffixLength)} | `,
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

async function exec(command: string, args: string[], stdoutPrefix: string = ''): Promise<void> {
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
          console.log(`${stdoutPrefix}${line}`);
        },
        stdoutRest,
      );
    });

    let stderrRest = '';
    child.stderr?.on('data', (data) => {
      stderrRest = stripReadyLines(
        data,
        (line) => {
          console.error(`${stdoutPrefix}${line}`);
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

async function getPkg(target?: string): Promise<NativePackageContext> {
  if (!target) {
    throw new Error('No target specified');
  }

  const packages = await getNativePackages();
  const suffix = target.toLowerCase();

  const pkg = packages.find((pkg) => pkg.nativePackageSuffix === suffix);
  if (!pkg) {
    const availableTargets = packages.map((pkg) => pkg.nativePackageSuffix).join(', ');
    throw new Error(`Unknown target ${suffix} (available targets: ${availableTargets})`);
  }

  return pkg;
}

async function installRustTarget(target?: string): Promise<void> {
  const pkg = await getPkg(target);
  await exec('rustup', ['target', 'add', pkg.rustTargetTriple]);
}

async function installRustTargets(): Promise<void> {
  const packages = await getNativePackages();
  const tasks = packages.map((pkg) => () => exec('rustup', ['target', 'add', pkg.rustTargetTriple], pkg.stdoutPrefix));
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

async function createDistFolder(target?: string): Promise<void> {
  const pkg = await getPkg(target);

  const { nativePackageDir } = pkg;

  await fs.ensureDir(nativePackageDir);

  const readme = await render('README.native.md', pkg);
  const readmePath = upath.join(nativePackageDir, 'README.md');
  await fs.writeFile(readmePath, readme);

  const packageJson = await render('package.native.json', pkg);
  const packageJsonPath = upath.join(nativePackageDir, 'package.json');
  await fs.writeFile(packageJsonPath, packageJson);
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
      pkg.stdoutPrefix,
    );
  };

  const windowsTasks = windowsPackages.map(createTask);
  const nonWindowsTasks = nonWindowsPackages.map(createTask);

  await pAll(windowsTasks, { concurrency: 1 });
  await pAll(nonWindowsTasks, { concurrency: os.cpus().length });
}

async function buildNodeBinary(target?: string) {
  const pkg = await getPkg(target);
  await exec('yarn', [
    '--silent',
    'napi',
    'build',
    '--target',
    pkg.rustTargetTriple,
    '--output-dir',
    pkg.nativePackageDir,
    '--strip',
    '--release',
    '--cross-compile',
  ]);
}

async function main() {
  const [command, target] = process.argv.slice(2);

  if (command === 'install-rust-targets') {
    await installRustTargets();
  } else if (command === 'install-rust-target') {
    await installRustTarget(target);
  } else if (command === 'create-dist-folders') {
    await createDistFolders();
  } else if (command === 'create-dist-folder') {
    await createDistFolder(target);
  } else if (command === 'build-node-binaries') {
    await buildNodeBinaries();
  } else if (command === 'build-node-binary') {
    await buildNodeBinary(target);
  } else {
    await installRustTargets();
    await createDistFolders();
    await buildNodeBinaries();
  }
}

await main();

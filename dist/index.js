const { existsSync } = require('fs');
const { join } = require('path');

const { platform, arch } = process;

const packageName = '@jrnv/git-glob-scanner';

function req(mod) {
  const localPath = join(__dirname, `${mod}/index.node`);
  return existsSync(localPath) ? require(localPath) : require(`${packageName}-${mod}`);
}

function load() {
  const os = {
    win32: 'windows',
    darwin: 'macos',
    linux: 'linux',
  }[platform];

  const architecture = {
    x64: 'x64',
    arm64: 'arm64',
    ia32: 'x86',
  }[arch];

  if (!os || !architecture) {
    throw new Error(`Unsupported OS: ${os}, architecture: ${architecture}`);
  }

  return req(`${os}-${architecture}`);
}

module.exports = load('index');

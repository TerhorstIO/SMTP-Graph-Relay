const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const bundle = path.join(dist, 'bundle.js');
const blob = path.join(dist, 'sea-prep.blob');
const configPath = path.join(dist, 'sea-config.json');
const exe = path.join(root, 'SMTP-Relay.exe');
const sentinel = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function run(args) {
    const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) {
        process.exit(result.status || 1);
    }
}

run([path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')]);

require('esbuild').buildSync({
    entryPoints: [path.join(dist, 'index.js')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: bundle,
    legalComments: 'none',
    logLevel: 'info',
});

fs.writeFileSync(configPath, JSON.stringify({
    main: 'dist/bundle.js',
    output: 'dist/sea-prep.blob',
    disableExperimentalSEAWarning: true,
}, null, 2));

const legacySea = /^v(20|22)\./.test(process.version);
run(legacySea ? ['--experimental-sea-config', configPath] : [`--build-sea=${configPath}`]);

if (isPortableExecutable(blob)) {
    fs.copyFileSync(blob, exe);
} else {
    fs.copyFileSync(process.execPath, exe);
    removeAuthenticode(exe);
    run([
        path.join(root, 'node_modules', 'postject', 'dist', 'cli.js'),
        exe,
        'NODE_SEA_BLOB',
        blob,
        '--sentinel-fuse',
        sentinel,
        '--overwrite',
    ]);
}

console.log(`Fertig: ${exe}`);

function isPortableExecutable(file) {
    const header = Buffer.alloc(2);
    const fd = fs.openSync(file, 'r');
    try {
        fs.readSync(fd, header, 0, 2, 0);
    } finally {
        fs.closeSync(fd);
    }
    return header.toString('ascii') === 'MZ';
}

function removeAuthenticode(file) {
    const buf = fs.readFileSync(file);
    if (buf.length < 0x40 || buf.toString('ascii', 0, 2) !== 'MZ') {
        return;
    }
    const peOffset = buf.readUInt32LE(0x3c);
    if (peOffset <= 0 || peOffset + 24 >= buf.length || buf.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
        return;
    }
    const magic = buf.readUInt16LE(peOffset + 24);
    const isPE32Plus = magic === 0x20b;
    const dataDirectoryOffset = peOffset + 24 + (isPE32Plus ? 112 : 96);
    const certEntry = dataDirectoryOffset + (8 * 4);
    if (certEntry + 8 > buf.length) {
        return;
    }
    const certOffset = buf.readUInt32LE(certEntry);
    const certSize = buf.readUInt32LE(certEntry + 4);
    if (!certOffset || !certSize || certOffset >= buf.length) {
        return;
    }
    buf.writeUInt32LE(0, certEntry);
    buf.writeUInt32LE(0, certEntry + 4);
    buf.writeUInt32LE(0, peOffset + 24 + 64);
    fs.writeFileSync(file, buf.subarray(0, certOffset));
}
